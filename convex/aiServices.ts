"use node";

import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { fal } from "@fal-ai/client";
import { api, internal } from "./_generated/api";
import { prompts } from "./prompts";
import type { Id } from "./_generated/dataModel";
import { requireAuth } from "./auth";

// ─── Helper: Format time for SRT ────────────────────────────────────────────
function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

// ─── Helper: Convert MiniMax subtitle JSON to SRT ───────────────────────────
function convertMiniMaxSubtitleToSRT(subtitleJson: any, totalDurationMs?: number): string {
  let srt = "";
  const subtitles = Array.isArray(subtitleJson) ? subtitleJson : (subtitleJson?.subtitles || []);

  // Check if timestamps are all zero (MiniMax sometimes returns 0:00 timestamps)
  // MiniMax uses time_begin/time_end (milliseconds), not start_ms/end_ms
  const allZero = subtitles.every((item: any) =>
    (item.time_begin ?? item.start_ms ?? item.start ?? 0) === 0 &&
    (item.time_end ?? item.end_ms ?? item.end ?? 0) === 0
  );

  if (allZero && subtitles.length > 0 && totalDurationMs && totalDurationMs > 0) {
    // Fallback: distribute subtitles proportionally by text length
    const totalChars = subtitles.reduce((sum: number, item: any) => sum + (item.text || "").length, 0);
    let elapsedMs = 0;
    for (let i = 0; i < subtitles.length; i++) {
      const item = subtitles[i];
      const text = item.text || "";
      const charRatio = text.length / (totalChars || 1);
      const segDuration = Math.round(totalDurationMs * charRatio);
      const startMs = Math.round(elapsedMs);
      const endMs = Math.round(elapsedMs + segDuration);
      srt += `${i + 1}\n`;
      srt += `${formatTime(startMs / 1000)} --> ${formatTime(endMs / 1000)}\n`;
      srt += `${text}\n\n`;
      elapsedMs += segDuration;
    }
    return srt;
  }

  // Normal path: use actual timestamps from MiniMax
  for (let i = 0; i < subtitles.length; i++) {
    const item = subtitles[i];
    const text = item.text || "";
    // MiniMax uses time_begin/time_end (milliseconds), not start_ms/end_ms
    const startMs = item.time_begin ?? item.start_ms ?? item.start ?? 0;
    const endMs = item.time_end ?? item.end_ms ?? item.end ?? 0;
    srt += `${i + 1}\n`;
    srt += `${formatTime(startMs / 1000)} --> ${formatTime(endMs / 1000)}\n`;
    srt += `${text}\n\n`;
  }
  return srt;
}

// ─── Helper: Check if URL is a video ────────────────────────────────────────
function isVideoUrl(url: string): boolean {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v'];
  const urlLower = url.toLowerCase();
  return videoExtensions.some(ext => urlLower.includes(ext));
}

// ─── Helper: Validate image size for API ────────────────────────────────────
async function validateImageForAPI(imageUrl: string): Promise<string | null> {
  const MAX_SIZE = 20 * 1024 * 1024; // 20MB
  try {
    const headResponse = await fetch(imageUrl, { method: 'HEAD' });
    const contentLength = headResponse.headers.get('content-length');
    if (contentLength) {
      const sizeInBytes = parseInt(contentLength);
      if (sizeInBytes <= MAX_SIZE) {
        console.log(`[validate] image ok: ${(sizeInBytes / 1024 / 1024).toFixed(2)} MB`);
        return imageUrl;
      } else {
        console.warn(`[validate] image too large: ${(sizeInBytes / 1024 / 1024).toFixed(2)} MB`);
        return null;
      }
    }
    return imageUrl;
  } catch (error) {
    console.error("[validate] error:", error);
    return imageUrl;
  }
}

// ─── Helper: Extract frames from video at 25%, 50%, 75% ─────────────────────
async function extractVideoFrames(videoUrl: string, ctx: any): Promise<string[]> {
  console.log("[extractFrames] extracting frames from video...");
  try {
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) throw new Error(`Failed to fetch video: ${videoResponse.statusText}`);
    const videoBlob = await videoResponse.blob();
    console.log(`[extractFrames] video size: ${(videoBlob.size / 1024 / 1024).toFixed(2)} MB`);

    const frames: string[] = [];
    const timestamps = ['25%', '50%', '75%'];

    for (let i = 0; i < timestamps.length; i++) {
      try {
        const formData = new FormData();
        formData.append("file", videoBlob, "video.mp4");
        formData.append("timestamp", timestamps[i]);
        formData.append("action", "extract-frame");

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch("https://reels-srt.vercel.app/api/extract-frame", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const frameBlob = await response.blob();
          const uploadUrl = await ctx.runMutation(api.tasks.generateUploadUrl, {});
          const uploadResponse = await fetch(uploadUrl, {
            method: "POST",
            headers: { "Content-Type": "image/jpeg" },
            body: frameBlob,
          });
          const { storageId } = await uploadResponse.json();
          const frameUrl = await ctx.storage.getUrl(storageId);
          if (frameUrl) {
            frames.push(frameUrl);
            console.log(`[extractFrames] frame ${i + 1} stored`);
          }
        }
      } catch (frameError: any) {
        if (frameError.name === 'AbortError') {
          console.warn(`[extractFrames] frame ${i + 1} timed out`);
        } else {
          console.error(`[extractFrames] frame ${i + 1} error:`, frameError);
        }
      }
    }
    console.log(`[extractFrames] extracted ${frames.length}/3 frames`);
    return frames;
  } catch (error) {
    console.error("[extractFrames] error:", error);
    return [];
  }
}

// ─── Helper: Download image and convert to base64 data URL ──────────────────
async function downloadImageAsDataUrl(imageUrl: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const isJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isGIF = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
    const isWEBP = buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;

    if (!isJPEG && !isPNG && !isGIF && !isWEBP) return null;

    let mimeType = 'image/jpeg';
    if (isPNG) mimeType = 'image/png';
    else if (isGIF) mimeType = 'image/gif';
    else if (isWEBP) mimeType = 'image/webp';

    const base64 = buffer.toString('base64');
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error("[downloadImage] error:", error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ANIMATE IMAGE (from sorah — FAL AI Kling image-to-video)
// internalAction: billed per call (~$0.4/request). Only the server-side
// generateMediaAssets pipeline may invoke it; it must NOT be callable from
// the client (previously a public action with NO auth — anyone with the
// deployment URL could burn the FAL balance in a loop).
// ═══════════════════════════════════════════════════════════════════════════
export const animateImage = internalAction({
  args: {
    imageUrl: v.string(),
    prompt: v.optional(v.string()),
  },
  handler: async (ctx, { imageUrl, prompt = prompts.imageAnimation.default }) => {
    console.log("[animate] starting image animation");
    try {
      const apiKey = process.env.FAL_API_KEY;
      if (!apiKey) throw new Error("FAL_API_KEY not set");

      fal.config({ credentials: apiKey });

      // Fetch and upload image to FAL storage
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.status}`);
      const imageBlob = await imageResponse.blob();
      console.log("[animate] image fetched, size:", (imageBlob.size / 1024 / 1024).toFixed(2), "MB");

      const falImageUrl = await fal.storage.upload(imageBlob);
      console.log("[animate] image uploaded to FAL:", falImageUrl);

      const result = await fal.subscribe("fal-ai/kling-video/v2.5-turbo/pro/image-to-video", {
        input: {
          prompt,
          image_url: falImageUrl,
        },
        logs: true,
        onQueueUpdate: (update) => {
          console.log("[animate] queue status:", update.status);
        },
      });

      console.log("[animate] animation complete");
      return { success: true, data: result.data, requestId: result.requestId };
    } catch (error) {
      console.error("[animate] error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "animation failed",
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE VOICEOVER (from sorah — MiniMax TTS with SRT subtitle generation)
// internalAction: billed per call. Only the server-side generateMediaAssets
// pipeline may invoke it (previously public with NO auth — unlimited cost).
// ═══════════════════════════════════════════════════════════════════════════
export const generateVoiceover = internalAction({
  args: {
    text: v.string(),
    voiceId: v.optional(v.string()),
    speed: v.optional(v.number()),
  },
  handler: async (ctx, { text, voiceId = "English_Trustworthy_Man", speed = 1.2 }): Promise<{ success: boolean; audioUrl?: string | null; durationMs?: number; srtContent?: string; error?: string }> => {
    console.log("[voiceover] generating voiceover with MiniMax, speed:", speed);
    try {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) throw new Error("MINIMAX_API_KEY not set");

      // Clamp speed to valid range [0.5, 2] per MiniMax API spec
      const clampedSpeed = Math.min(Math.max(speed, 0.5), 2);

      const response = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "speech-2.8-hd",
          text,
          stream: false,
          voice_setting: {
            voice_id: voiceId,
            speed: clampedSpeed,
            vol: 1.0,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 44100,
            bitrate: 128000,
            format: "mp3",
            channel: 1,
          },
          language_boost: "auto",
          subtitle_enable: true,
          subtitle_type: "sentence",
          output_format: "hex",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax TTS API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      if (result.base_resp?.status_code !== 0) {
        throw new Error(`MiniMax TTS error: ${result.base_resp?.status_msg}`);
      }

      // Decode hex audio
      const hexAudio = result.data?.audio;
      if (!hexAudio) throw new Error("No audio data returned from MiniMax");
      const audioBuffer = Buffer.from(hexAudio, "hex");
      console.log("[voiceover] audio size:", audioBuffer.length);

      const durationMs = result.extra_info?.audio_length || 0;
      console.log("[voiceover] duration:", durationMs, "ms");

      // Fetch subtitle file if available
      let srtContent: string | undefined;
      const subtitleUrl = result.data?.subtitle_file;
      if (subtitleUrl) {
        try {
          const subtitleResponse = await fetch(subtitleUrl);
          if (subtitleResponse.ok) {
            const subtitleJson = await subtitleResponse.json();
            srtContent = convertMiniMaxSubtitleToSRT(subtitleJson, durationMs);
            console.log("[voiceover] SRT generated, length:", srtContent?.length, "chars");
          }
        } catch (subError) {
          console.error("[voiceover] failed to fetch subtitles:", subError);
        }
      }

      // Upload audio to Convex storage
      // NOTE: this action is also called from scheduler-triggered jobs (no
      // user JWT), so use the internal upload URL mutation here.
      const uploadUrl = await ctx.runMutation(internal.tasks.internalGenerateUploadUrl, {});
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "audio/mp3" },
        body: audioBuffer,
      });
      const { storageId } = await uploadResponse.json();
      const audioUrl = await ctx.storage.getUrl(storageId);

      console.log("[voiceover] voiceover uploaded to storage");
      return { success: true, audioUrl, durationMs, srtContent };
    } catch (error) {
      console.error("[voiceover] error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "voiceover generation failed",
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE MUSIC (from sorah — MiniMax Music generation)
// internalAction: billed per call. Only the server-side generateMediaAssets
// pipeline may invoke it (previously public with NO auth — unlimited cost).
// ═══════════════════════════════════════════════════════════════════════════
export const generateMusic = internalAction({
  args: {
    prompt: v.string(),
  },
  handler: async (ctx, { prompt }): Promise<{ success: boolean; musicUrl?: string | null; musicDurationMs?: number; error?: string }> => {
    console.log("[music] generating background music with MiniMax");
    try {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) throw new Error("MINIMAX_API_KEY not set");

      const response = await fetch("https://api.minimaxi.com/v1/music_generation", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "music-3.0",
          prompt,
          is_instrumental: true,
          audio_setting: {
            sample_rate: 44100,
            bitrate: 256000,
            format: "mp3",
          },
          output_format: "url",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax Music API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      if (result.base_resp?.status_code !== 0) {
        throw new Error(`MiniMax Music error: ${result.base_resp?.status_msg}`);
      }

      const musicDownloadUrl = result.data?.audio;
      if (!musicDownloadUrl) throw new Error("No music URL returned from MiniMax");

      // Download and store in Convex
      const musicResponse = await fetch(musicDownloadUrl);
      if (!musicResponse.ok) throw new Error(`Failed to download music: ${musicResponse.status}`);
      const musicBuffer = await musicResponse.arrayBuffer();
      const audioBuffer = new Uint8Array(musicBuffer);

      const musicDurationMs = result.extra_info?.music_duration || 0;
      console.log("[music] music generated, size:", audioBuffer.length, "duration:", musicDurationMs, "ms");

      // NOTE: scheduler-triggered path has no user JWT — use internal variant
      const uploadUrl = await ctx.runMutation(internal.tasks.internalGenerateUploadUrl, {});
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "audio/mp3" },
        body: audioBuffer,
      });
      const { storageId } = await uploadResponse.json();
      const musicUrl = await ctx.storage.getUrl(storageId);

      console.log("[music] music uploaded to storage");
      return { success: true, musicUrl, musicDurationMs };
    } catch (error) {
      console.error("[music] error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "music generation failed",
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE SCRIPT (adapted — raw fetch, supports DeepSeek via OpenRouter)
// Called by generateChatScript and tasks.generateScriptOnly
// ═══════════════════════════════════════════════════════════════════════════
export const generateScript = action({
  args: {
    prompt: v.string(),
    imageUrls: v.optional(v.array(v.string())),
    style: v.optional(v.string()),
  },
  handler: async (ctx, { prompt, imageUrls = [], style = "professional" }) => {
    await requireAuth(ctx);
    console.log("[script] generating script for prompt:", prompt);
    console.log("[script] processing", imageUrls.length, "media files");

    try {
      const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
      const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
      const model = process.env.OPENAI_MODEL || "gpt-4o";

      if (!apiKey) {
        // Fallback: generate a placeholder script
        const placeholderScript = `Looking for the perfect solution? ${prompt} This is exactly what you've been waiting for. Simple, powerful, and designed with you in mind. Try it today and see the difference for yourself.`;
        console.log("[script] No API key, using placeholder script");
        return { success: true, script: placeholderScript };
      }

      // Separate images from videos
      const images: string[] = [];
      const videos: string[] = [];
      const videoFrames: string[] = [];

      for (const url of imageUrls) {
        if (isVideoUrl(url)) {
          videos.push(url);
          const frames = await extractVideoFrames(url, ctx);
          videoFrames.push(...frames);
        } else {
          images.push(url);
        }
      }

      console.log("[script] found", images.length, "images and", videos.length, "videos");
      console.log("[script] extracted", videoFrames.length, "frames from videos");

      // Validate images
      const validImages: string[] = [];
      for (const url of images) {
        const validUrl = await validateImageForAPI(url);
        if (validUrl) validImages.push(validUrl);
      }
      const validFrames: string[] = [];
      for (const url of videoFrames) {
        const validUrl = await validateImageForAPI(url);
        if (validUrl) validFrames.push(validUrl);
      }

      console.log(`[script] ready: ${validImages.length}/${images.length} images + ${validFrames.length}/${videoFrames.length} frames`);

      // Build messages for chat completions API
      const systemPrompt = prompts.scriptGeneration.system(style);
      const userPromptText = prompts.scriptGeneration.user(prompt, style);

      const messages: any[] = [
        { role: "system", content: systemPrompt },
      ];

      // Build content parts for vision support
      const contentParts: any[] = [{ type: "text", text: userPromptText }];
      let hasImages = false;

      // Download images and convert to base64 data URLs
      for (const imageUrl of validImages) {
        const dataUrl = await downloadImageAsDataUrl(imageUrl);
        if (dataUrl) {
          contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
          hasImages = true;
        }
      }

      // Download video frames
      for (const frameUrl of validFrames) {
        const dataUrl = await downloadImageAsDataUrl(frameUrl);
        if (dataUrl) {
          contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
          hasImages = true;
        }
      }

      // Add context about videos
      if (videos.length > 0 && validFrames.length > 0) {
        contentParts.push({
          type: "text",
          text: `\n\n${videos.length} video(s) were uploaded. The frames shown represent key moments (25%, 50%, 75%) from these videos.`,
        });
      }

      if (hasImages) {
        messages.push({ role: "user", content: contentParts });
      } else {
        console.warn("[script] no valid images, generating script from prompt only");
        messages.push({ role: "user", content: userPromptText });
      }

      console.log(`[script] calling ${model} at ${baseUrl}`);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 200,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const script = data.choices?.[0]?.message?.content?.trim();

      if (!script) throw new Error("Empty response from AI");

      console.log("[script] script generated successfully");
      return { success: true, script };
    } catch (error) {
      console.error("[script] error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "script generation failed",
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATE VOICE (from sorah — MiniMax voice cloning)
// Called by users.ts cloneUserVoice
// ═══════════════════════════════════════════════════════════════════════════
export const createElevenLabsVoice = action({
  args: {
    audioUrl: v.string(),
    name: v.string(),
  },
  handler: async (ctx, { audioUrl, name }): Promise<{ success: boolean; voiceId?: string; previewStorageId?: Id<"_storage">; error?: string }> => {
    await requireAuth(ctx);
    console.log("[createVoice] creating MiniMax voice for:", name);
    try {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) throw new Error("MINIMAX_API_KEY not set");

      // Download the audio file
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`);
      const audioBlob = await audioResponse.blob();
      const audioBuffer = await audioBlob.arrayBuffer();
      console.log("[createVoice] audio downloaded, size:", audioBlob.size);

      // Upload audio for voice cloning
      const cloneFormData = new FormData();
      cloneFormData.append("purpose", "voice_clone");
      cloneFormData.append("file", new Blob([audioBuffer], { type: "audio/mp3" }), "voice_sample.mp3");

      const cloneUploadResp = await fetch("https://api.minimaxi.com/v1/files/upload", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: cloneFormData,
      });
      const cloneUploadResult = await cloneUploadResp.json();
      if (cloneUploadResult.base_resp?.status_code !== 0) {
        throw new Error(`Upload voice_clone failed: ${cloneUploadResult.base_resp?.status_msg}`);
      }
      const cloneFileId = cloneUploadResult.file.file_id;
      console.log("[createVoice] voice_clone uploaded, file_id:", cloneFileId);

      // Call voice_clone API
      const customVoiceId = `wordream_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      console.log("[createVoice] calling voice_clone with voice_id:", customVoiceId);

      const cloneResp = await fetch("https://api.minimaxi.com/v1/voice_clone", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_id: cloneFileId,
          voice_id: customVoiceId,
          text: "Hello! This is a preview of your custom AI voice.",
          model: "speech-2.8-hd",
          need_noise_reduction: false,
          need_volume_normalization: true,
        }),
      });

      const cloneResult = await cloneResp.json();
      if (cloneResult.base_resp?.status_code !== 0) {
        throw new Error(`Voice clone failed: ${cloneResult.base_resp?.status_msg}`);
      }

      const voiceId = customVoiceId;
      console.log("[createVoice] voice created:", voiceId);

      // Download demo audio as preview
      let previewStorageId: Id<"_storage"> | undefined;
      const demoAudioUrl = cloneResult.demo_audio;
      if (demoAudioUrl) {
        try {
          const demoResp = await fetch(demoAudioUrl);
          if (demoResp.ok) {
            const demoBuffer = new Uint8Array(await demoResp.arrayBuffer());
            const uploadUrl = await ctx.runMutation(api.tasks.generateUploadUrl, {});
            const uploadResponse = await fetch(uploadUrl, {
              method: "POST",
              headers: { "Content-Type": "audio/mp3" },
              body: demoBuffer,
            });
            const { storageId } = await uploadResponse.json();
            previewStorageId = storageId;
            console.log("[createVoice] preview stored:", previewStorageId);
          }
        } catch (previewError) {
          console.error("[createVoice] failed to store preview:", previewError);
        }
      }

      return { success: true, voiceId, previewStorageId };
    } catch (error) {
      console.error("[createVoice] error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "voice creation failed",
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW VOICE (from sorah — MiniMax TTS, returns base64)
// Called directly by frontend (useVoicePreview.ts)
// ═══════════════════════════════════════════════════════════════════════════
export const previewVoice = action({
  args: { voiceId: v.string() },
  handler: async (ctx, { voiceId }): Promise<{ success: boolean; audioBase64?: string; error?: string }> => {
    await requireAuth(ctx);
    console.log("[previewVoice] generating for:", voiceId);
    try {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) throw new Error("MINIMAX_API_KEY not set");

      const previewText = "Hello! This is a preview of my voice. I hope you like how it sounds.";

      const response = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "speech-2.8-hd",
          text: previewText,
          stream: false,
          voice_setting: {
            voice_id: voiceId,
            speed: 1.2,
            vol: 1.0,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 44100,
            bitrate: 128000,
            format: "mp3",
            channel: 1,
          },
          language_boost: "auto",
          output_format: "hex",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax TTS API error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      if (result.base_resp?.status_code !== 0) {
        throw new Error(`MiniMax TTS error: ${result.base_resp?.status_msg}`);
      }

      const hexAudio = result.data?.audio;
      if (!hexAudio) throw new Error("No audio data returned from MiniMax");

      const audioBuffer = Buffer.from(hexAudio, "hex");
      const audioBase64 = audioBuffer.toString('base64');

      console.log("[previewVoice] preview generated successfully");
      return { success: true, audioBase64 };
    } catch (error) {
      console.error("[previewVoice] error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "voice preview failed",
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE CHAT SCRIPT (wordream-app specific — called by chat-composer.tsx)
// Wraps generateScript with conversation context and saves to DB
// ═══════════════════════════════════════════════════════════════════════════
export const generateChatScript = action({
  args: {
    projectId: v.id("projects"),
    conversationHistory: v.array(v.object({
      role: v.string(),
      content: v.string(),
    })),
    cachedMediaDescriptions: v.optional(v.any()),
    newMediaFiles: v.optional(v.array(v.object({
      storageId: v.id("_storage"),
      filename: v.string(),
      contentType: v.string(),
    }))),
    isFirstMessage: v.boolean(),
    isNewMedia: v.boolean(),
    newMediaCount: v.number(),
    saveAndNotify: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; script?: string; error?: string }> => {
    const authUserId = await requireAuth(ctx);
    try {
      const project = await ctx.runQuery(api.tasks.getProject, { id: args.projectId });
      if (!project) throw new Error("project not found");
      if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");

      let style = "professional";
      if (project.userId) {
        const user = await ctx.runQuery(api.users.getCurrentUser, { userId: project.userId });
        if (user?.preferredStyle) style = user.preferredStyle;
      }

      // Build prompt from conversation
      const lastUserMessage = args.conversationHistory.filter(m => m.role === "user").pop();
      const prompt = lastUserMessage?.content || project.prompt || "Create a 15-second social media video";

      const fileUrls = project.fileUrls?.filter((url: string | null): url is string => url !== null) || [];

      const scriptResult = await ctx.runAction(api.aiServices.generateScript, {
        prompt,
        imageUrls: fileUrls,
        style,
      });

      if (!scriptResult.success || !scriptResult.script) {
        throw new Error(scriptResult.error || "script generation failed");
      }

      const script = scriptResult.script;

      // Save script and add assistant message if saveAndNotify is true
      if (args.saveAndNotify) {
      // updateProjectWithReelfulData is an internal mutation (R1 security
      // hardening); server-side runMutation calls reach internal functions
      // fine — only direct client calls are blocked.
      await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
        id: args.projectId,
        script,
        status: "completed",
      });

      await ctx.runMutation(api.tasks.addChatMessage, {
          projectId: args.projectId,
          role: "assistant",
          content: script,
        });

      }

      return { success: true, script };
    } catch (error) {
      console.error("[aiServices] generateChatScript error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "chat script generation failed",
      };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE SCRIPT PREVIEW AUDIO (wordream-app specific — called by chat-composer.tsx)
// Uses MiniMax TTS to generate a quick audio preview of a script
// ═══════════════════════════════════════════════════════════════════════════
export const generateScriptPreviewAudio = action({
  args: {
    messageId: v.string(),
    script: v.string(),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<{ success: boolean; audioUrl?: string; error?: string }> => {
    const authUserId = await requireAuth(ctx);
    try {
      const apiKey = process.env.MINIMAX_API_KEY;
      if (!apiKey) {
        console.log("[aiServices] No MINIMAX_API_KEY, skipping audio preview");
        return { success: false, error: "TTS not configured" };
      }

      // If user has a custom voice, use it
      let voiceId: string = "English_Trustworthy_Man";
      // Always use the authenticated user's voice preferences
      const user = await ctx.runQuery(api.users.getCurrentUser, { userId: authUserId as any });
      if (user?.selectedVoiceId) voiceId = user.selectedVoiceId;
      else if (user?.elevenlabsVoiceId) voiceId = user.elevenlabsVoiceId;

      const response = await fetch("https://api.minimaxi.com/v1/t2a_v2", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "speech-2.8-hd",
          text: args.script,
          stream: false,
          voice_setting: {
            voice_id: voiceId,
            speed: 1.2,
            vol: 1.0,
            pitch: 0,
          },
          audio_setting: {
            sample_rate: 44100,
            bitrate: 128000,
            format: "mp3",
            channel: 1,
          },
          language_boost: "auto",
          output_format: "hex",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MiniMax TTS error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      if (result.base_resp?.status_code !== 0) {
        throw new Error(`MiniMax TTS error: ${result.base_resp?.status_msg}`);
      }

      const hexAudio = result.data?.audio;
      if (!hexAudio) throw new Error("No audio data returned from MiniMax");
      const audioBuffer = Buffer.from(hexAudio, "hex");

      // Upload to Convex storage
      const uploadUrl: string = await ctx.runMutation(api.tasks.generateUploadUrl, {});
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "audio/mp3" },
        body: audioBuffer,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Failed to upload audio: ${uploadResponse.status}`);
      }
      const { storageId } = await uploadResponse.json();
      const audioUrl = await ctx.storage.getUrl(storageId);

      return { success: true, audioUrl: audioUrl || undefined };
    } catch (error) {
      console.error("[aiServices] generateScriptPreviewAudio error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "audio generation failed",
      };
    }
  },
});

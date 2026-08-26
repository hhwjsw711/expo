"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { Sandbox } from "e2b";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { prompts } from "./prompts";

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Parse composition ID from Root.tsx in sandbox. Prefers "Main". */
async function getCompositionId(sb: Sandbox): Promise<string> {
  const rootContent = await sb.commands.run("cat /home/user/src/Root.tsx");
  const compositionIds = rootContent.stdout
    .match(/id="([^"]+)"/g)
    ?.map((m: string) => m.match(/id="([^"]+)"/)?.[1])
    .filter(Boolean) || [];
  const compositionId = compositionIds.includes("Main")
    ? "Main"
    : compositionIds[compositionIds.length - 1] || "Main";
  console.log(`[render] compositions: ${compositionIds}, using: ${compositionId}`);
  return compositionId;
}

/** Create a new E2B sandbox with standard config. */
async function createSandbox(): Promise<Sandbox> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!anthropicBaseUrl) throw new Error("ANTHROPIC_BASE_URL not set");
  if (!process.env.E2B_API_KEY) throw new Error("E2B_API_KEY not set");

  const sb = await Sandbox.create("remotion-template", {
    lifecycle: { onTimeout: "pause" },
    timeoutMs: 3600000,
    envs: {
      ANTHROPIC_API_KEY: anthropicApiKey,
      ANTHROPIC_BASE_URL: anthropicBaseUrl,
    },
  });
  sb.setTimeout(3600000);
  return sb;
}

/**
 * Prepare all media files in the sandbox.
 * Writes SRT, downloads audio/music/videos in parallel.
 */
async function prepareMediaFiles(sb: Sandbox, project: any): Promise<void> {
  await sb.commands.run("mkdir -p /home/user/public/media /home/user/public/reelful");

  // Write SRT
  if (project.srtContent && project.srtContent.trim().length > 0) {
    console.log("[render] writing srt, length:", project.srtContent.length);
    await sb.files.write("/home/user/public/reelful-fast.srt", project.srtContent);
    await sb.files.write("/home/user/public/media/subtitles.srt", project.srtContent);
  }

  // Build download tasks for parallel execution
  const downloadTasks: Promise<void>[] = [];

  if (project.audioUrl) {
    downloadTasks.push(downloadToSandbox(sb, project.audioUrl, "/home/user/public/media/audio.mp3", "audio"));
  }

  if (project.musicUrl) {
    downloadTasks.push(downloadToSandbox(sb, project.musicUrl, "/home/user/public/media/music.mp3", "music"));
  }

  if (project.videoUrls && project.videoUrls.length > 0) {
    for (let i = 0; i < project.videoUrls.length; i++) {
      const idx = i;
      downloadTasks.push(
        downloadToSandbox(sb, project.videoUrls[idx], `/home/user/public/media/video${idx}.mp4`, `video${idx}`)
      );
    }
  }

  // Also download original uploaded video files (not just animated ones).
  // videoUrls only contains FAL-animated image results; user-uploaded videos
  // are in fileUrls/fileMetadata. Claude needs to see ALL source material.
  if (project.fileUrls && project.fileMetadata) {
    const videoStartIdx = (project.videoUrls || []).length;
    let videoFileIdx = 0;
    for (let i = 0; i < project.fileMetadata.length; i++) {
      const meta = project.fileMetadata[i];
      const url = project.fileUrls[i];
      if (meta && url && meta.contentType?.startsWith("video/")) {
        const idx = videoStartIdx + videoFileIdx;
        downloadTasks.push(
          downloadToSandbox(sb, url as string, `/home/user/public/media/video${idx}.mp4`, `video${idx} (original)`)
        );
        videoFileIdx++;
      }
    }
  }

  // Execute all downloads in parallel
  console.log(`[render] downloading ${downloadTasks.length} media files in parallel...`);
  await Promise.all(downloadTasks);
  console.log("[render] all media files downloaded");
}

/** Download a single file from URL to sandbox path via curl. */
async function downloadToSandbox(
  sb: Sandbox,
  url: string,
  destPath: string,
  label: string
): Promise<void> {
  console.log(`[render] downloading ${label}...`);
  const escapedUrl = url.replace(/'/g, "'\\''");
  const result = await sb.commands.run(
    `curl -f -L -o "${destPath}" '${escapedUrl}'`,
    { timeoutMs: 300000 }
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to download ${label}: ${result.stderr}`);
  }
  console.log(`[render] ${label} downloaded`);
}

/**
 * Sync all @remotion/* packages to match core remotion version.
 * Claude agent may have installed mismatched versions.
 */
async function syncRemotionVersions(sb: Sandbox): Promise<void> {
  console.log("[render] syncing remotion package versions...");
  const versionCheck = await sb.commands.run(
    `cd /home/user && cat node_modules/remotion/package.json | grep '"version"' | head -1`
  );
  const coreVersionMatch = versionCheck.stdout.match(/"version":\s*"([^"]+)"/);
  if (!coreVersionMatch) {
    console.log("[render] WARNING: could not determine remotion version, skipping sync");
    return;
  }

  const coreVersion = coreVersionMatch[1];
  console.log("[render] core remotion version:", coreVersion);

  const syncResult = await sb.commands.run(
    `cd /home/user && ` +
    `for pkg in $(ls node_modules/@remotion 2>/dev/null); do ` +
    `installed=$(cat node_modules/@remotion/$pkg/package.json 2>/dev/null | grep '"version"' | head -1 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+'); ` +
    `if [ -n "$installed" ] && [ "$installed" != "${coreVersion}" ]; then ` +
    `echo "fixing @remotion/$pkg: $installed -> ${coreVersion}"; ` +
    `bun add @remotion/$pkg@${coreVersion} 2>&1; ` +
    `fi; ` +
    `done`,
    { timeoutMs: 120000 }
  );
  console.log("[render] version sync done:", syncResult.stdout.substring(0, 300));
}

/** Clean up disk space in sandbox before rendering. */
async function cleanupDisk(sb: Sandbox): Promise<void> {
  await sb.commands.run(`
    rm -rf /tmp/* /var/tmp/* 2>/dev/null || true;
    rm -rf ~/.bun/install/cache/* 2>/dev/null || true;
    rm -rf ~/.cache/* 2>/dev/null || true;
    rm -rf /home/user/.cache/* 2>/dev/null || true;
    rm -rf /home/user/node_modules/.cache/* 2>/dev/null || true;
  `);
}

/**
 * Download rendered video from sandbox, upload to Convex storage,
 * and update project status. Returns the video URL.
 */
async function downloadAndUploadVideo(
  ctx: any,
  sb: Sandbox,
  videoPath: string,
  projectId: Id<"projects">
): Promise<string> {
  // Verify output exists
  const sizeResult = await sb.commands.run(
    `stat -f%z "${videoPath}" 2>/dev/null || stat -c%s "${videoPath}" 2>/dev/null`
  );
  const outputSize = parseInt(sizeResult.stdout.trim() || "0");
  if (outputSize < 1000) {
    throw new Error(`output video too small (${outputSize} bytes)`);
  }

  // Audio fallback: ensure video has an audio track
  await ensureAudioTrack(sb, videoPath);

  // Download from sandbox
  console.log("[render] downloading video from sandbox...");
  await ctx.runMutation(api.tasks.updateRenderProgress, {
    id: projectId,
    step: "downloading video",
    details: "fetching rendered file from sandbox",
  });

  const downloadUrl = await sb.downloadUrl(videoPath, { useSignatureExpiration: 300000 });
  const videoResponse = await fetch(downloadUrl);
  if (!videoResponse.ok) {
    throw new Error(`failed to download video: ${videoResponse.statusText}`);
  }
  const videoBuffer = await videoResponse.arrayBuffer();
  console.log("[render] video downloaded, size:", videoBuffer.byteLength, "bytes");

  // Upload to Convex storage
  console.log("[render] uploading to convex storage...");
  await ctx.runMutation(api.tasks.updateRenderProgress, {
    id: projectId,
    step: "saving video",
    details: "uploading to permanent storage",
  });

  const uploadUrl: string = await ctx.runMutation(api.tasks.generateUploadUrl, {});
  const uploadResponse: Response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "video/mp4" },
    body: videoBuffer,
  });
  const { storageId }: { storageId: Id<"_storage"> } = await uploadResponse.json();
  const renderedVideoUrl: string | null = await ctx.storage.getUrl(storageId);
  console.log("[render] uploaded, url:", renderedVideoUrl);

  // Update project
  await ctx.runMutation(api.tasks.updateProjectWithRenderResult, {
    id: projectId,
    renderedVideoUrl: renderedVideoUrl || undefined,
    status: "completed",
  });

  return renderedVideoUrl || "";
}

/**
 * Check if rendered video has an audio track.
 * If not, mux in audio.mp3 (TTS voiceover) as fallback.
 */
async function ensureAudioTrack(sb: Sandbox, videoPath: string): Promise<void> {
  console.log("[render] checking audio track...");
  const probeResult = await sb.commands.run(
    `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${videoPath}" 2>&1`
  );
  const hasAudio = probeResult.stdout.trim().startsWith("audio");
  console.log("[render] audio present:", hasAudio);

  if (hasAudio) return;

  console.log("[render] no audio, muxing audio.mp3...");
  const audioCheck = await sb.commands.run(`ls -lh /home/user/public/media/audio.mp3 2>&1`);
  if (audioCheck.exitCode !== 0) {
    console.log("[render] WARNING: audio.mp3 not found, cannot mux");
    return;
  }

  const muxedPath = videoPath.replace(/\.mp4$/, "_muxed.mp4");
  const muxResult = await sb.commands.run(
    `ffmpeg -y -i "${videoPath}" -i "/home/user/public/media/audio.mp3" ` +
    `-c:v copy -c:a aac -b:a 192k -shortest "${muxedPath}"`,
    { timeoutMs: 120000 }
  );

  if (muxResult.exitCode === 0) {
    await sb.commands.run(`mv "${muxedPath}" "${videoPath}"`);
    console.log("[render] audio muxed successfully");
  } else {
    console.log("[render] WARNING: mux failed:", muxResult.stderr?.substring(0, 300));
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────

/**
 * Step 1 of the two-step render pipeline.
 * Creates sandbox, uploads media, runs Claude agent to create Remotion composition.
 * Must complete within Convex's 10-minute action timeout (~5 min typical).
 *
 * Does NOT pause the sandbox — it stays running for renderFinalVideo to connect.
 */
export const createSequence = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, { projectId }): Promise<{
    success: boolean;
    sandboxId?: string;
    error?: string;
  }> => {
    console.log("[sequence] starting for project:", projectId);

    // Acquire render lock to prevent duplicate renders
    const lockResult: { success: boolean; error?: string } = await ctx.runMutation(
      api.tasks.tryAcquireRenderLock,
      { id: projectId }
    );
    if (!lockResult.success) {
      console.log("[sequence] skipping:", lockResult.error);
      return { success: false, error: lockResult.error };
    }

    let sandbox: Sandbox | undefined;

    try {
      const project = await ctx.runQuery(api.tasks.getProject, { id: projectId });
      if (!project) throw new Error("project not found");

      // ── 1. Create or connect sandbox ──
      if (project.sandboxId) {
        console.log("[sequence] connecting to existing sandbox:", project.sandboxId);
        try {
          sandbox = await Sandbox.connect(project.sandboxId, { apiKey: process.env.E2B_API_KEY, timeoutMs: 3600000 });
          await sandbox.commands.run("echo alive");
          console.log("[sequence] existing sandbox is alive");
        } catch {
          console.log("[sequence] existing sandbox dead, creating new one");
          sandbox = undefined;
        }
      }

      if (!sandbox) {
        console.log("[sequence] creating new sandbox...");
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "creating sandbox",
          details: "initializing e2b environment",
        });

        sandbox = await createSandbox();
        console.log("[sequence] sandbox created:", sandbox.sandboxId);

        await ctx.runMutation(api.tasks.updateProjectSandbox, {
          id: projectId,
          sandboxId: sandbox.sandboxId,
        });
      }

      const sb: Sandbox = sandbox;

      // ── 2. Prepare media files (parallel download) ──
      console.log("[sequence] preparing media files...");
      await ctx.runMutation(api.tasks.updateRenderProgress, {
        id: projectId,
        step: "uploading media",
        details: "transferring files to sandbox",
      });

      await prepareMediaFiles(sb, project);

      // ── 3. Generate composition — branch on timelineJson ──
      const hasTimelineJson = project.timelineJson && project.timelineJson.trim().length > 0;

      if (hasTimelineJson) {
        // ── Branch B: User has edited the timeline — use generate-composition.ts ──
        console.log("[sequence] using existing timelineJson, skipping Claude");
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "generating composition from timeline",
          details: "converting timeline edits to Remotion code",
        });

        // Write timeline.json into the sandbox
        await sb.files.write("/home/user/timeline.json", project.timelineJson!);

        // Run generate-composition.ts (reads timeline.json, writes src/Root.tsx + src/Composition.tsx)
        const genResult = await sb.commands.run("bun run generate-composition.ts", {
          cwd: "/home/user",
          timeoutMs: 60000,
          requestTimeoutMs: 60000,
        });

        if (genResult.exitCode !== 0) {
          throw new Error(`generate-composition failed: ${genResult.stderr}`);
        }

        console.log("[sequence] generate-composition completed");
      } else {
        // ── Branch A: First time — run Claude agent ──
        console.log("[sequence] no timelineJson, running claude agent...");
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "claude video editing",
          details: "claude is analyzing footage and creating composition",
        });

        const editorContext = project.prompt?.trim() || project.script?.trim() || "create an engaging social media video";
        const videoEditorPrompt = prompts.videoEditor.generate(editorContext);

        await sb.files.write("/home/user/prompt.txt", videoEditorPrompt);

        const claudeResult = await sb.commands.run("bun run claude-agent.ts", {
          cwd: "/home/user",
          timeoutMs: 300000,
          requestTimeoutMs: 300000,
        });

        if (claudeResult.exitCode !== 0) {
          throw new Error(`claude editing failed: ${claudeResult.stderr}`);
        }

        console.log("[sequence] claude completed, reading timeline.json from sandbox...");

        // Read timeline.json back from sandbox and store in Convex
        const timelineCheck = await sb.commands.run("test -f /home/user/timeline.json && echo exists || echo missing");
        if (timelineCheck.stdout.trim() === "exists") {
          const timelineContent = await sb.files.read("/home/user/timeline.json");
          const timelineStr = typeof timelineContent === "string" ? timelineContent : new TextDecoder().decode(timelineContent);

          if (timelineStr && timelineStr.trim().length > 0) {
            console.log("[sequence] timeline.json read, length:", timelineStr.length);
            await ctx.runMutation(api.tasks.updateProjectTimelineJson, {
              id: projectId,
              timelineJson: timelineStr,
            });
          } else {
            console.log("[sequence] WARNING: timeline.json is empty");
          }
        } else {
          console.log("[sequence] WARNING: claude did not produce timeline.json");
        }
      }

      await ctx.runMutation(api.tasks.updateRenderProgress, {
        id: projectId,
        step: "sequence created",
        details: "ready for final render",
      });

      // NOTE: Do NOT pause the sandbox. It stays running with a 1-hour timeout.
      // renderFinalVideo will connect to it via Sandbox.connect().
      return { success: true, sandboxId: sandbox.sandboxId };

    } catch (error) {
      console.error("[sequence] error:", error);

      if (sandbox) {
        try { await sandbox.kill(); } catch (e) { console.log("[sequence] kill failed:", e); }
      }

      await ctx.runMutation(api.tasks.updateProjectWithRenderResult, {
        id: projectId,
        error: error instanceof Error ? error.message : "sequence creation failed",
        status: "failed",
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : "sequence creation failed",
      };
    }
  },
});

/**
 * Step 2 of the two-step render pipeline.
 * Connects to the sandbox created by createSequence, syncs Remotion versions,
 * renders the video, downloads it, and uploads to Convex storage.
 *
 * Must complete within Convex's 10-minute action timeout (~5 min typical).
 *
 * Also used as a recovery mechanism: if a previous renderFinalVideo was
 * killed by the action timeout, calling this again will connect to the
 * still-running sandbox and check for / download the already-rendered video.
 */
export const renderFinalVideo = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, { projectId }): Promise<{
    success: boolean;
    renderedVideoUrl?: string;
    error?: string;
  }> => {
    console.log("[render-final] starting for project:", projectId);

    let sandbox: Sandbox | undefined;

    try {
      const project = await ctx.runQuery(api.tasks.getProject, { id: projectId });
      if (!project) throw new Error("project not found");
      if (!project.sandboxId) throw new Error("no sandbox found — create sequence first");

      console.log("[render-final] connecting to sandbox:", project.sandboxId);
      sandbox = await Sandbox.connect(project.sandboxId, { apiKey: process.env.E2B_API_KEY, timeoutMs: 3600000 });
      const sb: Sandbox = sandbox;

      // ── 1. Disk cleanup + version sync ──
      console.log("[render-final] cleaning up disk...");
      await ctx.runMutation(api.tasks.updateRenderProgress, {
        id: projectId,
        step: "preparing render",
        details: "cleaning up and syncing packages",
      });

      await cleanupDisk(sb);
      await syncRemotionVersions(sb);

      // ── 2. Render with Remotion ──
      const compositionId = await getCompositionId(sb);
      const videoPath = `/home/user/out/${compositionId}.mp4`;

      // Check if video already exists (recovery from previous timeout)
      const existingCheck = await sb.commands.run(`test -f "${videoPath}" && echo exists || echo missing`);
      if (existingCheck.stdout.trim() === "exists") {
        const sizeResult = await sb.commands.run(
          `stat -f%z "${videoPath}" 2>/dev/null || stat -c%s "${videoPath}" 2>/dev/null`
        );
        const existingSize = parseInt(sizeResult.stdout.trim() || "0");
        if (existingSize > 1000) {
          console.log("[render-final] found existing render from previous attempt, size:", existingSize);
        }
      }

      if (existingCheck.stdout.trim() !== "exists" || parseInt((await sb.commands.run(`stat -c%s "${videoPath}" 2>/dev/null || stat -f%z "${videoPath}" 2>/dev/null`)).stdout.trim() || "0") < 1000) {
        console.log("[render-final] rendering:", compositionId);
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "rendering video",
          details: `rendering composition: ${compositionId}`,
        });

        const remotionResult = await sb.commands.run(
          `bun remotion render ${compositionId} ${videoPath}`,
          {
            cwd: "/home/user",
            timeoutMs: 300000,
            requestTimeoutMs: 300000,
          }
        );

        if (remotionResult.exitCode !== 0) {
          throw new Error(`remotion render failed: ${remotionResult.stderr}`);
        }
      }

      // ── 3. Download + upload + update ──
      const renderedVideoUrl = await downloadAndUploadVideo(ctx, sb, videoPath, projectId);

      // ── 4. Kill sandbox ──
      console.log("[render-final] killing sandbox...");
      try { await sb.kill(); } catch (e) { console.log("[render-final] kill failed:", e); }

      console.log("[render-final] SUCCESS! URL:", renderedVideoUrl);
      return { success: true, renderedVideoUrl };

    } catch (error) {
      console.error("[render-final] error:", error);

      if (sandbox) {
        try { await sandbox.kill(); } catch (e) { console.log("[render-final] kill failed:", e); }
      }

      await ctx.runMutation(api.tasks.updateProjectWithRenderResult, {
        id: projectId,
        error: error instanceof Error ? error.message : "render failed",
        status: "failed",
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : "render failed",
      };
    }
  },
});

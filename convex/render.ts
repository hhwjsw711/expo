"use node";

import { action } from "./_generated/server";
import { v } from "convex/values";
import { Sandbox } from "e2b";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { prompts } from "./prompts";
import { requireAuth } from "./auth";
import { validateTimelinePlan } from "./lib/timelinePlan";

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
    const authUserId = await requireAuth(ctx);
    console.log("[sequence] starting for project:", projectId);

    // Verify project ownership
    const projectCheck = await ctx.runQuery(api.tasks.getProject, { id: projectId });
    if (!projectCheck) throw new Error("project not found");
    if (projectCheck.userId !== authUserId) throw new Error("Forbidden: not project owner");

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

        // Validate the client-supplied timeline with the SAME rules as the
        // AI plan. The editor normally emits well-formed JSON, but a stale
        // client or a bug could ship NaN times or reference a file that was
        // never downloaded — without validation that surfaces later as an
        // opaque "remotion render failed" instead of a clear, fixable error.
        // Note the distinct error prefix: user data never fixes itself by
        // re-running, so this is a PERMANENT failure (unlike the AI plan,
        // whose "timeline.json invalid" prefix is classified transient).
        const lsResult = await sb.commands.run("ls /home/user/public/media");
        const mediaFiles = lsResult.stdout
          .split("\n")
          .map((l: string) => l.trim())
          .filter(Boolean);
        const editCheck = validateTimelinePlan(project.timelineJson!, mediaFiles);
        if (!editCheck.ok) {
          throw new Error(`edited timeline invalid: ${editCheck.error}`);
        }

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
        // ── Branch A: First time — run Claude agent (V2: timeline-plan-only) ──
        // Claude outputs ONLY timeline.json (the structured edit plan).
        // The Remotion code is then generated deterministically from that
        // plan by generate-composition.ts — same path as user edits (Branch B).
        console.log("[sequence] no timelineJson, running claude agent (plan-only mode)...");
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "claude video editing",
          details: "claude is analyzing footage and planning the edit",
        });

        const editorContext = project.prompt?.trim() || project.script?.trim() || "create an engaging social media video";
        const videoEditorPrompt = prompts.videoEditor.generateV2(editorContext);

        // V2: inject the system prompt via system-prompt.txt so we can
        // iterate on it WITHOUT rebuilding the E2B template image.
        // (claude-agent.ts reads this file if present; falls back to the
        // built-in default otherwise.)
        await sb.files.write("/home/user/system-prompt.txt", prompts.videoEditor.systemPromptV2);
        await sb.files.write("/home/user/prompt.txt", videoEditorPrompt);

        const claudeResult = await sb.commands.run("bun run claude-agent.ts", {
          cwd: "/home/user",
          timeoutMs: 360000,
          requestTimeoutMs: 360000,
        });

        if (claudeResult.exitCode !== 0) {
          throw new Error(`claude editing failed: ${claudeResult.stderr}`);
        }

        console.log("[sequence] claude completed, reading timeline.json from sandbox...");

        // Read + VALIDATE the plan before using it — fail fast on malformed
        // JSON instead of shipping a broken composition.
        const timelineCheck = await sb.commands.run("test -f /home/user/timeline.json && echo exists || echo missing");
        if (timelineCheck.stdout.trim() !== "exists") {
          throw new Error("timeline.json invalid: claude did not produce timeline.json");
        }

        const timelineContent = await sb.files.read("/home/user/timeline.json");
        const timelineStr = typeof timelineContent === "string" ? timelineContent : new TextDecoder().decode(timelineContent);

        // List what actually exists in the media dir so validation can
        // cross-check every segment reference (fails fast on files the
        // agent hallucinated that were never downloaded).
        const lsResult = await sb.commands.run("ls /home/user/public/media");
        const mediaFiles = lsResult.stdout
          .split("\n")
          .map((l: string) => l.trim())
          .filter(Boolean);

        const validated = validateTimelinePlan(timelineStr, mediaFiles);
        if (!validated.ok) {
          throw new Error(`timeline.json invalid: ${validated.error}`);
        }
        console.log("[sequence] timeline plan validated:", validated.plan.segments.length, "segments,",
          validated.plan.segments.reduce((s: number, seg: any) => s + seg.duration, 0).toFixed(2) + "s total");

        // Persist the plan (revision 1, source 'ai'), then generate the
        // composition deterministically. The optimistic lock should never
        // fire here — we hold the render lock — but if it ever does, fail
        // loudly instead of silently clobbering a concurrent editor save.
        const revResult = await ctx.runMutation(api.tasks.saveTimelineRevision, {
          projectId,
          baseRevision: project.timelineRevision ?? 0,
          timelineJson: timelineStr,
          source: "ai",
          note: "claude agent plan",
        });
        if (!revResult.success) {
          const reason = revResult.conflict
            ? `revision conflict: loaded ${project.timelineRevision ?? 0}, server is at ${revResult.currentRevision}`
            : revResult.error;
          throw new Error(`failed to persist timeline: ${reason}`);
        }

        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "generating composition from timeline",
          details: "converting the edit plan to Remotion code",
        });

        const genResult = await sb.commands.run("bun run generate-composition.ts", {
          cwd: "/home/user",
          timeoutMs: 60000,
          requestTimeoutMs: 60000,
        });
        if (genResult.exitCode !== 0) {
          throw new Error(`generate-composition failed: ${genResult.stderr}`);
        }
        console.log("[sequence] composition generated from plan (same path as user edits)");
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

      const errMsg = error instanceof Error ? error.message : "sequence creation failed";
      // For transient errors (network, download, timeout), keep the sandbox
      // alive and don't mark as "failed" so the user can retry. Only kill the
      // sandbox and mark failed for permanent errors (sandbox creation failure,
      // claude/generate-composition explicitly failed).
      const isTransient = errMsg.includes("timed out")
        || errMsg.includes("timeout")
        || errMsg.includes("ETIMEDOUT")
        || errMsg.includes("ECONNRESET")
        || errMsg.includes("ECONNREFUSED")
        || errMsg.includes("download")
        || errMsg.includes("fetch")
        || errMsg.includes("network")
        // A malformed AI plan is retryable: media is already in the sandbox,
        // and re-running the agent is cheap. The client polling service
        // bounds retries (SEQUENCE_MAX_RETRIES), so no infinite loop.
        || errMsg.includes("timeline.json invalid");

      if (sandbox && !isTransient) {
        try { await sandbox.kill(); } catch (e) { console.log("[sequence] kill failed:", e); }
      }

      if (isTransient) {
        console.log("[sequence] transient error, keeping sandbox alive for retry");
        // Release the render lock: tryAcquireRenderLock treats status
        // "rendering" as held, and without this reset a retry can never
        // re-acquire it — the project would deadlock in "rendering" forever.
        // Media assets are intact, so "completed" is the correct resting
        // state (matches the assets-ready condition everywhere).
        await ctx.runMutation(api.tasks.updateProjectStatus, {
          id: projectId,
          status: "completed",
        });
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "retry available",
          details: `transient error: ${errMsg.substring(0, 200)}`,
        });
      } else {
        await ctx.runMutation(api.tasks.updateProjectWithRenderResult, {
          id: projectId,
          error: errMsg,
          status: "failed",
        });
      }

      return {
        success: false,
        error: errMsg,
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
    const authUserId = await requireAuth(ctx);
    console.log("[render-final] starting for project:", projectId);

    // Verify project ownership
    const projectCheck = await ctx.runQuery(api.tasks.getProject, { id: projectId });
    if (!projectCheck) throw new Error("project not found");
    if (projectCheck.userId !== authUserId) throw new Error("Forbidden: not project owner");

    let sandbox: Sandbox | undefined;

    try {
      const project = await ctx.runQuery(api.tasks.getProject, { id: projectId });
      if (!project) throw new Error("project not found");
      if (!project.sandboxId) throw new Error("no sandbox found — create sequence first");

      console.log("[render-final] connecting to sandbox:", project.sandboxId);
      try {
        sandbox = await Sandbox.connect(project.sandboxId, { apiKey: process.env.E2B_API_KEY, timeoutMs: 3600000 });
      } catch (connectError) {
        // The sandbox is gone (E2B reclaims it after the 1h timeout).
        // This is NOT a permanent failure: the timeline and media assets are
        // all in the database, so a fresh sandbox can be rebuilt via
        // createSequence (Branch B). Release the lock, drop the dead
        // sandboxId, and mark retry available — the polling service then
        // re-runs the sequence for the user instead of failing the project.
        const reason = connectError instanceof Error ? connectError.message : String(connectError);
        console.log("[render-final] sandbox unreachable, marking for rebuild:", reason);
        await ctx.runMutation(api.tasks.updateProjectSandbox, {
          id: projectId,
          sandboxId: undefined,
        });
        await ctx.runMutation(api.tasks.updateProjectStatus, {
          id: projectId,
          status: "completed",
        });
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "retry available",
          details: `sandbox expired, rebuilding: ${reason.substring(0, 150)}`,
        });
        return {
          success: false,
          error: `sandbox expired, will rebuild it: ${reason}`,
        };
      }
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

      // Check if video already exists (recovery from previous timeout).
      // A partially-written file from an interrupted render can easily be
      // larger than the naive 1000-byte threshold, so ALSO verify the
      // duration with ffprobe: a truncated render comes up far short of the
      // composition length and must be re-rendered, not uploaded broken.
      const expectedSeconds = (() => {
        try {
          const tl = project.timelineJson ? JSON.parse(project.timelineJson) : null;
          const frames = Number(tl?.durationInFrames) || 0;
          const fps = Number(tl?.fps) || 30;
          return frames > 0 ? frames / fps : 0;
        } catch {
          return 0; // unparseable timeline → skip the duration check
        }
      })();

      const existingCheck = await sb.commands.run(`test -f "${videoPath}" && echo exists || echo missing`);
      let existingSize = 0;
      let existingDurationOk = false;
      if (existingCheck.stdout.trim() === "exists") {
        const sizeResult = await sb.commands.run(
          `stat -f%z "${videoPath}" 2>/dev/null || stat -c%s "${videoPath}" 2>/dev/null`
        );
        existingSize = parseInt(sizeResult.stdout.trim() || "0");
        if (existingSize > 1000) {
          if (expectedSeconds > 0) {
            const probeResult = await sb.commands.run(
              `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}" 2>&1`
            );
            const actualSeconds = parseFloat(probeResult.stdout.trim());
            existingDurationOk = Number.isFinite(actualSeconds)
              && Math.abs(actualSeconds - expectedSeconds) < 1;
            if (existingSize > 1000 && !existingDurationOk) {
              console.log(
                `[render-final] existing render fails duration check (${actualSeconds}s vs expected ${expectedSeconds}s), re-rendering`
              );
            } else if (existingDurationOk) {
              console.log("[render-final] found valid existing render from previous attempt, size:", existingSize);
            }
          } else {
            // No expected duration available (unparseable timeline) — keep
            // the old size-only behavior rather than re-rendering blind.
            existingDurationOk = true;
            console.log("[render-final] found existing render (no expected duration to verify), size:", existingSize);
          }
        }
      }

      if (existingCheck.stdout.trim() !== "exists" || existingSize < 1000 || !existingDurationOk) {
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

      const errMsg = error instanceof Error ? error.message : "render failed";
      // Distinguish transient errors (timeout, network, download) from
      // permanent failures (remotion render explicitly failed). For transient
      // errors, keep the sandbox alive so a retry can recover the already-
      // rendered video (the recovery check above will find it). Only kill
      // the sandbox for explicit render failures.
      const isTransient = errMsg.includes("timed out")
        || errMsg.includes("timeout")
        || errMsg.includes("ETIMEDOUT")
        || errMsg.includes("ECONNRESET")
        || errMsg.includes("ECONNREFUSED")
        || errMsg.includes("download")
        || errMsg.includes("fetch")
        || errMsg.includes("network");

      if (sandbox && !isTransient) {
        try { await sandbox.kill(); } catch (e) { console.log("[render-final] kill failed:", e); }
      }

      if (isTransient) {
        // Keep status as "rendering" so the user can retry and recover.
        // Do NOT mark as "failed" — the video may already be rendered in the sandbox.
        console.log("[render-final] transient error, keeping sandbox alive for retry");
        await ctx.runMutation(api.tasks.updateRenderProgress, {
          id: projectId,
          step: "retry available",
          details: `transient error: ${errMsg.substring(0, 200)}`,
        });
      } else {
        await ctx.runMutation(api.tasks.updateProjectWithRenderResult, {
          id: projectId,
          error: errMsg,
          status: "failed",
        });
      }

      return {
        success: false,
        error: errMsg,
      };
    }
  },
});

import { query, mutation, action, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { prompts } from "./prompts";
import { requireAuth, requireProjectOwnership } from "./auth";
import { resolveTimelineRevision, validateTimelinePlan, normalizeTimelinePlan } from "./lib/timelinePlan";
import { decideQuota, MAX_USER_MESSAGES_PER_PROJECT } from "./lib/quota";
import type { MutationCtx } from "./_generated/server";

const isImageUrl = (url: string): boolean => {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
  return imageExtensions.some(ext => url.toLowerCase().includes(ext));
};

// ─── Generate Upload URL ────────────────────────────────────────────────────
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// Internal variant for server-side jobs (scheduler-triggered actions have no
// user JWT, so they cannot call the requireAuth-based generateUploadUrl).
export const internalGenerateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// ─── Create Project (sorah-compatible, used by composer.tsx) ────────────────
export const createProject = mutation({
  args: {
    userId: v.optional(v.id("users")),
    prompt: v.string(),
    files: v.array(v.id("_storage")),
    fileMetadata: v.optional(v.array(v.object({
      storageId: v.id("_storage"),
      filename: v.string(),
      contentType: v.string(),
      size: v.number(),
    }))),
    thumbnail: v.optional(v.id("_storage")),
  },
  handler: async (ctx, { userId: _userId, prompt, files, fileMetadata, thumbnail }) => {
    const authUserId = await requireAuth(ctx);
    return await ctx.db.insert("projects", {
      userId: authUserId as Id<"users">,
      prompt,
      files,
      fileMetadata,
      thumbnail: thumbnail || (files.length > 0 ? files[0] : undefined),
      createdAt: Date.now(),
      status: "processing",
    });
  },
});

// ─── Create Chat Project (wordream-app: chat-composer entry point) ──────────
export const createChatProject = mutation({
  args: {
    userId: v.optional(v.id("users")),
    files: v.array(v.id("_storage")),
    fileMetadata: v.optional(v.array(v.object({
      storageId: v.id("_storage"),
      filename: v.string(),
      contentType: v.string(),
      size: v.number(),
    }))),
    thumbnail: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx);
    const projectId = await ctx.db.insert("projects", {
      userId: authUserId as Id<"users">,
      prompt: "",
      files: args.files,
      fileMetadata: args.fileMetadata,
      thumbnail: args.thumbnail || (args.files.length > 0 ? args.files[0] : undefined),
      createdAt: Date.now(),
      status: "draft",
      chatEnabled: true,
      userMessageCount: 0,
    });
    console.log("[chat-project] created:", projectId, "files:", args.files.length, "user:", authUserId);
    return projectId;
  },
});

// ─── Add Files to Project ───────────────────────────────────────────────────
export const addFilesToProject = mutation({
  args: {
    projectId: v.id("projects"),
    files: v.array(v.id("_storage")),
    fileMetadata: v.array(v.object({
      storageId: v.id("_storage"),
      filename: v.string(),
      contentType: v.string(),
      size: v.number(),
    })),
  },
  handler: async (ctx, { projectId, files, fileMetadata }) => {
    await requireProjectOwnership(ctx, projectId);
    const project = await ctx.db.get(projectId);
    if (!project) throw new Error("project not found");

    const updatedFiles = [...project.files, ...files];
    const updatedFileMetadata = [...(project.fileMetadata || []), ...fileMetadata];

    await ctx.db.patch(projectId, {
      files: updatedFiles,
      fileMetadata: updatedFileMetadata,
    });

    return projectId;
  },
});

// ─── Add Chat Message ───────────────────────────────────────────────────────
export const addChatMessage = mutation({
  args: {
    projectId: v.id("projects"),
    // Role whitelist: the client previously passed a free-form string. Only
    // these two roles exist in the product; anything else was data pollution.
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    messageIndex: v.optional(v.number()),
    mediaIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    await requireProjectOwnership(ctx, args.projectId);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("project not found");

    // H7: server-side cap — each user message drives a paid Claude call. The
    // client mirrors this for UX (chat-composer.tsx) but the server is the
    // authority: API-direct calls previously bypassed the cap entirely.
    // Rows are the source of truth (the project counter is display state
    // that forks used to reset). The userMessageCount patch below doubles as
    // the OCC anchor: concurrent sends conflict on the project doc and the
    // retry re-runs this count.
    if (args.role === "user") {
      const existing = await ctx.db
        .query("chatMessages")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect();
      const userCount = existing.filter((m) => m.role === "user").length;
      if (userCount >= MAX_USER_MESSAGES_PER_PROJECT) {
        console.error("[chat] MAX_USER_MESSAGES_REACHED for project:", args.projectId);
        throw new ConvexError({ code: "MAX_USER_MESSAGES_REACHED" });
      }
    }

    const messageId = await ctx.db.insert("chatMessages", {
      projectId: args.projectId,
      role: args.role,
      content: args.content,
      messageIndex: args.messageIndex,
      mediaIds: args.mediaIds,
      createdAt: Date.now(),
    });

    // Increment user message count if user message
    if (args.role === "user") {
      await ctx.db.patch(args.projectId, {
        userMessageCount: (project.userMessageCount || 0) + 1,
        prompt: project.prompt ? project.prompt : args.content,
      });
    }

    return messageId;
  },
});

// ─── Fork Chat Project ──────────────────────────────────────────────────────
export const forkChatProject = mutation({
  args: {
    sourceProjectId: v.id("projects"),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { userId: authUserId } = await requireProjectOwnership(ctx, args.sourceProjectId);
    const original = await ctx.db.get(args.sourceProjectId);
    if (!original) throw new Error("project not found");

    // Copy chat messages — fetched BEFORE the project insert so the fork
    // inherits the REAL conversation, including the user-message count.
    // Previously userMessageCount was hardcoded to 0 on the fork: the copy
    // kept the history but reset the budget, so fork-chains granted a fresh
    // 10-message Claude budget per fork — an unlimited free-Claude loop.
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_project", (q) => q.eq("projectId", args.sourceProjectId))
      .collect();
    const userMessageCount = messages.filter((m) => m.role === "user").length;

    const newProjectId = await ctx.db.insert("projects", {
      userId: authUserId as Id<"users">,
      prompt: original.prompt,
      files: original.files,
      fileMetadata: original.fileMetadata,
      thumbnail: original.thumbnail,
      createdAt: Date.now(),
      status: "draft",
      chatEnabled: true,
      userMessageCount,
      // R3: copy the script + voice settings from the source so the fork is
      // usable even if the frontend flow is interrupted between fork and
      // updateProjectScript. Media assets (audioUrl/videoUrls) are NOT
      // copied: the fork is a fresh start with a new script → the paid
      // pipeline must regenerate them.
      script: original.script,
      voiceSpeed: original.voiceSpeed,
      voiceVolume: original.voiceVolume,
      musicVolume: original.musicVolume,
      originalSoundVolume: original.originalSoundVolume,
      includeVoice: original.includeVoice,
      includeMusic: original.includeMusic,
      includeCaptions: original.includeCaptions,
      includeOriginalSound: original.includeOriginalSound,
    });

    for (const msg of messages) {
      await ctx.db.insert("chatMessages", {
        projectId: newProjectId,
        role: msg.role,
        content: msg.content,
        messageIndex: msg.messageIndex,
        mediaIds: msg.mediaIds,
        createdAt: msg.createdAt,
      });
    }

    return newProjectId;
  },
});

// ─── Update Chat Message ────────────────────────────────────────────────────
export const updateChatMessage = mutation({
  args: {
    messageId: v.id("chatMessages"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    // Ownership check (R1): previously any authenticated user could edit
    // ANYONE's message given its id. Resolve the owning project first.
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error("Message not found");
    await requireProjectOwnership(ctx, message.projectId);
    await ctx.db.patch(args.messageId, {
      content: args.content,
      isEdited: true,
    });
    return { success: true };
  },
});

// ─── Update Chat Project Prompt ─────────────────────────────────────────────
export const updateChatProjectPrompt = mutation({
  args: {
    projectId: v.id("projects"),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    await requireProjectOwnership(ctx, args.projectId);
    await ctx.db.patch(args.projectId, {
      prompt: args.prompt,
    });
    return { success: true };
  },
});

// ─── Get Chat Messages ──────────────────────────────────────────────────────
export const getChatMessages = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectOwnership(ctx, args.projectId);
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .collect();

    // Resolve media URLs for each message
    return Promise.all(
      messages.map(async (msg) => {
        const mediaUrls = msg.mediaIds
          ? await Promise.all(
              msg.mediaIds.map((id) => ctx.storage.getUrl(id))
            )
          : [];
        return {
          ...msg,
          mediaUrls,
        };
      })
    );
  },
});

// ─── Get Projects ───────────────────────────────────────────────────────────
// ─── Get Projects (feed list) ──────────────────────────────────────────────
// H8: light projection for the feed. The old shape spread the ENTIRE project
// document plus a signed URL for EVERY source file of EVERY project — under
// Convex subscription semantics that re-ran on any project change. The feed
// and AppContext consumers use none of the per-file URLs; timelineJson (a
// large field) is only checked for existence, so it is projected to
// hasTimelineJson. take(200) is a guard rail, NOT pagination: real cursor
// pagination (usePaginatedQuery) is deferred until data volume justifies
// rewriting the AppContext full-sync merge model (tracked in the P2 plan).
export const getProjects = query({
  args: {
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", authUserId as Id<"users">))
      .order("desc")
      .take(200);

    return Promise.all(
      projects.map(async (project) => ({
        _id: project._id,
        prompt: project.prompt,
        name: project.name,
        status: project.status,
        createdAt: project.createdAt,
        script: project.script,
        duration: project.duration,
        renderedVideoUrl: project.renderedVideoUrl,
        thumbnailUrl: project.thumbnail
          ? await ctx.storage.getUrl(project.thumbnail)
          : project.thumbnailUrl || null,
        error: project.error,
        renderError: project.renderError,
        sandboxId: project.sandboxId,
        audioUrl: project.audioUrl,
        videoUrls: project.videoUrls,
        hasTimelineJson: project.timelineJson !== undefined,
      }))
    );
  },
});

// ─── Get Project ────────────────────────────────────────────────────────────
// R1 security hardening: previously ANYONE with a project id could read its
// full data (prompt, script, media URLs, rendered video). Now requires
// auth + ownership. Foreign and missing projects both return null so the
// "null = not visible" shape is unchanged for every existing caller.
export const getProject = query({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    const project = await ctx.db.get(id);
    if (!project) return null;

    const userId = await requireAuth(ctx);
    if (project.userId !== userId) return null;

    return {
      ...project,
      fileUrls: await Promise.all(
        project.files.map((fileId) => ctx.storage.getUrl(fileId))
      ),
      thumbnailUrl: project.thumbnail
        ? await ctx.storage.getUrl(project.thumbnail)
        : project.thumbnailUrl || null,
    };
  },
});

// ─── Internal: Get Project (server jobs) ──────────────────────────────────
// Server-side variant for scheduler-triggered actions (no user JWT):
// generateMediaAssets reads the project directly; ownership was already
// validated at submit time by markProjectSubmitted, so no re-check here.
// internalQuery = unreachable from the client.
export const internalGetProject = internalQuery({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    const project = await ctx.db.get(id);
    if (!project) return null;

    return {
      ...project,
      fileUrls: await Promise.all(
        project.files.map((fileId) => ctx.storage.getUrl(fileId))
      ),
      thumbnailUrl: project.thumbnail
        ? await ctx.storage.getUrl(project.thumbnail)
        : project.thumbnailUrl || null,
    };
  },
});

// ─── Get Storage URL ────────────────────────────────────────────────────────
export const getStorageUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

// ─── Delete Project ─────────────────────────────────────────────────────────
export const deleteProject = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    await requireProjectOwnership(ctx, id);
    // Delete associated chat messages
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const msg of messages) {
      await ctx.db.delete(msg._id);
    }

    // R3: cascade-delete timeline history + edit manifests. Previously these
    // rows were orphaned on every project deletion and accumulated forever
    // (pure DB bloat; storage files may be shared with forked projects, so
    // they are intentionally NOT deleted here).
    const timelineRows = await ctx.db
      .query("timelines")
      .withIndex("by_project", (q) => q.eq("projectId", id))
      .collect();
    for (const row of timelineRows) {
      await ctx.db.delete(row._id);
    }

    const manifestRows = await ctx.db
      .query("editManifests")
      .withIndex("by_project_revision", (q) => q.eq("projectId", id))
      .collect();
    for (const row of manifestRows) {
      await ctx.db.delete(row._id);
    }

    await ctx.db.delete(id);
    return id;
  },
});

// ─── Update Project Script ──────────────────────────────────────────────────
export const updateProjectScript = mutation({
  args: {
    id: v.id("projects"),
    script: v.string(),
  },
  handler: async (ctx, { id, script }) => {
    await requireProjectOwnership(ctx, id);
    await ctx.db.patch(id, { script });
    return { id, script };
  },
});

// ─── Shared paid-pipeline quota gate (P0-1 / P0-2) ──────────────────────────
// Used by markProjectSubmitted AND regenerateProjectEditing so every entry
// into the paid pipeline passes the SAME gate (the regenerate path previously
// had none at all — an unlimited free-pipeline backdoor). Returns the charge
// record to stamp on the project. Throws FREE_TIER_LIMIT_REACHED when the
// free tier is exhausted and no credits remain (the client maps this to
// /paywall on both paths).
//
// Adversarial review S2: EVERY decision path patches the user doc —
// lifetimeGeneratedCount++ and/or the credit deduction. That write is the
// OCC anchor: two concurrent gates for the same user conflict on the user
// document and Convex retries the loser, which re-reads the bumped counter.
// A gate that only reads would reintroduce the free-tier TOCTOU.
//
// Adversarial review H1: legacy accounts (pre-counter) fall back to the row
// count at gate time and self-backfill; from this submission on the counter
// is authoritative and deleting projects can never shrink it again.
async function applyPaidPipelineGate(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<{ creditCharged: boolean; creditSource: "subscription" | "purchased" | undefined }> {
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("user not found");

  let lifetimeGenerated = user.lifetimeGeneratedCount;
  if (lifetimeGenerated === undefined) {
    const allProjects = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    lifetimeGenerated = allProjects.filter(
      (p) =>
        p.status === "completed" ||
        p.status === "rendering" ||
        p.status === "processing",
    ).length;
  }

  const decision = decideQuota({
    isPremium: user.isPremium || false,
    subscriptionCredits: user.subscriptionCreditsRemaining || 0,
    purchasedCredits: user.purchasedCredits || 0,
    lifetimeGenerated,
  });

  switch (decision.action) {
    case "reject":
      console.error("[quota-gate] FREE_TIER_LIMIT_REACHED for user:", userId);
      // Structured error (M16): the client matches the code via
      // lib/convexErrors.ts getErrorCode() — no more message-string sniffing.
      throw new ConvexError({ code: "FREE_TIER_LIMIT_REACHED" });
    case "premium":
      console.log("[quota-gate] premium user, no credit deduction");
      await ctx.db.patch(userId, { lifetimeGeneratedCount: lifetimeGenerated + 1 });
      return { creditCharged: false, creditSource: undefined };
    case "charge": {
      const creditSource = decision.source;
      console.log("[quota-gate] deducting 1 credit (source:", creditSource + ")");
      const creditPatch =
        creditSource === "subscription"
          ? { subscriptionCreditsRemaining: (user.subscriptionCreditsRemaining || 0) - 1 }
          : { purchasedCredits: (user.purchasedCredits || 0) - 1 };
      await ctx.db.patch(userId, {
        ...creditPatch,
        lifetimeGeneratedCount: lifetimeGenerated + 1,
      });
      return { creditCharged: true, creditSource };
    }
    case "free":
      await ctx.db.patch(userId, { lifetimeGeneratedCount: lifetimeGenerated + 1 });
      return { creditCharged: false, creditSource: undefined };
  }
}

// ─── Mark Project Submitted ─────────────────────────────────────────────────
export const markProjectSubmitted = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    await requireProjectOwnership(ctx, id);
    const project = await ctx.db.get(id);
    if (!project) throw new Error("project not found");
    console.log("[submit] project:", id, "status:", project.status, "hasScript:", !!project.script);

    // Idempotency: only allow submission from draft/script_generating status
    if (project.status === "processing" || project.status === "rendering") {
      console.log("[submit] already submitted, skipping:", id);
      return { id, alreadySubmitted: true };
    }

    // ── Server-side quota gate + atomic credit deduction (R2 / P0-1) ────
    // Shared with regenerateProjectEditing via applyPaidPipelineGate +
    // convex/lib/quota.ts. The lifetime counter replaces the row-count
    // check (deleting a project used to reset the free tier) and every
    // decision path patches the user doc — the OCC anchor that serializes
    // concurrent submissions for the same user. The previous TOCTOU fix
    // relied on "processing" rows being visible to the next mutation; the
    // user-doc write is stronger and now also covers the regenerate path.
    //
    // Credit model (product semantics frozen by adversarial review H3):
    //   Premium → unlimited, no deduction.
    //   Free → first 3 paid-pipeline entries free; 4th+ costs 1 credit,
    //          charged subscription-first, deducted atomically HERE.
    //   Free + 0 credits → FREE_TIER_LIMIT_REACHED.
    const { creditCharged, creditSource } = project.userId
      ? await applyPaidPipelineGate(ctx, project.userId)
      : { creditCharged: false, creditSource: undefined };

    await ctx.db.patch(id, {
      submittedAt: Date.now(),
      status: "processing",
      creditCharged,
      creditSource,
    });
    console.log("[submit] status -> processing, creditCharged:", creditCharged);
    // Server-side scheduling: no longer relies on client fire-and-forget.
    // generateMediaAssets is an internalAction (R1): previously public with
    // NO auth — anyone could trigger the full paid pipeline (TTS + music +
    // Kling animation) on ANY project id.
    await ctx.scheduler.runAfter(0, internal.tasks.generateMediaAssets, {
      projectId: id,
    });
    console.log("[submit] scheduled generateMediaAssets for:", id);
    return { id };
  },
});

// ─── Regenerate Script ──────────────────────────────────────────────────────
export const regenerateScript = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, { projectId }): Promise<{ success: boolean; script?: string; error?: string }> => {
    const authUserId = await requireAuth(ctx);
    try {
      const project = await ctx.runQuery(api.tasks.getProject, { id: projectId });
      if (!project) throw new Error("project not found");
      if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");

      let style = "professional";
      if (project.userId) {
        const user = await ctx.runQuery(api.users.getCurrentUser, { userId: project.userId });
        if (user?.preferredStyle) style = user.preferredStyle;
      }

      const fileUrls = project.fileUrls?.filter((url: string | null): url is string => url !== null) || [];
      const scriptResult = await ctx.runAction(api.aiServices.generateScript, {
        prompt: project.prompt,
        imageUrls: fileUrls,
        style,
      });

      if (!scriptResult.success) {
        throw new Error(`script generation failed: ${scriptResult.error}`);
      }

      await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
        id: projectId,
        script: scriptResult.script,
        status: "completed",
      });

      return { success: true, script: scriptResult.script };
    } catch (error) {
      await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
        id: projectId,
        error: error instanceof Error ? error.message : "script regeneration failed",
        status: "failed",
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "script regeneration failed",
      };
    }
  },
});

// ─── Update Project Status ──────────────────────────────────────────────────
// internalMutation (R1): previously public with NO auth — anyone could flip
// any project to any status, breaking renders or unlocking paid pipelines.
export const updateProjectStatus = internalMutation({
  args: {
    id: v.id("projects"),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("rendering"),
      v.literal("draft"),
      v.literal("script_generating")
    ),
  },
  handler: async (ctx, { id, status }) => {
    await ctx.db.patch(id, { status });
    return id;
  },
});

// ─── Update Project with Wordream Data ─────────────────────────────────────
// internalMutation (R1): previously public — anyone could overwrite any
// project's script/audio/video assets.
export const updateProjectWithReelfulData = internalMutation({
  args: {
    id: v.id("projects"),
    script: v.optional(v.string()),
    audioUrl: v.optional(v.string()),
    srtContent: v.optional(v.string()),
    musicUrl: v.optional(v.string()),
    videoUrls: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("processing"), v.literal("draft")),
  },
  handler: async (ctx, { id, script, audioUrl, srtContent, musicUrl, videoUrls, error, status }) => {
    const updateData: any = {
      status,
      script,
      audioUrl,
      srtContent,
      musicUrl,
      videoUrls,
      error,
    };

    if (status === "completed" || status === "failed") {
      updateData.completedAt = Date.now();
    }

    await ctx.db.patch(id, updateData);
    return id;
  },
});

// ─── Update Project with Render Result ──────────────────────────────────────
// internalMutation (R1): previously public — anyone could mark any project
// completed with an arbitrary video URL (content injection into feeds).
export const updateProjectWithRenderResult = internalMutation({
  args: {
    id: v.id("projects"),
    renderedVideoUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    status: v.union(v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, { id, renderedVideoUrl, error, status }) => {
    await ctx.db.patch(id, {
      status,
      renderedVideoUrl,
      error,
      completedAt: Date.now(),
      renderProgress: undefined,
    });
    return id;
  },
});

// ─── Update Render Progress ─────────────────────────────────────────────────
// internalMutation (R1): previously public with NO auth.
export const updateRenderProgress = internalMutation({
  args: {
    id: v.id("projects"),
    step: v.string(),
    details: v.optional(v.string()),
  },
  handler: async (ctx, { id, step, details }) => {
    await ctx.db.patch(id, {
      renderProgress: {
        step,
        details,
        timestamp: Date.now(),
      },
    });
    return id;
  },
});

// ─── Try Acquire Render Lock (atomic) ───────────────────────────────────────
// Atomically checks if project is already rendering; if so, returns false.
// If not, sets status to "rendering" and returns true.
// This prevents duplicate renderVideo calls from creating multiple sandboxes.
// internalMutation (R1): previously public — anyone could lock any project
// into "rendering" and permanently block its Branch B rebuild path.
export const tryAcquireRenderLock = internalMutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    const project = await ctx.db.get(id);
    if (!project) {
      return { success: false, error: "project not found" };
    }
    if (project.status === "rendering") {
      // STALE LOCK RECOVERY (P0-4, mirrors internalTryRenderFinalLock): a
      // Convex action crash/restart mid-sequence-render leaves status
      // "rendering" forever with no one left to release it — the project
      // used to deadlock permanently. Locks older than 15 minutes are
      // stale and force-reacquired. Legacy locks WITHOUT renderLockedAt
      // (created before this field existed) are treated as stale too, so
      // already-stuck projects self-heal on the next attempt.
      const RENDER_LOCK_STALE_MS = 15 * 60 * 1000; // 15 minutes
      const lockAge = Date.now() - (project.renderLockedAt ?? 0);
      if (project.renderLockedAt && lockAge < RENDER_LOCK_STALE_MS) {
        return { success: false, error: "already rendering" };
      }
      console.warn(
        `[render-lock] Stale sequence lock (${
          project.renderLockedAt ? `${(lockAge / 1000 / 60).toFixed(1)}min old` : "legacy, no timestamp"
        }), force-acquiring`,
      );
    }
    if (project.renderedVideoUrl) {
      return { success: false, error: "already rendered" };
    }
    // Atomically set status to rendering + stamp the lock time
    await ctx.db.patch(id, { status: "rendering", renderLockedAt: Date.now() });
    return { success: true };
  },
});

// ─── Update Project Sandbox ─────────────────────────────────────────────
// internalMutation (R1): previously public — anyone could bind an arbitrary
// sandbox id to any project and hijack its render flow.
export const updateProjectSandbox = internalMutation({
  args: {
    id: v.id("projects"),
    // Optional so a dead sandbox can be cleared (undefined deletes the field).
    sandboxId: v.optional(v.string()),
  },
  handler: async (ctx, { id, sandboxId }) => {
    await ctx.db.patch(id, { sandboxId });
    return id;
  },
});

// ─── Try Acquire Render-Final Lock (atomic) ──────────────────────────────────
// R4 (M7): prevents two devices/tabs from calling renderFinalVideo on the
// same project concurrently — both would connect to the same E2B sandbox
// and `bun remotion render` would corrupt the output file. Atomically
// checks renderProgress.step and claims the slot in one mutation. The lock
// auto-releases: success and failure paths both overwrite renderProgress.
//
// STALE LOCK RECOVERY: if a Convex action times out or the platform
// restarts mid-render, the catch block never runs and renderProgress
// stays at "rendering video" forever. To prevent permanent deadlock,
// we treat any lock older than RENDER_LOCK_STALE_MS as stale and
// force-acquire it. 15 minutes is generous for a Remotion render that
// typically completes in 1-3 minutes.
export const internalTryRenderFinalLock = internalMutation({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, { projectId }): Promise<{ ok: boolean; error?: string }> => {
    const project = await ctx.db.get(projectId);
    if (!project) return { ok: false, error: "project not found" };
    if (project.renderProgress?.step === "rendering video") {
      const lockAge = Date.now() - (project.renderProgress.timestamp ?? 0);
      const RENDER_LOCK_STALE_MS = 15 * 60 * 1000; // 15 minutes
      if (lockAge < RENDER_LOCK_STALE_MS) {
        return { ok: false, error: "render already in progress" };
      }
      // Stale lock — force acquire. The previous render action was
      // killed by the platform; its catch block never ran.
      console.warn(
        `[render-lock] Stale lock detected (${(lockAge / 1000 / 60).toFixed(1)}min old), force-acquiring`,
      );
    }
    await ctx.db.patch(projectId, {
      renderProgress: {
        step: "rendering video",
        details: "starting final render",
        timestamp: Date.now(),
      },
    });
    return { ok: true };
  },
});

// ─── Internal: Mark Credit Refunded (refund idempotency, P0-3) ──────────────
// generateMediaAssets refunds a charged credit on pipeline failure. The
// refund MUST also clear projects.creditCharged in the same failure flow:
// a failed project passes markProjectSubmitted's idempotency check (only
// processing/rendering are blocked), so a resubmit charges AGAIN; and if
// the flag stayed true, a second pipeline failure would refund AGAIN off
// the stale flag — multiple refunds for one charge.
export const internalMarkCreditRefunded = internalMutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { creditCharged: false });
    return id;
  },
});

// ─── Timeline Revisions (optimistic locking + audit history) ────────────────
// Every timeline write appends a row to `timelines` and bumps
// projects.timelineRevision. Writers pass the revision they LOADED as
// baseRevision; a mismatch means someone else saved first (two devices,
// or a user edit racing an automated rebuild) and the stale write is
// rejected instead of silently clobbering the newer timeline.
export const saveTimelineRevision = mutation({
  args: {
    projectId: v.id("projects"),
    baseRevision: v.number(),
    timelineJson: v.string(),
    source: v.union(v.literal("ai"), v.literal("user"), v.literal("system")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, baseRevision, timelineJson, source, note }): Promise<
    { success: true; revision: number }
    | { success: false; conflict: true; currentRevision: number }
    | { success: false; conflict?: undefined; error: string }
  > => {
    await requireProjectOwnership(ctx, projectId);
    try {
      const project = await ctx.db.get(projectId);
      if (!project) throw new Error("project not found");

      const check = resolveTimelineRevision(project.timelineRevision, baseRevision);
      if (!check.ok) {
        return { success: false, conflict: true, currentRevision: check.currentRevision };
      }

      await ctx.db.insert("timelines", {
        projectId,
        revision: check.nextRevision,
        timelineJson,
        source,
        note: note ?? undefined,
        createdAt: Date.now(),
      });
      await ctx.db.patch(projectId, {
        timelineJson,
        timelineRevision: check.nextRevision,
      });
      return { success: true, revision: check.nextRevision };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "failed to save timeline" };
    }
  },
});

// Timeline lineage for a project (newest first). The timelineJson payload is
// intentionally omitted — fetch a specific revision if you need the content.
export const getTimelineHistory = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await requireProjectOwnership(ctx, projectId);
    const rows = await ctx.db
      .query("timelines")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(50);
    return rows.map(r => ({
      revision: r.revision,
      source: r.source,
      note: r.note ?? null,
      createdAt: r.createdAt,
    }));
  },
});

// ─── Update Project Voice Speed ─────────────────────────────────────────────
export const updateProjectVoiceSpeed = mutation({
  args: {
    id: v.id("projects"),
    voiceSpeed: v.number(),
  },
  handler: async (ctx, { id, voiceSpeed }) => {
    await requireProjectOwnership(ctx, id);
    await ctx.db.patch(id, { voiceSpeed });
    return { id };
  },
});

// ─── Update Project Keep Order ──────────────────────────────────────────────
export const updateProjectKeepOrder = mutation({
  args: {
    id: v.id("projects"),
    keepOrder: v.boolean(),
  },
  handler: async (ctx, { id, keepOrder }) => {
    await requireProjectOwnership(ctx, id);
    await ctx.db.patch(id, { keepOrder });
    return { id };
  },
});

// ─── Regenerate Project Editing ─────────────────────────────────────────────
// Creates a new project sharing the source's media assets (voiceover, music,
// animated clips) and asks the pipeline for a FRESH Claude edit plan.
// The old version set status "processing" but copied NO media assets and no
// scheduler ever picked the project up — it deadlocked in the feed showing
// "processing" forever (audit M5).
//
// The fix: copy ALL media asset fields (they are the expensive outputs —
// TTS + music + Kling are already paid for and identical for a re-edit)
// and set status to "completed" WITHOUT timelineJson. The polling service's
// Priority 3 branch then triggers createSequence → a new Claude run.
export const regenerateProjectEditing = mutation({
  args: {
    sourceProjectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    await requireProjectOwnership(ctx, args.sourceProjectId);
    const original = await ctx.db.get(args.sourceProjectId);
    if (!original) throw new Error("project not found");
    if (!original.userId) throw new Error("project has no owner");

    // ── P0-1: same billing gate as markProjectSubmitted ─────────────────
    // Every regenerated fork enters the full paid pipeline (fresh Claude
    // edit + E2B + Remotion) via the client polling service's Priority 3
    // (status "completed" + media assets + no timelineJson). Previously
    // this mutation had NO quota check and NO credit deduction — an
    // unlimited free-pipeline backdoor with two UI entries. The client
    // already maps FREE_TIER_LIMIT_REACHED to /paywall on both paths.
    const { creditCharged, creditSource } = await applyPaidPipelineGate(ctx, original.userId);

    const newProjectId = await ctx.db.insert("projects", {
      userId: original.userId,
      prompt: original.prompt,
      files: original.files,
      fileMetadata: original.fileMetadata,
      thumbnail: original.thumbnail,
      createdAt: Date.now(),
      // "completed" + media assets + no timelineJson = the polling
      // service's Priority 3 picks it up and runs a fresh Claude edit.
      status: "completed",
      script: original.script,
      audioUrl: original.audioUrl,
      srtContent: original.srtContent,
      musicUrl: original.musicUrl,
      videoUrls: original.videoUrls,
      voiceSpeed: original.voiceSpeed,
      voiceVolume: original.voiceVolume,
      musicVolume: original.musicVolume,
      originalSoundVolume: original.originalSoundVolume,
      includeVoice: original.includeVoice,
      includeMusic: original.includeMusic,
      includeCaptions: original.includeCaptions,
      includeOriginalSound: original.includeOriginalSound,
      renderStep: "not_started",
      renderError: undefined,
      creditCharged,
      creditSource,
    });

    return { success: true, newProjectId };
  },
});

// ─── Refresh Project R2 URLs ────────────────────────────────────────────────
export const refreshProjectR2Urls = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx);
    const project = await ctx.runQuery(api.tasks.getProject, { id: args.projectId });
    if (!project) throw new Error("Project not found");
    if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");
    // In minimal backend, just return success
    // Full implementation would refresh expired R2 URLs
    return { success: true };
  },
});

// ─── Import R2 File to Convex Storage ───────────────────────────────────────
// Called by the frontend after uploading a file to R2 (or Convex storage in fallback mode).
// Frontend passes: { r2Url, r2Key, contentType, storageId? }
// Returns: { storageId } on success
//
// In fallback mode (no R2), the frontend uploads to Convex storage directly
// and extracts storageId from the upload response. It passes storageId here
// so we just return it.
// In real R2 mode, storageId is not passed, so we fetch from r2Url and store.
export const importR2FileToConvexStorage = action({
  args: {
    r2Url: v.optional(v.string()),
    r2Key: v.string(),
    contentType: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    // Fallback mode: frontend already uploaded to Convex storage and extracted storageId
    if (args.storageId) {
      return { storageId: args.storageId };
    }

    // Real R2 mode: fetch file from R2 URL and store in Convex storage
    if (args.r2Url) {
      try {
        const response = await fetch(args.r2Url);
        if (!response.ok) {
          return { success: false, error: `Failed to fetch from R2: ${response.statusText}` };
        }
        // R4 (M1): cap the imported file at 200 MB. Without this, an
        // authenticated user could store arbitrarily large files in Convex
        // storage (a storage-cost / memory-exhaustion vector). 200 MB is
        // generous for the app's short-form video/image/audio use case.
        const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
        const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
        if (contentLength > MAX_IMPORT_BYTES) {
          return { success: false, error: `File too large (${(contentLength / 1024 / 1024).toFixed(0)} MB, max 200 MB)` };
        }
        const blob = await response.blob();
        if (blob.size > MAX_IMPORT_BYTES) {
          return { success: false, error: `File too large (${(blob.size / 1024 / 1024).toFixed(0)} MB, max 200 MB)` };
        }
        const storageId = await ctx.storage.store(blob);
        return { storageId };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to import from R2",
        };
      }
    }

    return {
      success: false,
      error: "Either storageId or r2Url must be provided",
    };
  },
});

// ─── Get Fresh Project Video URL ────────────────────────────────────────────
export const getFreshProjectVideoUrl = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args): Promise<string | null> => {
    const authUserId = await requireAuth(ctx);
    const project = await ctx.runQuery(api.tasks.getProject, { id: args.projectId });
    if (!project) return null;
    if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");
    return project.renderedVideoUrl || null;
  },
});

// ─── Get Video Variant ──────────────────────────────────────────────────────
export const getVideoVariant = action({
  args: {
    projectId: v.id("projects"),
    includeVoice: v.boolean(),
    includeMusic: v.boolean(),
    includeCaptions: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; url?: string; cached?: boolean; error?: string }> => {
    const authUserId = await requireAuth(ctx);
    const project = await ctx.runQuery(api.tasks.getProject, { id: args.projectId });
    if (!project || !project.renderedVideoUrl) {
      return { success: false, error: "No video available" };
    }
    if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");
    // Minimal: return the rendered video URL
    return {
      success: true,
      url: project.renderedVideoUrl,
      cached: true,
    };
  },
});

// ─── Get Project Preview Assets ─────────────────────────────────────────────
// Audio settings are read from the timeline (the single source of truth,
// same values generate-composition.ts bakes into the render). Project-level
// fields remain ONLY as a legacy-row fallback — they are not updated by
// editor saves and must never take precedence over the timeline.
export const getProjectPreviewAssets = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; baseVideoUrl: string | null; voiceAudioUrl: string | null; musicAudioUrl: string | null; watermarkUrl: string | null; voiceSpeed: number; voiceVolume: number; musicVolume: number; originalSoundVolume: number; includeVoice: boolean; includeMusic: boolean; includeCaptions: boolean; includeOriginalSound: boolean; error?: string }> => {
    const authUserId = await requireAuth(ctx);
    const project = await ctx.runQuery(api.tasks.getProject, { id: args.projectId });
    if (!project) {
      return {
        success: false,
        baseVideoUrl: null,
        voiceAudioUrl: null,
        musicAudioUrl: null,
        watermarkUrl: null,
        voiceSpeed: 1.0,
        voiceVolume: 1.0,
        musicVolume: 0.1,
        originalSoundVolume: 0.0,
        includeVoice: true,
        includeMusic: true,
        includeCaptions: true,
        includeOriginalSound: false,
        error: "Project not found",
      };
    }
    if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");

    // Parse the timeline; fall back to project fields only if it is absent
    // or unparseable (legacy rows).
    let tl: any = null;
    if (project.timelineJson) {
      try { tl = JSON.parse(project.timelineJson); } catch { /* legacy fallback below */ }
    }
    const audio = tl?.audio;
    const subs = tl?.subtitles;

    const includeVoice = audio?.includeVoice ?? project.includeVoice ?? true;
    const includeMusic = audio?.includeMusic ?? project.includeMusic ?? true;
    const includeCaptions = subs?.includeCaptions ?? project.includeCaptions ?? true;
    const includeOriginalSound =
      audio?.includeOriginalSound ?? project.includeOriginalSound ?? false;
    // Mirror generate-composition.ts exactly: original sound is muted (0)
    // unless the track is explicitly enabled.
    const originalSoundVolume = includeOriginalSound
      ? (audio?.originalSoundVolume ?? project.originalSoundVolume ?? 1.0)
      : 0;

    return {
      success: true,
      baseVideoUrl: project.renderedVideoUrl || null,
      voiceAudioUrl: project.audioUrl || null,
      musicAudioUrl: project.musicUrl || null,
      watermarkUrl: null,
      // NOTE: "voiceSpeed" here is the PREVIEW PLAYBACK RATE for the voice
      // track. The TTS speed (project.voiceSpeed) is already baked into the
      // audio file at generation time and must NEVER be applied again —
      // audio.playbackRate from the timeline is the only valid source.
      voiceSpeed: audio?.playbackRate ?? 1.0,
      voiceVolume: audio?.voiceVolume ?? project.voiceVolume ?? 1.0,
      musicVolume: audio?.musicVolume ?? project.musicVolume ?? 0.1,
      originalSoundVolume,
      includeVoice,
      includeMusic,
      includeCaptions,
      includeOriginalSound,
    };
  },
});

// ─── Get Project Editor Data ────────────────────────────────────────────────
export const getProjectEditorData = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; clipUrls?: Record<string, string>; videoUrls?: string[]; fileUrls?: string[]; fileMetadata?: any[]; musicVolume?: number; baseVideoUrl?: string | null; renderedVideoUrl?: string | null; timeline?: any; timelineRevision?: number; duration?: number; voiceAudioUrl?: string | null; musicAudioUrl?: string | null; assContent?: string; srtContent?: string; voiceSpeed?: number; voiceVolume?: number; originalSoundVolume?: number; includeVoice?: boolean; includeMusic?: boolean; includeCaptions?: boolean; includeOriginalSound?: boolean; error?: string }> => {
    const authUserId = await requireAuth(ctx);
    const project = await ctx.runQuery(api.tasks.getProject, { id: args.projectId });
    if (!project) {
      return { success: false, error: "Project not found" };
    }
    if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");

    // Build clipUrls: map storageId → file URL for each file
    const clipUrls: Record<string, string> = {};
    const fileUrls = project.fileUrls || [];
    const fileMetadata = project.fileMetadata || [];
    for (let i = 0; i < fileMetadata.length; i++) {
      const meta = fileMetadata[i];
      if (meta && fileUrls[i]) {
        clipUrls[meta.filename] = fileUrls[i] as string;
      }
    }

    // Parse timeline JSON if present
    let timeline: any = undefined;
    if (project.timelineJson) {
      try {
        timeline = JSON.parse(project.timelineJson);
      } catch {
        // Keep timeline undefined if parse fails
      }
    }

    return {
      success: true,
      clipUrls,
      videoUrls: project.videoUrls || [],
      fileUrls: fileUrls as string[],
      fileMetadata: fileMetadata as any[],
      musicVolume: project.musicVolume ?? 0.1,
      baseVideoUrl: project.renderedVideoUrl || null,
      renderedVideoUrl: project.renderedVideoUrl || null,
      timeline,
      // Revision snapshot for optimistic locking: the editor passes this
      // back as baseRevision when saving.
      timelineRevision: project.timelineRevision ?? 0,
      duration: project.duration ?? 10,
      voiceAudioUrl: project.audioUrl || null,
      musicAudioUrl: project.musicUrl || null,
      assContent: project.assContent,
      srtContent: project.srtContent,
      voiceSpeed: project.voiceSpeed ?? 1.0,
      voiceVolume: project.voiceVolume ?? 1.0,
      originalSoundVolume: project.originalSoundVolume ?? 0.0,
      includeVoice: project.includeVoice ?? true,
      includeMusic: project.includeMusic ?? true,
      includeCaptions: project.includeCaptions ?? true,
      includeOriginalSound: project.includeOriginalSound ?? false,
    };
  },
});

// ─── Save Editor Changes ────────────────────────────────────────────────────
// Saves timeline/ASS to the original project, then creates a fork for re-rendering.
// Previously an action calling two deleted mutations; rewritten as a single mutation.
// The save is guarded by a timeline revision optimistic lock: the client passes
// the revision it loaded (baseRevision); if the project moved on meanwhile the
// save is rejected with conflict=true so the editor can prompt a refresh.
export const saveEditorChanges = mutation({
  args: {
    projectId: v.id("projects"),
    timelineJson: v.string(),
    assContent: v.optional(v.string()),
    baseRevision: v.number(),
    // The op stream from the editor's opLog (batch 3b). Optional only to keep
    // the call site upgrade flexible; the editor always sends it.
    operationsJson: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, timelineJson, assContent, baseRevision, operationsJson }): Promise<{ success: boolean; newProjectId?: Id<"projects">; revision?: number; conflict?: boolean; currentRevision?: number; error?: string }> => {
    await requireProjectOwnership(ctx, projectId);
    try {
      const original = await ctx.db.get(projectId);
      if (!original) throw new Error("project not found");
      console.log("[editor-save] project:", projectId, "baseRevision:", baseRevision, "timeline length:", timelineJson.length, "currentRev:", original.timelineRevision ?? 0);

      // 0. Optimistic-lock check — reject stale writes instead of clobbering
      const check = resolveTimelineRevision(original.timelineRevision, baseRevision);
      if (!check.ok) {
        console.warn("[editor-save] revision conflict, base:", baseRevision, "current:", check.currentRevision);
        return {
          success: false,
          conflict: true,
          currentRevision: check.currentRevision,
        };
      }

      // 1. Save timeline/ASS to the original project (preserves editor state)
      //    and record the revision in the history table.
      //
      // Validate the timeline BEFORE creating the fork — a malformed timeline
      // would pass the save but fail in createSequence Branch B, leaving a
      // dead fork project in the user's gallery. We skip the media-listing
      // cross-check (no sandbox here) but catch structural/numeric errors.
      const validation = validateTimelinePlan(timelineJson);
      if (!validation.ok) {
        console.error("[editor-save] timeline validation failed:", validation.error);
        return { success: false, error: `timeline validation failed: ${validation.error}` };
      }
      console.log("[editor-save] timeline validation passed, revision:", check.nextRevision);

      // Ingestion normalization (review P1-6): the stored timeline is the
      // single source of truth for every consumer, so it must always be
      // self-sufficient. The editor writes complete blocks (no-op here),
      // but this guarantees the invariant for any writer.
      const normalizedTimelineJson = JSON.stringify(
        normalizeTimelinePlan(JSON.parse(timelineJson))
      );

      await ctx.db.insert("timelines", {
        projectId,
        revision: check.nextRevision,
        timelineJson: normalizedTimelineJson,
        source: "user",
        note: "editor save",
        createdAt: Date.now(),
      });
      await ctx.db.patch(projectId, {
        timelineJson: normalizedTimelineJson,
        timelineRevision: check.nextRevision,
        assContent: assContent ?? original.assContent,
      });

      // 2. Create a new project fork for re-rendering.
      //    The fork inherits the revision it was forked from; its own history
      //    table starts with a single row mirroring the parent's latest save
      //    so that getTimelineHistory(forkId) returns a non-empty lineage.
      const newProjectId = await ctx.db.insert("projects", {
        userId: original.userId,
        prompt: original.prompt,
        files: original.files,
        fileMetadata: original.fileMetadata,
        thumbnail: original.thumbnail,
        thumbnailUrl: original.thumbnailUrl,
        createdAt: Date.now(),
        status: "processing",
        script: original.script,
        audioUrl: original.audioUrl,
        srtContent: original.srtContent,
        musicUrl: original.musicUrl,
        videoUrls: original.videoUrls,
        timelineJson: normalizedTimelineJson,
        timelineRevision: check.nextRevision,
        assContent: assContent ?? original.assContent,
        mediaDescriptions: original.mediaDescriptions,
        voiceSpeed: original.voiceSpeed,
        voiceVolume: original.voiceVolume,
        musicVolume: original.musicVolume,
        originalSoundVolume: original.originalSoundVolume,
        includeVoice: original.includeVoice,
        includeMusic: original.includeMusic,
        includeCaptions: original.includeCaptions,
        includeOriginalSound: original.includeOriginalSound,
        renderStep: "not_started",
        renderError: undefined,
      });

      // 2b. Seed the fork's timeline history so its lineage is complete.
      //     Without this, getTimelineHistory(forkId) returns empty despite
      //     fork.timelineRevision being N+1, breaking audit/rollback.
      console.log("[editor-save] fork created:", newProjectId, "revision:", check.nextRevision);
      await ctx.db.insert("timelines", {
        projectId: newProjectId,
        revision: check.nextRevision,
        timelineJson: normalizedTimelineJson,
        source: "user",
        note: "fork from parent",
        createdAt: Date.now(),
      });

      // 3. Persist the edit manifest (op stream) for this revision.
      //    Keyed by (projectId, nextRevision) so the lineage is queryable.
      //    Write to BOTH the original project and the fork so each has
      //    its own auditable operation history.
      if (operationsJson) {
        try {
          const parsed = JSON.parse(operationsJson);
          if (Array.isArray(parsed)) {
            // Original project manifest (upsert)
            const existing = await ctx.db
              .query("editManifests")
              .withIndex("by_project_revision", (q) => q.eq("projectId", projectId).eq("revision", check.nextRevision))
              .first();
            if (existing) {
              await ctx.db.patch(existing._id, { operationsJson, opCount: parsed.length, createdAt: Date.now() });
            } else {
              await ctx.db.insert("editManifests", {
                projectId,
                revision: check.nextRevision,
                operationsJson,
                opCount: parsed.length,
                createdAt: Date.now(),
              });
            }
            // Fork project manifest (always insert — fork is new)
            await ctx.db.insert("editManifests", {
              projectId: newProjectId,
              revision: check.nextRevision,
              operationsJson,
              opCount: parsed.length,
              createdAt: Date.now(),
            });
          }
        } catch {
          // manifest is best-effort audit; don't fail the save over a bad op log
        }
      }

      return { success: true, newProjectId, revision: check.nextRevision };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to save editor changes",
      };
    }
  },
});

// ─── Update Timeline Audio Settings (review P0-1a) ──────────────────────────
// Persists the sequence-preview toggles (voice / music / captions) into the
// timeline BEFORE the first render, so what the user auditioned is exactly
// what gets baked (WYSIWYG). This is a REAL timeline edit — revision bumps,
// history row recorded — but unlike saveEditorChanges it patches the current
// project in place (no fork): it only flips track flags, never touches
// segments, so a re-render is not required for lineage purposes.
export const updateTimelineAudioSettings = mutation({
  args: {
    projectId: v.id("projects"),
    includeVoice: v.boolean(),
    includeMusic: v.boolean(),
    includeCaptions: v.boolean(),
    baseRevision: v.number(),
  },
  handler: async (ctx, { projectId, includeVoice, includeMusic, includeCaptions, baseRevision }): Promise<{ success: boolean; revision?: number; conflict?: boolean; currentRevision?: number; error?: string }> => {
    await requireProjectOwnership(ctx, projectId);
    try {
      const project = await ctx.db.get(projectId);
      if (!project) throw new Error("project not found");
      if (!project.timelineJson) throw new Error("no timeline to update");
      // Guard: a rendered project's artifact is immutable — toggles belong
      // to the pre-render audition (and post-render they are playback-only).
      if (project.renderedVideoUrl) throw new Error("video already rendered — use the editor and re-render instead");
      // Guard: a render is IN FLIGHT (renderFinalVideo holds the render lock
      // and is baking the CURRENT revision). Persisting a new revision now
      // would desync the artifact from the timeline (the in-flight render
      // cannot pick it up). The client's second download attempt is rejected
      // by the render lock anyway — reject here too, BEFORE any write.
      const inFlightStep = project.renderProgress?.step;
      if (inFlightStep && inFlightStep !== "sequence created" && inFlightStep !== "retry available") {
        throw new Error("video is currently rendering — wait for it to finish before changing audio settings");
      }

      // Optimistic lock — mirrors saveEditorChanges. If another writer
      // (e.g. the editor on another device) saved in between, reject
      // instead of clobbering; the client re-opens its preview data.
      const check = resolveTimelineRevision(project.timelineRevision, baseRevision);
      if (!check.ok) {
        console.warn("[audio-settings] revision conflict, base:", baseRevision, "current:", check.currentRevision);
        return { success: false, conflict: true, currentRevision: check.currentRevision };
      }

      const plan = normalizeTimelinePlan(JSON.parse(project.timelineJson));
      plan.audio.includeVoice = includeVoice;
      plan.audio.includeMusic = includeMusic;
      plan.subtitles.includeCaptions = includeCaptions;

      const timelineJson = JSON.stringify(plan);
      const validation = validateTimelinePlan(timelineJson);
      if (!validation.ok) {
        return { success: false, error: `timeline validation failed: ${validation.error}` };
      }

      await ctx.db.insert("timelines", {
        projectId,
        revision: check.nextRevision,
        timelineJson,
        source: "user",
        note: "audio settings (sequence preview download)",
        createdAt: Date.now(),
      });
      await ctx.db.patch(projectId, {
        timelineJson,
        timelineRevision: check.nextRevision,
      });
      console.log("[audio-settings] saved rev", check.nextRevision, {
        includeVoice, includeMusic, includeCaptions,
      });
      return { success: true, revision: check.nextRevision };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update audio settings",
      };
    }
  },
});

// ─── Edit Manifest (batch 3b) ──────────────────────────────────────────────
// The manifest is the auditable op stream that produced a timeline revision.
// The editor sends its opLog (batch 2b) alongside the save; we persist it
// keyed by (projectId, revision) so the lineage is queryable later — for
// the "Editing History" side panel, and as raw material for rollback
// (replay ops from revision 0 to reconstruct any intermediate document).

export const saveEditManifest = mutation({
  args: {
    projectId: v.id("projects"),
    revision: v.number(),
    operationsJson: v.string(),
  },
  handler: async (ctx, { projectId, revision, operationsJson }): Promise<{ success: boolean; error?: string }> => {
    await requireProjectOwnership(ctx, projectId);
    try {
      // Validate it's a non-empty JSON array (don't parse the whole thing —
      // it can be large; a structural check is enough).
      const parsed = JSON.parse(operationsJson);
      if (!Array.isArray(parsed)) {
        return { success: false, error: "operationsJson must be a JSON array" };
      }
      // Upsert: if a manifest already exists for this (projectId, revision),
      // overwrite it — the editor may re-save with additional ops before the
      // next revision bump.
      const existing = await ctx.db
        .query("editManifests")
        .withIndex("by_project_revision", (q) => q.eq("projectId", projectId).eq("revision", revision))
        .first();
      const opCount = parsed.length;
      if (existing) {
        await ctx.db.patch(existing._id, { operationsJson, opCount, createdAt: Date.now() });
      } else {
        await ctx.db.insert("editManifests", {
          projectId,
          revision,
          operationsJson,
          opCount,
          createdAt: Date.now(),
        });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Failed to save manifest" };
    }
  },
});

// Read the manifest for a specific revision (or the latest if revision is
// omitted). Returns the op stream and a human-readable summary per op.
export const getEditManifest = query({
  args: {
    projectId: v.id("projects"),
    revision: v.optional(v.number()),
  },
  handler: async (ctx, { projectId, revision }): Promise<{
    revision: number;
    opCount: number;
    operations: Array<{ type: string; summary: string }>;
    createdAt: number;
  } | null> => {
    await requireProjectOwnership(ctx, projectId);
    let row;
    if (revision !== undefined) {
      row = await ctx.db
        .query("editManifests")
        .withIndex("by_project_revision", (q) => q.eq("projectId", projectId).eq("revision", revision))
        .first();
    } else {
      row = await ctx.db
        .query("editManifests")
        .withIndex("by_project_revision", (q) => q.eq("projectId", projectId))
        .order("desc")
        .first();
    }
    if (!row) return null;
    try {
      const ops = JSON.parse(row.operationsJson) as any[];
      return {
        revision: row.revision,
        opCount: row.opCount,
        operations: ops.map(summarizeOp),
        createdAt: row.createdAt,
      };
    } catch {
      return { revision: row.revision, opCount: row.opCount, operations: [], createdAt: row.createdAt };
    }
  },
});

/** Human-readable one-liner for an op, for the history side panel. */
function summarizeOp(op: any): { type: string; summary: string } {
  switch (op?.type) {
    case "trimSegment":
      return { type: op.type, summary: `trim seg #${op.index} → start ${op.startFrom ?? "?"}, dur ${op.duration ?? "?"}` };
    case "moveSegment":
      return { type: op.type, summary: `move seg #${op.from} → #${op.to}` };
    case "splitSegment":
      return { type: op.type, summary: `split seg #${op.index} at ${op.at}s` };
    case "removeSegment":
      return { type: op.type, summary: `remove seg #${op.index}` };
    case "insertSegment":
      return { type: op.type, summary: `insert "${op.segment?.file ?? "?"}" at #${op.index}` };
    case "replaceSegmentFile":
      return { type: op.type, summary: `replace seg #${op.index} → ${op.file}` };
    case "adjustAudio": {
      const keys = Object.keys(op.patch ?? {}).join(", ");
      return { type: op.type, summary: `audio: ${keys}` };
    }
    case "adjustSubtitles": {
      const keys = Object.keys(op.patch ?? {}).join(", ");
      return { type: op.type, summary: `subtitles: ${keys}` };
    }
    default:
      return { type: String(op?.type ?? "unknown"), summary: JSON.stringify(op).slice(0, 80) };
  }
}

// ─── Generate Script Only ───────────────────────────────────────────────────
export const generateScriptOnly = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, { projectId }): Promise<{ success: boolean; script?: string; error?: string }> => {
    const authUserId = await requireAuth(ctx);
    try {
      const project = await ctx.runQuery(api.tasks.getProject, { id: projectId });
      if (!project) throw new Error("project not found");
      if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");

      let style = "professional";
      if (project.userId) {
        const user = await ctx.runQuery(api.users.getCurrentUser, { userId: project.userId });
        if (user?.preferredStyle) style = user.preferredStyle;
      }

      const fileUrls = project.fileUrls?.filter((url: string | null): url is string => url !== null) || [];
      console.log("[script-only] calling generateScript, files:", fileUrls.length, "prompt length:", project.prompt?.length ?? 0);
      const scriptResult = await ctx.runAction(api.aiServices.generateScript, {
        prompt: project.prompt,
        imageUrls: fileUrls,
        style,
      });

      if (!scriptResult.success) {
        throw new Error(`script generation failed: ${scriptResult.error}`);
      }

      const script: string = scriptResult.script!;
      console.log("[script-only] script generated, length:", script.length);

      await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
        id: projectId,
        script,
        status: "completed",
      });

      return { success: true, script };
    } catch (error) {
      console.error("[script-only] failed:", error instanceof Error ? error.message : error);
      await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
        id: projectId,
        error: error instanceof Error ? error.message : "script generation failed",
        status: "failed",
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : "script generation failed",
      };
    }
  },
});

// ─── Generate Media Assets ──────────────────────────────────────────────────
// internalAction (R1): previously public with NO auth — anyone could trigger
// the full paid pipeline (MiniMax TTS + MiniMax music + one FAL Kling run
// per image) on any project id. Now only the scheduler (markProjectSubmitted)
// can invoke it.
export const generateMediaAssets = internalAction({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, { projectId }): Promise<{ success: boolean; error?: string }> => {
    console.log("[generate-media] starting media generation for project:", projectId);

    let audioUrl: string | null | undefined;
    let srtContent: string | undefined;
    let musicUrl: string | null | undefined;
    const videoUrls: string[] = [];

    try {
      const project = await ctx.runQuery(internal.tasks.internalGetProject, { id: projectId });
      if (!project) {
        throw new Error("project not found");
      }

      if (!project.script) {
        throw new Error("no script found - generate or provide script first");
      }

      // Set status to processing
      await ctx.runMutation(internal.tasks.updateProjectStatus, {
        id: projectId,
        status: "processing",
      });

      console.log("[generate-media] step 1: generating voiceover");
      // Get user's custom voice ID and preferred style if available.
      // NOTE: this action is scheduler-triggered (no user JWT), so we must use
      // the internal query instead of the requireAuth-based getCurrentUser.
      let voiceId: string | undefined;
      let style = "professional"; // default
      if (project.userId) {
        const user = await ctx.runQuery(internal.users.internalGetVoiceSettings, {
          userId: project.userId as Id<"users">,
        });
        // Use selected voice if available, otherwise fall back to custom voice
        if (user?.selectedVoiceId) {
          voiceId = user.selectedVoiceId;
          console.log("[generate-media] using user's selected voice ID:", voiceId);
        }
        // Get user's preferred style
        if (user?.preferredStyle) {
          style = user.preferredStyle;
          console.log("[generate-media] using user's preferred style:", style);
        }
      }

      const voiceoverResult = await ctx.runAction(internal.aiServices.generateVoiceover, {
        text: project.script,
        voiceId,
        speed: project.voiceSpeed ?? 1.0,
      });

      if (!voiceoverResult.success || !voiceoverResult.audioUrl) {
        throw new Error(`voiceover generation failed: ${voiceoverResult.error}`);
      }

      audioUrl = voiceoverResult.audioUrl;
      srtContent = voiceoverResult.srtContent;
      const voiceoverDuration = voiceoverResult.durationMs || 15000;
      console.log("[generate-media] voiceover uploaded:", audioUrl, "duration:", voiceoverDuration, "ms");
      if (srtContent) {
        console.log("[generate-media] SRT generated, length:", srtContent.length, "chars");
      }

      console.log("[generate-media] step 2: generating background music");

      const musicResult = await ctx.runAction(internal.aiServices.generateMusic, {
        prompt: prompts.musicGeneration.prompt(style),
      });

      musicUrl = musicResult.success ? musicResult.musicUrl : undefined;
      if (musicUrl) {
        console.log("[generate-media] music uploaded:", musicUrl, "duration:", musicResult.musicDurationMs, "ms");
      } else {
        console.warn("[generate-media] music generation failed, continuing without music:", musicResult.error);
      }

      console.log("[generate-media] step 3: animating images");
      const fileUrls = project.fileUrls?.filter((url: string | null): url is string => url !== null) || [];
      console.log("[generate-media] Total file URLs:", fileUrls.length);

      // Filter images using fileMetadata contentType instead of URL extensions
      const imageOnlyUrls: string[] = [];
      if (project.fileMetadata && project.fileMetadata.length > 0) {
        console.log("[generate-media] Using fileMetadata to identify images");
        for (let i = 0; i < project.fileMetadata.length; i++) {
          const meta = project.fileMetadata[i];
          console.log(`[generate-media] File ${i + 1}: ${meta.filename}, type: ${meta.contentType}`);

          if (meta.contentType.startsWith('image/')) {
            const url = fileUrls[i];
            if (url) {
              imageOnlyUrls.push(url);
              console.log(`[generate-media] Found image: ${meta.filename} (${meta.contentType})`);
            }
          }
        }
      } else {
        // Fallback to old method if no metadata
        console.log("[generate-media] No fileMetadata, falling back to URL extension check");
        imageOnlyUrls.push(...fileUrls.filter((url: string) => isImageUrl(url)));
      }

      console.log("[generate-media] Image URLs found:", imageOnlyUrls.length);

      if (imageOnlyUrls.length === 0) {
        console.log("[generate-media] No images to animate! Skipping animation step.");
      }

      for (let i = 0; i < imageOnlyUrls.length; i++) {
        console.log(`[generate-media] Processing image ${i + 1}/${imageOnlyUrls.length}`);

        // Limited retry: FAL/Kling may return 429 or 502 transiently.
        // Retry up to 2 times with a 5-second delay between attempts.
        const MAX_ANIMATION_RETRIES = 2;
        let animated = false;
        for (let attempt = 0; attempt <= MAX_ANIMATION_RETRIES && !animated; attempt++) {
          if (attempt > 0) {
            console.log(`[generate-media] Retrying image ${i + 1} (attempt ${attempt + 1}/${MAX_ANIMATION_RETRIES + 1})`);
            await new Promise((r) => setTimeout(r, 5000));
          }
          try {
            const animateResult = await ctx.runAction(internal.aiServices.animateImage, {
              imageUrl: imageOnlyUrls[i],
            });

            if (animateResult.success && animateResult.data) {
              const data = animateResult.data as any;
              const videoUrl = data.video?.url;
              if (videoUrl) {
                videoUrls.push(videoUrl);
                animated = true;
                console.log(`[generate-media] Animated image ${i + 1} SUCCESS (attempt ${attempt + 1}), total videos: ${videoUrls.length}`);

                await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
                  id: projectId,
                  script: project.script,
                  audioUrl: audioUrl || undefined,
                  srtContent: srtContent || undefined,
                  musicUrl: musicUrl || undefined,
                  videoUrls: videoUrls.length > 0 ? videoUrls : undefined,
                  status: "processing",
                });
              } else {
                console.error(`[generate-media] Image ${i + 1} attempt ${attempt + 1}: succeeded but no video URL!`);
              }
            } else {
              console.error(`[generate-media] Image ${i + 1} attempt ${attempt + 1} failed:`, animateResult.error);
            }
          } catch (error) {
            console.error(`[generate-media] Exception animating image ${i + 1} attempt ${attempt + 1}:`, error instanceof Error ? error.message : String(error));
          }
        }
        if (!animated) {
          console.error(`[generate-media] Image ${i + 1} permanently failed after ${MAX_ANIMATION_RETRIES + 1} attempts, skipping`);
        }
      }

      await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
        id: projectId,
        script: project.script,
        audioUrl: audioUrl || undefined,
        srtContent: srtContent || undefined,
        musicUrl: musicUrl || undefined,
        videoUrls: videoUrls.length > 0 ? videoUrls : undefined,
        status: "completed",
      });

      console.log("[generate-media] media generation complete");
      return { success: true };
    } catch (error) {
      console.error("[generate-media] error:", error instanceof Error ? error.message : "unknown error");

      // R2: refund the credit if one was charged for this project.
      // Re-fetch the project (the try block's `project` is out of scope
      // here) and call the internal refund mutation. Best-effort: a refund
      // failure must not mask the original error.
      try {
        const proj = await ctx.runQuery(internal.tasks.internalGetProject, { id: projectId });
        if (proj?.creditCharged && proj.userId) {
          // P0-3: refund to the SAME bucket the charge came from
          // (previously always purchasedCredits, even when subscription
          // credits were spent — users could launder subscription credits
          // into permanent ones via repeated fail/refund cycles).
          await ctx.runMutation(internal.users.internalRefundCredit, {
            userId: proj.userId as Id<"users">,
            creditSource: proj.creditSource,
          });
          // P0-3: clear the charged flag so a resubmit can't double-refund.
          await ctx.runMutation(internal.tasks.internalMarkCreditRefunded, {
            id: projectId,
          });
          console.log("[generate-media] credit refunded for project:", projectId);
        }
      } catch (refundError) {
        console.error("[generate-media] credit refund failed:", refundError);
      }

      await ctx.runMutation(internal.tasks.updateProjectWithReelfulData, {
        id: projectId,
        error: error instanceof Error ? error.message : "media generation failed",
        status: "failed",
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : "media generation failed",
      };
    }
  },
});



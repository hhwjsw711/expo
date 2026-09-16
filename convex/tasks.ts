import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { prompts } from "./prompts";
import { requireAuth, requireProjectOwnership } from "./auth";

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

// ─── Create Chat Project (reelfull-app: chat-composer entry point) ──────────
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
    role: v.string(),
    content: v.string(),
    messageIndex: v.optional(v.number()),
    mediaIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    await requireProjectOwnership(ctx, args.projectId);

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
      const project = await ctx.db.get(args.projectId);
      if (project) {
        await ctx.db.patch(args.projectId, {
          userMessageCount: (project.userMessageCount || 0) + 1,
          prompt: project.prompt ? project.prompt : args.content,
        });
      }
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

    const newProjectId = await ctx.db.insert("projects", {
      userId: authUserId as Id<"users">,
      prompt: original.prompt,
      files: original.files,
      fileMetadata: original.fileMetadata,
      thumbnail: original.thumbnail,
      createdAt: Date.now(),
      status: "draft",
      chatEnabled: true,
      userMessageCount: 0,
    });

    // Copy chat messages
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_project", (q) => q.eq("projectId", args.sourceProjectId))
      .collect();

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
    await requireAuth(ctx);
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
      .collect();

    return Promise.all(
      projects.map(async (project) => ({
        ...project,
        fileUrls: await Promise.all(
          project.files.map((fileId) => ctx.storage.getUrl(fileId))
        ),
        thumbnailUrl: project.thumbnail
          ? await ctx.storage.getUrl(project.thumbnail)
          : project.thumbnailUrl || null,
      }))
    );
  },
});

// ─── Get Project ────────────────────────────────────────────────────────────
export const getProject = query({
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

// ─── Mark Project Submitted ─────────────────────────────────────────────────
export const markProjectSubmitted = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    await requireProjectOwnership(ctx, id);
    const project = await ctx.db.get(id);
    if (!project) throw new Error("project not found");

    // Idempotency: only allow submission from draft/script_generating status
    if (project.status === "processing" || project.status === "rendering") {
      return { id, alreadySubmitted: true };
    }

    // Server-side quota check
    if (project.userId) {
      const user = await ctx.db.get(project.userId);
      if (user) {
        const isPremium = user.isPremium || false;
        const subCredits = user.subscriptionCreditsRemaining || 0;
        const purchasedCredits = user.purchasedCredits || 0;
        const totalCredits = subCredits + purchasedCredits;

        if (!isPremium && totalCredits === 0) {
          // Free tier: count completed/rendering projects
          const allProjects = await ctx.db
            .query("projects")
            .withIndex("by_user", (q) => q.eq("userId", project.userId!))
            .collect();
          const generatedCount = allProjects.filter(
            (p) => p.status === "completed" || p.status === "rendering"
          ).length;

          if (generatedCount >= 3) {
            throw new Error("FREE_TIER_LIMIT_REACHED");
          }
        }
      }
    }

    await ctx.db.patch(id, {
      submittedAt: Date.now(),
      status: "processing",
    });
    // Server-side scheduling: no longer relies on client fire-and-forget
    await ctx.scheduler.runAfter(0, api.tasks.generateMediaAssets, {
      projectId: id,
    });
    return { id };
  },
});

// ─── Mark Project Submitted (Test Mode) ─────────────────────────────────────
export const markProjectSubmittedTestMode = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    await requireProjectOwnership(ctx, id);
    await ctx.db.patch(id, {
      submittedAt: Date.now(),
      status: "processing",
      renderMode: "test",
    });
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

      await ctx.runMutation(api.tasks.updateProjectWithReelfulData, {
        id: projectId,
        script: scriptResult.script,
        status: "completed",
      });

      return { success: true, script: scriptResult.script };
    } catch (error) {
      await ctx.runMutation(api.tasks.updateProjectWithReelfulData, {
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
export const updateProjectStatus = mutation({
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

// ─── Update Project with Reelful Data ───────────────────────────────────────
export const updateProjectWithReelfulData = mutation({
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
export const updateProjectWithRenderResult = mutation({
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
export const updateRenderProgress = mutation({
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
export const tryAcquireRenderLock = mutation({
  args: {
    id: v.id("projects"),
  },
  handler: async (ctx, { id }) => {
    const project = await ctx.db.get(id);
    if (!project) {
      return { success: false, error: "project not found" };
    }
    if (project.status === "rendering") {
      return { success: false, error: "already rendering" };
    }
    if (project.renderedVideoUrl) {
      return { success: false, error: "already rendered" };
    }
    // Atomically set status to rendering
    await ctx.db.patch(id, { status: "rendering" });
    return { success: true };
  },
});

// ─── Update Project Sandbox ─────────────────────────────────────────────────
export const updateProjectSandbox = mutation({
  args: {
    id: v.id("projects"),
    sandboxId: v.string(),
  },
  handler: async (ctx, { id, sandboxId }) => {
    await ctx.db.patch(id, { sandboxId });
    return id;
  },
});

// ─── Update Project Timeline JSON ──────────────────────────────────────────
// Saves the timeline.json read back from the sandbox (after Claude agent runs)
// so the mobile editor can use it for preview/editing.
export const updateProjectTimelineJson = mutation({
  args: {
    id: v.id("projects"),
    timelineJson: v.string(),
  },
  handler: async (ctx, { id, timelineJson }) => {
    await ctx.db.patch(id, { timelineJson });
    return id;
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

// ─── Update Project Render Mode ─────────────────────────────────────────────
export const updateProjectRenderMode = mutation({
  args: {
    id: v.id("projects"),
    renderMode: v.string(),
  },
  handler: async (ctx, { id, renderMode }) => {
    await requireProjectOwnership(ctx, id);
    await ctx.db.patch(id, { renderMode });
    return { id };
  },
});

// ─── Update Project Audio Settings ──────────────────────────────────────────
export const updateProjectAudioSettings = mutation({
  args: {
    id: v.id("projects"),
    voiceVolume: v.optional(v.number()),
    musicVolume: v.optional(v.number()),
    originalSoundVolume: v.optional(v.number()),
    includeVoice: v.optional(v.boolean()),
    includeMusic: v.optional(v.boolean()),
    includeCaptions: v.optional(v.boolean()),
    includeOriginalSound: v.optional(v.boolean()),
    keepOrder: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireProjectOwnership(ctx, args.id);
    const updates: any = {};
    if (args.voiceVolume !== undefined) updates.voiceVolume = args.voiceVolume;
    if (args.musicVolume !== undefined) updates.musicVolume = args.musicVolume;
    if (args.originalSoundVolume !== undefined) updates.originalSoundVolume = args.originalSoundVolume;
    if (args.includeVoice !== undefined) updates.includeVoice = args.includeVoice;
    if (args.includeMusic !== undefined) updates.includeMusic = args.includeMusic;
    if (args.includeCaptions !== undefined) updates.includeCaptions = args.includeCaptions;
    if (args.includeOriginalSound !== undefined) updates.includeOriginalSound = args.includeOriginalSound;
    if (args.keepOrder !== undefined) updates.keepOrder = args.keepOrder;
    await ctx.db.patch(args.id, updates);
    return { id: args.id };
  },
});

// ─── Regenerate Project Editing ─────────────────────────────────────────────
export const regenerateProjectEditing = mutation({
  args: {
    sourceProjectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    await requireProjectOwnership(ctx, args.sourceProjectId);
    const original = await ctx.db.get(args.sourceProjectId);
    if (!original) throw new Error("project not found");

    const newProjectId = await ctx.db.insert("projects", {
      userId: original.userId,
      prompt: original.prompt,
      files: original.files,
      fileMetadata: original.fileMetadata,
      thumbnail: original.thumbnail,
      createdAt: Date.now(),
      status: "processing",
      script: original.script,
      renderStep: "not_started",
      renderError: undefined,
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
        const blob = await response.blob();
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
        musicVolume: 0.3,
        originalSoundVolume: 0.0,
        includeVoice: true,
        includeMusic: true,
        includeCaptions: true,
        includeOriginalSound: false,
        error: "Project not found",
      };
    }
    if (project.userId !== authUserId) throw new Error("Forbidden: not project owner");

    return {
      success: true,
      baseVideoUrl: project.renderedVideoUrl || null,
      voiceAudioUrl: project.audioUrl || null,
      musicAudioUrl: project.musicUrl || null,
      watermarkUrl: null,
      voiceSpeed: project.voiceSpeed ?? 1.0,
      voiceVolume: project.voiceVolume ?? 1.0,
      musicVolume: project.musicVolume ?? 0.3,
      originalSoundVolume: project.originalSoundVolume ?? 0.0,
      includeVoice: project.includeVoice ?? true,
      includeMusic: project.includeMusic ?? true,
      includeCaptions: project.includeCaptions ?? true,
      includeOriginalSound: project.includeOriginalSound ?? false,
    };
  },
});

// ─── Get Project Editor Data ────────────────────────────────────────────────
export const getProjectEditorData = action({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; clipUrls?: Record<string, string>; videoUrls?: string[]; fileUrls?: string[]; fileMetadata?: any[]; musicVolume?: number; baseVideoUrl?: string | null; renderedVideoUrl?: string | null; timeline?: any; duration?: number; voiceAudioUrl?: string | null; musicAudioUrl?: string | null; assContent?: string; srtContent?: string; voiceSpeed?: number; voiceVolume?: number; originalSoundVolume?: number; includeVoice?: boolean; includeMusic?: boolean; includeCaptions?: boolean; includeOriginalSound?: boolean; error?: string }> => {
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
export const saveEditorChanges = mutation({
  args: {
    projectId: v.id("projects"),
    timelineJson: v.string(),
    assContent: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, timelineJson, assContent }): Promise<{ success: boolean; newProjectId?: Id<"projects">; error?: string }> => {
    await requireProjectOwnership(ctx, projectId);
    try {
      const original = await ctx.db.get(projectId);
      if (!original) throw new Error("project not found");

      // 1. Save timeline/ASS to the original project (preserves editor state)
      await ctx.db.patch(projectId, {
        timelineJson,
        assContent: assContent ?? original.assContent,
      });

      // 2. Create a new project fork for re-rendering
      const newProjectId = await ctx.db.insert("projects", {
        userId: original.userId,
        prompt: original.prompt,
        files: original.files,
        fileMetadata: original.fileMetadata,
        thumbnail: original.thumbnail,
        createdAt: Date.now(),
        status: "processing",
        script: original.script,
        audioUrl: original.audioUrl,
        srtContent: original.srtContent,
        musicUrl: original.musicUrl,
        videoUrls: original.videoUrls,
        timelineJson,
        assContent: assContent ?? original.assContent,
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

      return { success: true, newProjectId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to save editor changes",
      };
    }
  },
});

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
      const scriptResult = await ctx.runAction(api.aiServices.generateScript, {
        prompt: project.prompt,
        imageUrls: fileUrls,
        style,
      });

      if (!scriptResult.success) {
        throw new Error(`script generation failed: ${scriptResult.error}`);
      }

      const script: string = scriptResult.script!;

      await ctx.runMutation(api.tasks.updateProjectWithReelfulData, {
        id: projectId,
        script,
        status: "completed",
      });

      return { success: true, script };
    } catch (error) {
      await ctx.runMutation(api.tasks.updateProjectWithReelfulData, {
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
export const generateMediaAssets = action({
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
      const project = await ctx.runQuery(api.tasks.getProject, { id: projectId });
      if (!project) {
        throw new Error("project not found");
      }

      if (!project.script) {
        throw new Error("no script found - generate or provide script first");
      }

      // Set status to processing
      await ctx.runMutation(api.tasks.updateProjectStatus, {
        id: projectId,
        status: "processing",
      });

      console.log("[generate-media] step 1: generating voiceover");
      // Get user's custom voice ID and preferred style if available
      let voiceId: string | undefined;
      let style = "professional"; // default
      if (project.userId) {
        const user = await ctx.runQuery(api.users.getCurrentUser, { userId: project.userId });
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

      const voiceoverResult = await ctx.runAction(api.aiServices.generateVoiceover, {
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

      const musicResult = await ctx.runAction(api.aiServices.generateMusic, {
        prompt: prompts.musicGeneration.prompt(style),
      });

      musicUrl = musicResult.success ? musicResult.musicUrl : undefined;
      if (musicUrl) {
        console.log("[generate-media] music uploaded:", musicUrl, "duration:", musicResult.musicDurationMs, "ms");
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

        try {
          const animateResult = await ctx.runAction(api.aiServices.animateImage, {
            imageUrl: imageOnlyUrls[i],
          });

          if (animateResult.success && animateResult.data) {
            const data = animateResult.data as any;
            const videoUrl = data.video?.url;
            if (videoUrl) {
              videoUrls.push(videoUrl);
              console.log(`[generate-media] Animated image ${i + 1} SUCCESS, total videos: ${videoUrls.length}`);

              await ctx.runMutation(api.tasks.updateProjectWithReelfulData, {
                id: projectId,
                script: project.script,
                audioUrl: audioUrl || undefined,
                srtContent: srtContent || undefined,
                musicUrl: musicUrl || undefined,
                videoUrls: videoUrls.length > 0 ? videoUrls : undefined,
                status: "processing",
              });
            } else {
              console.error(`[generate-media] Image ${i + 1} animation succeeded but no video URL!`);
            }
          } else {
            console.error(`[generate-media] Image ${i + 1} animation failed:`, animateResult.error);
          }
        } catch (error) {
          console.error(`[generate-media] Exception animating image ${i + 1}:`, error instanceof Error ? error.message : String(error));
        }
      }

      await ctx.runMutation(api.tasks.updateProjectWithReelfulData, {
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
      await ctx.runMutation(api.tasks.updateProjectWithReelfulData, {
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



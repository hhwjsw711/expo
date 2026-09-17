import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  otpCodes: defineTable({
    phone: v.string(),
    code: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  }).index("by_phone", ["phone"]),

  users: defineTable({
    name: v.optional(v.string()),
    phone: v.optional(v.string()),
    preferredStyle: v.optional(v.union(
      v.literal("playful"),
      v.literal("professional"),
      v.literal("travel")
    )),
    voiceRecordingUrl: v.optional(v.string()),
    voiceRecordingStorageId: v.optional(v.id("_storage")),
    elevenlabsVoiceId: v.optional(v.string()),
    voicePreviewStorageId: v.optional(v.id("_storage")),
    selectedVoiceId: v.optional(v.string()),
    onboardingCompleted: v.boolean(),
    chatTipsCompleted: v.optional(v.boolean()),
    videoPreviewTipsCompleted: v.optional(v.boolean()),
    pushToken: v.optional(v.string()),
    // Subscription / credits
    isPremium: v.optional(v.boolean()),
    subscriptionCreditsRemaining: v.optional(v.number()),
    purchasedCredits: v.optional(v.number()),
    subscriptionExpiresAt: v.optional(v.string()),
    subscriptionType: v.optional(v.string()),
    // RevenueCat app_user_id (bound at login via Purchases.logIn(convexUserId))
    revenuecatAppUserId: v.optional(v.string()),
    // Backdoor password (for dev login)
    backdoorPassword: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_phone", ["phone"]).index("by_revenuecat_app_user_id", ["revenuecatAppUserId"]),

  defaultVoices: defineTable({
    voiceId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    previewStorageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
  }).index("by_voiceId", ["voiceId"]),

  projects: defineTable({
    userId: v.optional(v.id("users")),
    name: v.optional(v.string()),
    prompt: v.string(),
    files: v.array(v.id("_storage")),
    fileMetadata: v.optional(v.array(v.object({
      storageId: v.id("_storage"),
      filename: v.string(),
      contentType: v.string(),
      size: v.number(),
    }))),
    thumbnail: v.optional(v.id("_storage")),
    thumbnailUrl: v.optional(v.string()),
    createdAt: v.number(),
    status: v.optional(
      v.union(
        v.literal("processing"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("rendering"),
        v.literal("draft"),
        v.literal("script_generating"),
      )
    ),
    completedAt: v.optional(v.number()),
    submittedAt: v.optional(v.number()),
    script: v.optional(v.string()),
    audioUrl: v.optional(v.string()),
    srtContent: v.optional(v.string()),
    musicUrl: v.optional(v.string()),
    videoUrls: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    renderError: v.optional(v.string()),
    renderedVideoUrl: v.optional(v.string()),
    duration: v.optional(v.number()),
    renderProgress: v.optional(v.object({
      step: v.string(),
      details: v.optional(v.string()),
      timestamp: v.number(),
    })),
    sandboxId: v.optional(v.string()),
    sandboxStatus: v.optional(v.union(
      v.literal("alive"),
      v.literal("dead")
    )),
    renderStep: v.optional(v.union(
      v.literal("not_started"),
      v.literal("creating_sandbox"),
      v.literal("uploading_media"),
      v.literal("editing_sequence"),
      v.literal("rendering_video"),
      v.literal("completed"),
      v.literal("failed")
    )),
    // Chat composer fields
    chatEnabled: v.optional(v.boolean()),
    userMessageCount: v.optional(v.number()),
    scriptGeneratedAt: v.optional(v.number()),
    voiceSpeed: v.optional(v.number()),
    renderMode: v.optional(v.string()),
    keepOrder: v.optional(v.boolean()),
    animationStatus: v.optional(v.string()),
    timelineJson: v.optional(v.string()),
    // Monotonic revision counter for the timeline. Missing = 0 (pre-migration
    // projects). Every timeline write bumps it and appends a row to the
    // `timelines` history table. Clients pass the revision they loaded as
    // baseRevision to save, giving optimistic locking against concurrent
    // edits (two devices, or a user edit racing an automated rebuild).
    timelineRevision: v.optional(v.number()),
    assContent: v.optional(v.string()),
    mediaDescriptions: v.optional(v.array(v.object({
      storageId: v.id("_storage"),
      description: v.string(),
    }))),
    generationProgress: v.optional(v.object({
      step: v.string(),
      details: v.optional(v.string()),
      timestamp: v.number(),
    })),
    // Audio settings
    voiceVolume: v.optional(v.number()),
    musicVolume: v.optional(v.number()),
    originalSoundVolume: v.optional(v.number()),
    includeVoice: v.optional(v.boolean()),
    includeMusic: v.optional(v.boolean()),
    includeCaptions: v.optional(v.boolean()),
    includeOriginalSound: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),

  // Timeline version history — one row per write, for audit and rollback.
  // The current revision is denormalized onto projects.timelineJson /
  // projects.timelineRevision; this table keeps the full lineage.
  timelines: defineTable({
    projectId: v.id("projects"),
    revision: v.number(),
    timelineJson: v.string(),
    source: v.union(
      v.literal("ai"),    // Claude agent plan (Branch A)
      v.literal("user"),  // editor save (saveEditorChanges / saveTimelineRevision)
      v.literal("system"), // automated recovery / rebuild
    ),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_project", ["projectId", "revision"]),

  // Edit manifest — the operation stream that produced a timeline revision.
  // One row per revision that had a client-visible op sequence (user edits).
  // AI plans (source 'ai') and system rebuilds don't write here: they have
  // no op stream, only a single terminal 'plan' op. The manifest is the
  // auditable record (batch 3b) and the raw material for future rollback
  // (replay ops from revision N to reconstruct the document at N).
  editManifests: defineTable({
    projectId: v.id("projects"),
    revision: v.number(),
    // Serialized TimelineOperation[] from the editor's opLog. JSON string
    // keeps the schema simple and the payload flexible as ops evolve.
    operationsJson: v.string(),
    opCount: v.number(),
    createdAt: v.number(),
  }).index("by_project_revision", ["projectId", "revision"]),

  chatMessages: defineTable({
    projectId: v.id("projects"),
    role: v.string(),
    content: v.string(),
    messageIndex: v.optional(v.number()),
    mediaIds: v.optional(v.array(v.id("_storage"))),
    isEdited: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),

  // RevenueCat webhook events - idempotency guard.
  // Each event_id is stored on first receipt; duplicates are dropped.
  revenuecatEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    appUserId: v.string(),
    processedAt: v.number(),
  }).index("by_eventId", ["eventId"]),
});

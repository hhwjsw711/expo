import { v } from "convex/values";
import { mutation, query, internalMutation, action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// ─── Internal: Store OTP (used by phoneAuth) ────────────────────────────────
export const storeOTP = internalMutation({
  args: {
    phone: v.string(),
    code: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existingOTPs = await ctx.db
      .query("otpCodes")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .collect();

    for (const otp of existingOTPs) {
      await ctx.db.delete(otp._id);
    }

    await ctx.db.insert("otpCodes", {
      phone: args.phone,
      code: args.code,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
  },
});

// ─── Internal: Get or create user (used by Twilio Verify) ───────────────────
export const getOrCreateUser = internalMutation({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    let user = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();

    if (!user) {
      const userId = await ctx.db.insert("users", {
        phone: args.phone,
        onboardingCompleted: false,
        createdAt: Date.now(),
      });
      user = await ctx.db.get(userId);
    }

    return {
      userId: user?._id,
      onboardingCompleted: user?.onboardingCompleted || false,
    };
  },
});

// ─── Verify OTP (development mode — local OTP storage) ──────────────────────
export const verifyOTP = mutation({
  args: {
    phone: v.string(),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const storedOTP = await ctx.db
      .query("otpCodes")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();

    if (!storedOTP) {
      throw new Error("OTP not found. Please request a new code.");
    }

    if (Date.now() > storedOTP.expiresAt) {
      await ctx.db.delete(storedOTP._id);
      throw new Error("OTP expired. Please request a new code.");
    }

    if (storedOTP.code !== args.code) {
      throw new Error("Invalid OTP code.");
    }

    await ctx.db.delete(storedOTP._id);

    // Get or create user
    let user = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();

    if (!user) {
      const userId = await ctx.db.insert("users", {
        phone: args.phone,
        onboardingCompleted: false,
        createdAt: Date.now(),
      });
      user = await ctx.db.get(userId);
    }

    return {
      success: true,
      userId: user?._id,
      onboardingCompleted: user?.onboardingCompleted || false,
    };
  },
});

// ─── Backdoor Login (dev shortcut: phone 0000000000 + password) ─────────────
export const backdoorLogin = mutation({
  args: {
    phone: v.string(),
    password: v.string(),
  },
  handler: async (ctx, args) => {
    const BACKDOOR_PASSWORD = process.env.BACKDOOR_PASSWORD || "rYSHRfLTy8D07n";

    // Reject backdoor login if explicitly disabled in production
    if (process.env.DISABLE_BACKDOOR === "true") {
      throw new Error("Backdoor login is disabled");
    }

    if (args.password !== BACKDOOR_PASSWORD) {
      throw new Error("Invalid password");
    }

    // Find or create user with phone "0000000000"
    const backdoorPhone = "+10000000000";
    let user = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", backdoorPhone))
      .first();

    if (!user) {
      const userId = await ctx.db.insert("users", {
        phone: backdoorPhone,
        name: "Developer",
        onboardingCompleted: false,
        isPremium: true,
        subscriptionCreditsRemaining: 100,
        purchasedCredits: 100,
        createdAt: Date.now(),
      });
      user = await ctx.db.get(userId);
    }

    return {
      success: true,
      userId: user?._id,
      onboardingCompleted: user?.onboardingCompleted || false,
    };
  },
});

// ─── Test Account Login ─────────────────────────────────────────────────────
export const testAccountLogin = mutation({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    // Reject test account login if explicitly disabled in production
    if (process.env.DISABLE_TEST_ACCOUNT === "true") {
      throw new Error("Test account login is disabled");
    }

    let user = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();

    if (!user) {
      const userId = await ctx.db.insert("users", {
        phone: args.phone,
        name: "Test User",
        onboardingCompleted: false,
        isPremium: true,
        subscriptionCreditsRemaining: 100,
        purchasedCredits: 100,
        createdAt: Date.now(),
      });
      user = await ctx.db.get(userId);
    }

    return {
      success: true,
      userId: user?._id,
      onboardingCompleted: user?.onboardingCompleted || false,
    };
  },
});

// ─── Get Current User ───────────────────────────────────────────────────────
export const getCurrentUser = query({
  args: { userId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!args.userId) {
      return null;
    }
    return await ctx.db.get(args.userId);
  },
});

// ─── Get Default Voices ─────────────────────────────────────────────────────
export const getDefaultVoices = query({
  args: {},
  handler: async (ctx) => {
    const voices = await ctx.db.query("defaultVoices").collect();
    // Also return previewUrl for frontend convenience
    return Promise.all(
      voices.map(async (voice) => ({
        ...voice,
        previewUrl: voice.previewStorageId
          ? (await ctx.storage.getUrl(voice.previewStorageId)) ?? undefined
          : undefined,
      }))
    );
  },
});

// ─── Get Voice Preview URL ──────────────────────────────────────────────────
export const getVoicePreviewUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

// ─── Get Video Generation Status (subscription + credits) ───────────────────
export const getVideoGenerationStatus = query({
  args: { userId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!args.userId) {
      return {
        isPremium: false,
        subscriptionCreditsRemaining: 0,
        purchasedCredits: 0,
        totalCreditsRemaining: 0,
        hasReachedLimit: false,
        generatedCount: 0,
        limit: 3,
      };
    }

    const user = await ctx.db.get(args.userId);
    if (!user) {
      return {
        isPremium: false,
        subscriptionCreditsRemaining: 0,
        purchasedCredits: 0,
        totalCreditsRemaining: 0,
        hasReachedLimit: false,
        generatedCount: 0,
        limit: 3,
      };
    }

    // Count user's completed/rendering projects
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    const generatedCount = projects.filter(
      (p) => p.status === "completed" || p.status === "rendering"
    ).length;

    const subCredits = user.subscriptionCreditsRemaining || 0;
    const purchasedCredits = user.purchasedCredits || 0;
    const totalCredits = subCredits + purchasedCredits;

    const isPremium = user.isPremium || false;
    const freeLimit = 3;
    const hasReachedLimit = !isPremium && totalCredits === 0 && generatedCount >= freeLimit;

    return {
      isPremium,
      subscriptionCreditsRemaining: subCredits,
      purchasedCredits,
      totalCreditsRemaining: totalCredits,
      hasReachedLimit,
      generatedCount,
      limit: isPremium ? 999 : freeLimit,
    };
  },
});

// ─── Update Push Token ──────────────────────────────────────────────────────
export const updatePushToken = mutation({
  args: {
    userId: v.id("users"),
    pushToken: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      pushToken: args.pushToken,
    });
    return { success: true };
  },
});

// ─── Complete Onboarding ────────────────────────────────────────────────────
export const completeOnboarding = action({
  args: {
    userId: v.id("users"),
    name: v.string(),
    preferredStyle: v.union(
      v.literal("playful"),
      v.literal("professional"),
      v.literal("travel")
    ),
    voiceRecordingStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    let voiceRecordingUrl: string | undefined;
    let voiceId: string | undefined;
    let voicePreviewStorageId: Id<"_storage"> | undefined;

    if (args.voiceRecordingStorageId) {
      voiceRecordingUrl = await ctx.storage.getUrl(args.voiceRecordingStorageId) || undefined;

      // Create MiniMax cloned voice if audio is provided
      if (voiceRecordingUrl) {
        console.log("[completeOnboarding] creating MiniMax voice...");
        const voiceResult = await ctx.runAction(api.aiServices.createElevenLabsVoice, {
          audioUrl: voiceRecordingUrl,
          name: `${args.name}'s Voice`,
        });

        if (voiceResult.success && voiceResult.voiceId) {
          voiceId = voiceResult.voiceId;
          voicePreviewStorageId = voiceResult.previewStorageId;
          console.log("[completeOnboarding] MiniMax voice created:", voiceId);
        } else {
          console.error("[completeOnboarding] failed to create MiniMax voice:", voiceResult.error);
          // Continue with onboarding even if voice creation fails
        }
      }
    }

    await ctx.runMutation(internal.users.internalCompleteOnboarding, {
      userId: args.userId,
      name: args.name,
      preferredStyle: args.preferredStyle,
      voiceRecordingStorageId: args.voiceRecordingStorageId,
      voiceRecordingUrl,
      elevenlabsVoiceId: voiceId,
      voicePreviewStorageId,
    });

    return { success: true };
  },
});

// ─── Internal: Complete Onboarding (mutation) ───────────────────────────────
export const internalCompleteOnboarding = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    preferredStyle: v.union(
      v.literal("playful"),
      v.literal("professional"),
      v.literal("travel")
    ),
    voiceRecordingStorageId: v.optional(v.id("_storage")),
    voiceRecordingUrl: v.optional(v.string()),
    elevenlabsVoiceId: v.optional(v.string()),
    voicePreviewStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      name: args.name,
      preferredStyle: args.preferredStyle,
      voiceRecordingStorageId: args.voiceRecordingStorageId,
      voiceRecordingUrl: args.voiceRecordingUrl,
      elevenlabsVoiceId: args.elevenlabsVoiceId,
      voicePreviewStorageId: args.voicePreviewStorageId,
      onboardingCompleted: true,
    });
  },
});

// ─── Generate Upload URL ────────────────────────────────────────────────────
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

// ─── Update Profile ─────────────────────────────────────────────────────────
export const updateProfile = action({
  args: {
    userId: v.id("users"),
    name: v.optional(v.string()),
    preferredStyle: v.optional(
      v.union(
        v.literal("playful"),
        v.literal("professional"),
        v.literal("travel")
      )
    ),
    voiceRecordingStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    const updates: any = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.preferredStyle !== undefined) updates.preferredStyle = args.preferredStyle;

    if (args.voiceRecordingStorageId !== undefined) {
      updates.voiceRecordingStorageId = args.voiceRecordingStorageId;
      const url = await ctx.storage.getUrl(args.voiceRecordingStorageId);
      updates.voiceRecordingUrl = url || undefined;
    }

    await ctx.runMutation(internal.users.internalUpdateProfile, {
      userId: args.userId,
      updates,
    });

    return { success: true };
  },
});

// ─── Internal: Update Profile (mutation) ────────────────────────────────────
export const internalUpdateProfile = internalMutation({
  args: {
    userId: v.id("users"),
    updates: v.object({
      name: v.optional(v.string()),
      preferredStyle: v.optional(v.union(
        v.literal("playful"),
        v.literal("professional"),
        v.literal("travel")
      )),
      voiceRecordingStorageId: v.optional(v.id("_storage")),
      voiceRecordingUrl: v.optional(v.string()),
      elevenlabsVoiceId: v.optional(v.string()),
      voicePreviewStorageId: v.optional(v.id("_storage")),
      selectedVoiceId: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, args.updates);
  },
});

// ─── Update Selected Voice ──────────────────────────────────────────────────
export const updateSelectedVoice = mutation({
  args: {
    userId: v.id("users"),
    voiceId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      selectedVoiceId: args.voiceId,
    });
  },
});

// ─── Delete Account ─────────────────────────────────────────────────────────
export const deleteAccount = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    // Delete user's projects
    const projects = await ctx.runQuery(api.tasks.getProjects, { userId: args.userId });
    for (const project of projects) {
      await ctx.runMutation(api.tasks.deleteProject, { id: project._id });
    }

    await ctx.runMutation(internal.users.internalDeleteAccount, { userId: args.userId });
    return { success: true };
  },
});

// ─── Internal: Delete Account ───────────────────────────────────────────────
export const internalDeleteAccount = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.userId);
  },
});

// ─── Update Subscription Status ─────────────────────────────────────────────
export const updateSubscriptionStatus = mutation({
  args: {
    userId: v.id("users"),
    isPremium: v.optional(v.boolean()),
    subscriptionCreditsRemaining: v.optional(v.number()),
    subscriptionExpiresAt: v.optional(v.string()),
    subscriptionType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: any = {};
    if (args.isPremium !== undefined) updates.isPremium = args.isPremium;
    if (args.subscriptionCreditsRemaining !== undefined) {
      updates.subscriptionCreditsRemaining = args.subscriptionCreditsRemaining;
    }
    if (args.subscriptionExpiresAt !== undefined) {
      updates.subscriptionExpiresAt = args.subscriptionExpiresAt;
    }
    if (args.subscriptionType !== undefined) {
      updates.subscriptionType = args.subscriptionType;
    }
    await ctx.db.patch(args.userId, updates);
    return { success: true };
  },
});

// ─── Purchase Credits ───────────────────────────────────────────────────────
export const purchaseCredits = mutation({
  args: {
    userId: v.id("users"),
    credits: v.number(),
    priceInCents: v.optional(v.number()),
    productId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const current = user?.purchasedCredits || 0;
    await ctx.db.patch(args.userId, {
      purchasedCredits: current + args.credits,
    });
    return { success: true };
  },
});

// ─── Redeem Promo Code ──────────────────────────────────────────────────────
export const redeemPromoCode = mutation({
  args: {
    userId: v.id("users"),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    // Promo code: "REELFUL100" gives 100 credits
    if (args.code === "REELFUL100") {
      const user = await ctx.db.get(args.userId);
      const current = user?.purchasedCredits || 0;
      await ctx.db.patch(args.userId, {
        purchasedCredits: current + 100,
        isPremium: true,
      });
      return { success: true, durationDays: 30, credits: 100 };
    }
    return { success: false, error: "Invalid promo code" };
  },
});

// ─── Complete Chat Tips (mark that user has seen chat tips) ──────────────────
export const completeChatTips = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { chatTipsCompleted: true });
    return { success: true };
  },
});

// ─── Complete Video Preview Tips ────────────────────────────────────────────
export const completeVideoPreviewTips = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { videoPreviewTipsCompleted: true });
    return { success: true };
  },
});



import { v } from "convex/values";
import { mutation, query, internalQuery, internalMutation, action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { signUserJWT, requireAuth } from "./auth";

// Max failed verify attempts before the OTP is destroyed and the user
// must request a new code (brute-force guard).
const MAX_OTP_ATTEMPTS = 5;
// Cooldown between OTP sends for the same phone number.
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

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
      attempts: 0,
    });
  },
});

// ─── Internal: OTP send rate limit (used by phoneAuth.sendOTP) ──────────────
// One row per phone in `otpRequests`. Rejects sends within the cooldown
// window. Covers BOTH paths — Twilio Verify (which never touches otpCodes)
// and the dev-mode local store — so SMS-bombing and Twilio cost attacks are
// bounded regardless of the delivery mode.
export const internalCheckOtpRateLimit = internalMutation({
  args: { phone: v.string() },
  handler: async (ctx, args): Promise<
    { ok: true } | { ok: false; retryAfterMs: number }
  > => {
    const existing = await ctx.db
      .query("otpRequests")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();
    const now = Date.now();
    if (existing && now - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
      return {
        ok: false,
        retryAfterMs: existing.lastSentAt + OTP_RESEND_COOLDOWN_MS - now,
      };
    }
    if (existing) {
      await ctx.db.patch(existing._id, { lastSentAt: now });
    } else {
      await ctx.db.insert("otpRequests", {
        phone: args.phone,
        lastSentAt: now,
      });
    }
    return { ok: true };
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

    // Brute-force guard: a 6-digit code must not be verifiable an unlimited
    // number of times within its 10-minute window. Count failures; destroy
    // the code once the budget is exhausted so the user must re-request.
    const attempts = storedOTP.attempts ?? 0;
    if (attempts >= MAX_OTP_ATTEMPTS) {
      await ctx.db.delete(storedOTP._id);
      throw new Error("Too many attempts. Please request a new code.");
    }

    if (storedOTP.code !== args.code) {
      const nextAttempts = attempts + 1;
      if (nextAttempts >= MAX_OTP_ATTEMPTS) {
        await ctx.db.delete(storedOTP._id);
        throw new Error("Too many attempts. Please request a new code.");
      }
      await ctx.db.patch(storedOTP._id, { attempts: nextAttempts });
      throw new Error(
        `Invalid OTP code. ${MAX_OTP_ATTEMPTS - nextAttempts} attempts remaining.`
      );
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

    const userId = user?._id as string;
    return {
      success: true,
      userId: user?._id,
      onboardingCompleted: user?.onboardingCompleted || false,
      token: await signUserJWT(userId),
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
    // R2: hard production block — even if DISABLE_BACKDOOR is not set, the
    // backdoor must never be reachable in production. Belt-and-suspenders
    // alongside the existing DISABLE_BACKDOOR env var check.
    if (process.env.NODE_ENV === "production") {
      throw new Error("Backdoor login is not available in production");
    }

    // Dev-only shortcut. Password MUST be set via BACKDOOR_PASSWORD env var;
    // no hardcoded default. Unset -> login is always rejected.
    const backdoorPassword = process.env.BACKDOOR_PASSWORD;

    // Reject backdoor login if explicitly disabled
    if (process.env.DISABLE_BACKDOOR === "true") {
      throw new Error("Backdoor login is disabled");
    }

    if (!backdoorPassword || args.password !== backdoorPassword) {
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
      token: await signUserJWT(user?._id as string),
    };
  },
});

// ─── Test Account Login ─────────────────────────────────────────────────────
// Opt-in via ENABLE_TEST_ACCOUNT env var. Never grants premium/credits.
// The phone number is HARDCODED to a dedicated test number: the previous
// version accepted any phone argument, which (when the feature was enabled)
// let anyone log in as any existing user — an account-takeover hole.
export const testAccountLogin = mutation({
  args: {},
  handler: async (ctx) => {
    // R2: hard production block — test account login must never be reachable
    // in production, regardless of ENABLE_TEST_ACCOUNT env var.
    if (process.env.NODE_ENV === "production") {
      throw new Error("Test account login is not available in production");
    }

    if (process.env.ENABLE_TEST_ACCOUNT !== "true") {
      throw new Error("Test account login is disabled");
    }

    const testPhone = "+10000000001";
    let user = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", testPhone))
      .first();

    if (!user) {
      const userId = await ctx.db.insert("users", {
        phone: testPhone,
        name: "Test User",
        onboardingCompleted: false,
        createdAt: Date.now(),
      });
      user = await ctx.db.get(userId);
    }

    return {
      success: true,
      userId: user?._id,
      onboardingCompleted: user?.onboardingCompleted || false,
      token: await signUserJWT(user?._id as string),
    };
  },
});

// ─── Get Current User ───────────────────────────────────────────────────────
// userId arg is kept for frontend "skip" gating only; the actual user
// is always resolved from the auth token.
export const getCurrentUser = query({
  args: { userId: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!args.userId) {
      return null;
    }
    const authUserId = await requireAuth(ctx);
    return await ctx.db.get(authUserId as Id<"users">);
  },
});

// ─── Internal: Voice Settings for Server Jobs ────────────────────────────────
// Scheduled actions (ctx.scheduler.runAfter) run without a user JWT, so they
// must not call requireAuth-based functions like getCurrentUser. This
// internal query is only callable from server code and reads voice settings
// directly by userId.
export const internalGetVoiceSettings = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    return {
      selectedVoiceId: user?.selectedVoiceId ?? undefined,
      preferredStyle: user?.preferredStyle ?? undefined,
    };
  },
});

// ─── Internal: Refund Credit (used by generateMediaAssets catch block) ──────
// Adds 1 credit back to purchasedCredits. Called when the paid pipeline fails
// AFTER markProjectSubmitted already deducted a credit (creditCharged=true).
// internalMutation = unreachable from the client.
export const internalRefundCredit = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return;
    const current = user.purchasedCredits || 0;
    await ctx.db.patch(userId, { purchasedCredits: current + 1 });
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
// userId arg kept for "skip" gating; actual user resolved from auth token.
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

    const authUserId = await requireAuth(ctx);
    const user = await ctx.db.get(authUserId as Id<"users">);
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

    // Count user's projects that consumed or are consuming the paid
    // pipeline — same rule as markProjectSubmitted (R2: includes
    // "processing" so the UI count matches the enforced quota).
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_user", (q) => q.eq("userId", authUserId as Id<"users">))
      .collect();

    const generatedCount = projects.filter(
      (p) =>
        p.status === "completed" ||
        p.status === "rendering" ||
        p.status === "processing"
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
    pushToken: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx);
    await ctx.db.patch(authUserId as Id<"users">, {
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
    const authUserId = await requireAuth(ctx);
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
      userId: authUserId as Id<"users">,
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
    await requireAuth(ctx);
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
    const authUserId = await requireAuth(ctx);
    const updates: any = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.preferredStyle !== undefined) updates.preferredStyle = args.preferredStyle;

    if (args.voiceRecordingStorageId !== undefined) {
      updates.voiceRecordingStorageId = args.voiceRecordingStorageId;
      const url = await ctx.storage.getUrl(args.voiceRecordingStorageId);
      updates.voiceRecordingUrl = url || undefined;
    }

    await ctx.runMutation(internal.users.internalUpdateProfile, {
      userId: authUserId as Id<"users">,
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
    const authUserId = await requireAuth(ctx);
    await ctx.db.patch(authUserId as Id<"users">, {
      selectedVoiceId: args.voiceId,
    });
  },
});

// ─── Delete Account ─────────────────────────────────────────────────────────
export const deleteAccount = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<{ success: boolean; error?: string }> => {
    // Verify the caller is who they claim to be.
    const authUserId = await requireAuth(ctx);
    if (authUserId !== args.userId) {
      throw new Error("Forbidden: cannot delete another user's account");
    }
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

// ─── Subscription / credits state changes ─────────────────────────────────────
// The public mutations `updateSubscriptionStatus` and `purchaseCredits` were
// REMOVED: anyone could patch any user's subscription or add arbitrary credits.
// All grants now flow exclusively through the verified RevenueCat webhook:
//   http.ts (verify signature) -> revenuecat.ts internal mutations.

// ─── Redeem Promo Code ──────────────────────────────────────────────────────
// Codes are configured via PROMO_CODES env var (JSON: {"CODE": credits}).
// Unset -> every code is invalid. No hardcoded codes.
export const redeemPromoCode = mutation({
  args: {
    userId: v.id("users"),
    code: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx);
    let promoCodes: Record<string, number> = {};
    if (process.env.PROMO_CODES) {
      try {
        promoCodes = JSON.parse(process.env.PROMO_CODES);
      } catch {
        console.error("[redeemPromoCode] Invalid PROMO_CODES env var JSON");
        return { success: false, error: "Invalid promo code" };
      }
    }

    const credits = promoCodes[args.code];
    if (typeof credits !== "number" || credits <= 0) {
      return { success: false, error: "Invalid promo code" };
    }

    // R2: prevent the same user from redeeming the same code multiple times.
    // Previously each call added credits + set isPremium=true with NO limit
    // — an infinite free-credits loop.
    const existing = await ctx.db
      .query("promoRedemptions")
      .withIndex("by_user_code", (q) =>
        q.eq("userId", authUserId as Id<"users">).eq("code", args.code)
      )
      .first();
    if (existing) {
      return { success: false, error: "Promo code already redeemed" };
    }

    const user = await ctx.db.get(authUserId as Id<"users">);
    const current = user?.purchasedCredits || 0;
    await ctx.db.patch(authUserId as Id<"users">, {
      purchasedCredits: current + credits,
      isPremium: true,
    });

    // Record the redemption so the same code can't be reused.
    await ctx.db.insert("promoRedemptions", {
      userId: authUserId as Id<"users">,
      code: args.code,
      redeemedAt: Date.now(),
    });

    return { success: true, durationDays: 30, credits };
  },
});

// ─── Complete Chat Tips (mark that user has seen chat tips) ──────────────────
export const completeChatTips = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx);
    await ctx.db.patch(authUserId as Id<"users">, { chatTipsCompleted: true });
    return { success: true };
  },
});

// ─── Complete Video Preview Tips ────────────────────────────────────────────
export const completeVideoPreviewTips = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx);
    await ctx.db.patch(authUserId as Id<"users">, { videoPreviewTipsCompleted: true });
    return { success: true };
  },
});



import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// RevenueCat webhook ingestion - internal mutations/queries called by
// convex/http.ts after signature verification.
// ─────────────────────────────────────────────────────────────────────────────

// Product ID -> credits mapping for non-subscription (consumable) purchases.
// Must match CREDIT_PACKS in contexts/PaywallContext.tsx.
const CREDIT_PRODUCT_MAP: Record<string, number> = {
  credits_10: 10,
  credits_20: 20,
  credits_50: 50,
};

// ─── Public: bind RevenueCat app_user_id to the logged-in user ───────────────
// Called by the app right after Purchases.logIn(convexUserId) succeeds.
// Rebinding to a different user (e.g. after account switch) overwrites the
// previous binding, mirroring RevenueCat's own logIn semantics.
export const bindRevenueCatUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("user not found");
    }
    await ctx.db.patch(args.userId, {
      revenuecatAppUserId: args.userId,
    });
    return { success: true };
  },
});

// ─── Internal: record event + idempotency check ────────────────────────────
// Returns {isNew: false} if the event was already processed (duplicate).
export const internalRecordEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventType: v.string(),
    appUserId: v.string(),
  },
  handler: async (ctx, args): Promise<{ isNew: boolean }> => {
    const existing = await ctx.db
      .query("revenuecatEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();
    if (existing) {
      return { isNew: false };
    }
    await ctx.db.insert("revenuecatEvents", {
      eventId: args.eventId,
      eventType: args.eventType,
      appUserId: args.appUserId,
      processedAt: Date.now(),
    });
    return { isNew: true };
  },
});

// ─── Internal: resolve app_user_id -> Convex user ──────────────────────────
// Primary: revenuecatAppUserId field (written at Purchases.logIn).
// Fallback: legacy anonymous IDs ("$RCAnonymousID:xxx") have no mapping and
// return null - those purchases cannot be attributed and are ignored.
export const internalResolveUser = internalQuery({
  args: { appUserId: v.string() },
  handler: async (ctx, args): Promise<{
    userId: Id<"users"> | null;
  }> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_revenuecat_app_user_id", (q) =>
        q.eq("revenuecatAppUserId", args.appUserId)
      )
      .first();
    return { userId: user?._id ?? null };
  },
});

// ─── Internal: process a purchase/subscription event ────────────────────────
// This is the single place where credits/subscription state may be granted.
export const internalProcessEvent = internalMutation({
  args: {
    userId: v.id("users"),
    eventType: v.string(),
    productId: v.optional(v.string()),
    expiresDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return { success: false, reason: "user_not_found" };
    }

    switch (args.eventType) {
      // Subscription lifecycle -> premium on
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELED_SUBSCRIPTION":
      case "NON_RENEWING_PURCHASE":
        if (args.productId && CREDIT_PRODUCT_MAP[args.productId]) {
          // Consumable credit pack
          const credits = CREDIT_PRODUCT_MAP[args.productId];
          const current = user.purchasedCredits || 0;
          await ctx.db.patch(args.userId, {
            purchasedCredits: current + credits,
          });
        } else {
          // Subscription product
          await ctx.db.patch(args.userId, {
            isPremium: true,
            ...(args.expiresDate ? { subscriptionExpiresAt: args.expiresDate } : {}),
          });
        }
        break;

      // Subscription ended -> premium off
      case "EXPIRATION":
      case "SUBSCRIPTION_STOPPED": // custom reason mapping
      case "CANCELLATION":
        await ctx.db.patch(args.userId, {
          isPremium: false,
        });
        break;

      // Billing issue: RevenueCat docs recommend revoking access until resolved
      case "BILLING_ISSUE":
        await ctx.db.patch(args.userId, {
          isPremium: false,
        });
        break;

      default:
        // TRANSFER, SUBSCRIPTION_EXTENDED, etc. - no state change needed
        return { success: true, reason: "ignored_event_type" };
    }

    return { success: true };
  },
});

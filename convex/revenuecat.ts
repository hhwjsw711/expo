import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAuth } from "./auth";

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
    const authUserId = await requireAuth(ctx);
    // Use the authenticated user's ID, not the client-supplied one
    const user = await ctx.db.get(authUserId as any);
    if (!user) {
      throw new Error("user not found");
    }
    await ctx.db.patch(authUserId as any, {
      revenuecatAppUserId: authUserId,
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
      // Subscription lifecycle -> premium on.
      // UNCANCELLATION: user re-enabled auto-renewal after cancelling
      // (official RevenueCat event name; NOT "UNCANCELED_SUBSCRIPTION").
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION":
      case "SUBSCRIPTION_EXTENDED":
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

      // Subscription ended -> premium off.
      // EXPIRATION is the ONLY event where access should be revoked
      // (official semantics). This covers both natural expiry and
      // cancellation reaching end of paid period (expiration_reason
      // will be e.g. CANCELED or BILLING_ERROR, both handled here).
      case "EXPIRATION":
        await ctx.db.patch(args.userId, {
          isPremium: false,
        });
        break;

      // CANCELLATION: user turned off auto-renewal, but the current
      // paid period is still active. Per official docs, access must
      // NOT be revoked here - wait for EXPIRATION.
      case "CANCELLATION":
        return { success: true, reason: "no_state_change" };

      // BILLING_ISSUE: payment failed but the subscription is not
      // necessarily expired. RevenueCat may retry and there is a
      // grace period (grace_period_expiration_at_ms). Access is kept;
      // EXPIRATION with expiration_reason=BILLING_ERROR handles revoke.
      case "BILLING_ISSUE":
        return { success: true, reason: "no_state_change" };

      // BILLING_ISSUE resolved: payment succeeded again, keep premium.
      case "BILLING_ISSUE_RESOLVED":
        return { success: true, reason: "no_state_change" };

      default:
        // TRANSFER, PRODUCT_CHANGE, etc. - no state change needed
        return { success: true, reason: "ignored_event_type" };
    }

    return { success: true };
  },
});

// ─── Shared paid-pipeline quota gate (P0-1 / P0-2) ──────────────────────────
// Pure decision logic, unit-testable without a Convex runtime.
// The calling mutations (markProjectSubmitted / regenerateProjectEditing)
// own the transactional side: every decision path MUST patch the user doc
// (lifetimeGeneratedCount++ and/or credit deduction) — that write is the
// OCC anchor that serializes concurrent gates for the same user (Convex
// auto-retries conflicting mutations), which is what actually closes the
// free-tier TOCTOU.
//
// Product semantics (frozen by adversarial review, H3): a "generation" is
// ANY entry into the paid pipeline — free-tier, credit-charged, or premium.
// Credit-charged submissions also consume the free-tier count, exactly
// like the old row-count semantics they replace.

export const FREE_TIER_LIMIT = 3;

// H7: max user messages per project conversation. Enforced server-side in
// addChatMessage (each user message drives a paid Claude call); the client
// mirrors it in chat-composer.tsx for UX only. Single constant shared by
// both sides — keep the client import aliased to this, never re-hardcode.
export const MAX_USER_MESSAGES_PER_PROJECT = 10;

export type CreditSource = "subscription" | "purchased";

export type QuotaDecision =
  | { action: "premium" }
  | { action: "free" }
  | { action: "charge"; source: CreditSource }
  | { action: "reject" };

/**
 * Decide how a paid-pipeline entry is billed.
 *
 * - Premium → unlimited, no deduction.
 * - Under the lifetime free limit → free (counter still increments).
 * - At/over the limit with credits → charge 1 credit, subscription first.
 * - At/over the limit with 0 credits → reject (caller throws
 *   FREE_TIER_LIMIT_REACHED; the client already maps this to /paywall).
 */
export function decideQuota(input: {
  isPremium: boolean;
  subscriptionCredits: number;
  purchasedCredits: number;
  lifetimeGenerated: number;
}): QuotaDecision {
  if (input.isPremium) return { action: "premium" };
  if (input.lifetimeGenerated < FREE_TIER_LIMIT) return { action: "free" };
  const totalCredits = input.subscriptionCredits + input.purchasedCredits;
  if (totalCredits <= 0) return { action: "reject" };
  return {
    action: "charge",
    // Charge subscription credits first, then purchased — matches the
    // pre-existing behavior in markProjectSubmitted (tasks.ts R2).
    source: input.subscriptionCredits > 0 ? "subscription" : "purchased",
  };
}

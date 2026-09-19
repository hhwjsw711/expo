// Quota gate decision tests (convex/lib/quota.ts) — P0-1/P0-2.
// Run with: bun test tests/quota.test.ts
// (bun's built-in test runner — no new dependencies.)
//
// The gate's transactional half (applyPaidPipelineGate in convex/tasks.ts)
// cannot run outside Convex; these tests pin down the decision logic it
// delegates to, including the product semantics frozen by the adversarial
// review (H3): credit-charged entries also consume the free-tier count.
import { describe, expect, test } from "bun:test";
import { decideQuota, FREE_TIER_LIMIT, MAX_USER_MESSAGES_PER_PROJECT, type QuotaDecision } from "../convex/lib/quota";

const base = {
  isPremium: false,
  subscriptionCredits: 0,
  purchasedCredits: 0,
  lifetimeGenerated: 0,
};

// ─── premium ──────────────────────────────────────────────────────────────

describe("decideQuota — premium", () => {
  test("premium is unlimited regardless of count or credits", () => {
    const d = decideQuota({ ...base, isPremium: true, lifetimeGenerated: 999 });
    expect(d.action).toBe("premium");
  });
});

// ─── free tier ────────────────────────────────────────────────────────────

describe("decideQuota — free tier", () => {
  test("first entry is free", () => {
    expect(decideQuota(base).action).toBe("free");
  });

  test("entry just below the limit is free", () => {
    const d = decideQuota({ ...base, lifetimeGenerated: FREE_TIER_LIMIT - 1 });
    expect(d.action).toBe("free");
  });

  test("FREE_TIER_LIMIT is 3 (guard against silent semantic drift)", () => {
    expect(FREE_TIER_LIMIT).toBe(3);
  });

  test("MAX_USER_MESSAGES_PER_PROJECT is 10 (client mirror guard)", () => {
    expect(MAX_USER_MESSAGES_PER_PROJECT).toBe(10);
  });
});

// ─── charging ─────────────────────────────────────────────────────────────

describe("decideQuota — charging beyond the free tier", () => {
  test("at the limit with credits → charge", () => {
    const d = decideQuota({ ...base, lifetimeGenerated: 3, purchasedCredits: 2 });
    expect(d).toEqual({ action: "charge", source: "purchased" });
  });

  test("subscription credits are charged first (matches pre-existing behavior)", () => {
    const d = decideQuota({
      ...base,
      lifetimeGenerated: 5,
      subscriptionCredits: 2,
      purchasedCredits: 7,
    });
    expect(d).toEqual({ action: "charge", source: "subscription" });
  });

  test("falls back to purchased when subscription is empty", () => {
    const d = decideQuota({ ...base, lifetimeGenerated: 5, purchasedCredits: 1 });
    expect(d).toEqual({ action: "charge", source: "purchased" });
  });

  test("far beyond the limit still charges (lifetime counter never resets)", () => {
    const d = decideQuota({ ...base, lifetimeGenerated: 42, subscriptionCredits: 1 });
    expect(d).toEqual({ action: "charge", source: "subscription" });
  });
});

// ─── rejection ────────────────────────────────────────────────────────────

describe("decideQuota — rejection", () => {
  test("at the limit with zero credits → reject", () => {
    const d = decideQuota({ ...base, lifetimeGenerated: 3 });
    expect(d.action).toBe("reject");
  });

  test("beyond the limit with zero credits → reject", () => {
    const d = decideQuota({ ...base, lifetimeGenerated: 99 });
    expect(d.action).toBe("reject");
  });
});

// ─── exhaustive guard ─────────────────────────────────────────────────────

describe("decideQuota — decision space sanity", () => {
  test("every input maps to exactly one of the four actions", () => {
    const actions: QuotaDecision["action"][] = [];
    for (const isPremium of [false, true]) {
      for (const sub of [0, 1]) {
        for (const purchased of [0, 1]) {
          for (const count of [0, 2, 3, 10]) {
            actions.push(
              decideQuota({
                isPremium,
                subscriptionCredits: sub,
                purchasedCredits: purchased,
                lifetimeGenerated: count,
              }).action,
            );
          }
        }
      }
    }
    expect(new Set(actions)).toEqual(new Set(["premium", "free", "charge", "reject"]));
    expect(actions).toHaveLength(32);
  });
});

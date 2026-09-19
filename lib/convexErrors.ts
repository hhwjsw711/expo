// Structured Convex error codes (M16) — replaces fragile error-message
// string matching on the client. The server throws
// `new ConvexError({ code })` from the quota gate and the message cap
// (convex/tasks.ts); this helper extracts the code with a legacy
// plain-Error fallback so any not-yet-migrated throw site still resolves.
import { ConvexError } from "convex/values";

export const ERROR_CODES = {
  FREE_TIER_LIMIT_REACHED: "FREE_TIER_LIMIT_REACHED",
  MAX_USER_MESSAGES_REACHED: "MAX_USER_MESSAGES_REACHED",
} as const;

/**
 * Extract a structured error code from a caught error, or null.
 * Handles ConvexError({ code }) payloads and legacy plain Errors whose
 * message contains the code (covers deployments mid-migration).
 */
export function getErrorCode(err: unknown): string | null {
  if (err instanceof ConvexError) {
    const data = err.data as unknown;
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "code" in data) {
      return String((data as { code: unknown }).code);
    }
    return null;
  }
  const msg = err instanceof Error ? err.message : String(err);
  for (const code of Object.values(ERROR_CODES)) {
    if (msg.includes(code)) return code;
  }
  return null;
}

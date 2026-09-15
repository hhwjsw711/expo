import { SignJWT, importPKCS8 } from "jose";

// ─── JWT constants ───────────────────────────────────────────────────────────
// applicationID must match `aud` claim; issuer must match `iss` claim.
// Both must match convex/auth.config.ts.
export const JWT_APPLICATION_ID = "wordream-app";
export const JWT_ISSUER = "https://wordream.convex.cloud";
export const JWT_ALGORITHM = "RS256";
export const JWT_KEY_ID = "wordream-jwt-2026-09";
export const JWT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// --- Sign a JWT for a user ───────────────────────────────────────────────────
// Used by login endpoints (verifyOTP / backdoorLogin / testAccountLogin /
// verifyTwilioOTP). Private key comes from JWT_PRIVATE_KEY env var (Convex,
// dev only). Unset -> signing fails closed (no token issued).
export async function signUserJWT(userId: string): Promise<string> {
  const privateKeyPem = process.env.JWT_PRIVATE_KEY;
  if (!privateKeyPem) {
    throw new Error("JWT_PRIVATE_KEY is not configured on this deployment");
  }

  let privateKey;
  try {
    privateKey = await importPKCS8(privateKeyPem, JWT_ALGORITHM);
  } catch (error) {
    console.error("[auth] failed to parse JWT_PRIVATE_KEY:", error);
    throw new Error("JWT_PRIVATE_KEY is invalid");
  }

  return await new SignJWT({})
    .setProtectedHeader({ alg: JWT_ALGORITHM, typ: "JWT", kid: JWT_KEY_ID })
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_APPLICATION_ID)
    .setIssuedAt()
    .setExpirationTime(`${JWT_TTL_SECONDS}s`)
    .sign(privateKey);
}

// ─── requireAuth helper ──────────────────────────────────────────────────────
// Reads ctx.auth.getUserIdentity() (populated by Convex after verifying the
// custom JWT) and enforces that the caller is authenticated. Returns the
// Convex user id ("sub" claim) or throws.
//
// Usage in a protected mutation/query/action:
//   const userId = await requireAuth(ctx);
// Note: actions do not have ctx.auth; use ctx.runMutation on a small
// authenticated mutation to validate, or validate via a query.
import type { MutationCtx, QueryCtx } from "./_generated/server";

export async function requireAuth(
  ctx: MutationCtx | QueryCtx
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthorized: missing or invalid authentication token");
  }
  const userId = identity.subject;
  if (!userId) {
    throw new Error("Unauthorized: token has no subject");
  }
  return userId;
}
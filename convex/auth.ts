import { SignJWT, importPKCS8 } from "jose";
import type { MutationCtx, QueryCtx, ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

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
// R3: also verifies the user record still exists. Without this, a deleted
// account's JWT remains valid for up to 30 days (JWT_TTL_SECONDS) after
// deletion — long enough to keep creating projects, uploading files, and
// burning paid pipeline runs on an account that shouldn't exist anymore.
// The extra DB read is served from Convex's transaction cache.
//
// Usage in a protected mutation/query/action:
//   const userId = await requireAuth(ctx);
// Works in all three contexts: MutationCtx, QueryCtx, ActionCtx.
// In actions, ctx.auth is available when called from an authenticated client.
// Note: scheduler-triggered actions have no auth context — do not add
// requireAuth to functions called via ctx.scheduler.runAfter().
export async function requireAuth(
  ctx: MutationCtx | QueryCtx | ActionCtx
): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthorized: missing or invalid authentication token");
  }
  const userId = identity.subject;
  if (!userId) {
    throw new Error("Unauthorized: token has no subject");
  }

  // R3: deleted accounts must not pass auth even with a valid-signature JWT.
  // ctx.db is a DatabaseReader in all three context types at runtime
  // (Convex >=1.17 exposes it on ActionCtx too), but the generated TS types
  // don't include `db` on ActionCtx — probe it safely instead of asserting.
  const ctxAny = ctx as { db?: { get(id: any): Promise<any> } };
  if (ctxAny.db?.get) {
    const user = await ctxAny.db.get(userId);
    if (!user) {
      throw new Error("Unauthorized: account no longer exists");
    }
  }
  // For action contexts where db is genuinely unavailable at runtime, the
  // check falls through — every sensitive action also re-checks project
  // ownership or reads the user record, so the residual gap is limited to
  // pure-auth helpers (generateUploadUrl), which don't burn paid APIs.

  return userId;
}

// ─── requireProjectOwnership helper ──────────────────────────────────────────
// For mutations and queries (ctx.db.get available).
// Authenticates the caller, fetches the project, and verifies ownership.
// Returns { userId, project } on success, throws on failure.
//
// Usage:
//   const { userId, project } = await requireProjectOwnership(ctx, args.projectId);
export async function requireProjectOwnership(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<"projects">
): Promise<{ userId: string; project: any }> {
  const userId = await requireAuth(ctx);
  const project = await ctx.db.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  if (project.userId !== userId) {
    throw new Error("Forbidden: not project owner");
  }
  return { userId, project };
}

// ─── Auth error sentinel ─────────────────────────────────────────────────────
// Frontend can check `err.message === AUTH_ERROR_SENTINEL` to distinguish
// auth errors from other server errors and redirect to login.
export const AUTH_ERROR_SENTINEL = "Unauthorized";

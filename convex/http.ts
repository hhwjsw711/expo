import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// ─────────────────────────────────────────────────────────────────────────────
// RevenueCat webhook
//
// Security model:
//   1. Shared-secret auth: the Authorization header must exactly equal the
//      REVENUECAT_WEBHOOK_AUTH env var (e.g. "Bearer rcw_xxx"). Missing or
//      wrong secret -> 401.
//   2. Idempotency: every event_id is stored; duplicates are dropped.
//   3. User attribution: app_user_id is resolved to a Convex user via the
//      revenuecatAppUserId field (bound at login). Unattributable events
//      (anonymous IDs) are acknowledged but ignored.
// ─────────────────────────────────────────────────────────────────────────────
http.route({
  path: "/revenuecat-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // 1. Verify shared secret
    const expectedAuth = process.env.REVENUECAT_WEBHOOK_AUTH;
    const receivedAuth = request.headers.get("authorization");
    if (!expectedAuth || receivedAuth !== expectedAuth) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Parse payload
    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const eventId: string | undefined = body?.event?.id;
    const eventType: string | undefined = body?.event?.type;
    const appUserId: string | undefined = body?.event?.app_user_id;

    if (!eventId || !eventType || !appUserId) {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Idempotency check - drop duplicates
    const recordResult = await ctx.runMutation(
      internal.revenuecat.internalRecordEvent,
      { eventId, eventType, appUserId }
    );
    if (!recordResult.isNew) {
      return new Response(JSON.stringify({ status: "duplicate_ignored" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Resolve app_user_id -> Convex user
    const { userId } = await ctx.runQuery(
      internal.revenuecat.internalResolveUser,
      { appUserId }
    );
    if (!userId) {
      // Anonymous / unbound users: acknowledge so RevenueCat stops retrying,
      // but nothing to update.
      return new Response(
        JSON.stringify({ status: "user_not_resolved" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Apply the event
    const event = body.event;
    await ctx.runMutation(internal.revenuecat.internalProcessEvent, {
      userId,
      eventType,
      productId: event.product_id ?? undefined,
      expiresDate: event.expires_date ?? undefined,
    });

    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;

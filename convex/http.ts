import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { allowedOrigins, siteUrl } from "./origins";

const http = httpRouter();

auth.addHttpRoutes(http);

// Plaid webhook receiver. Verification + routing happen in the scheduled
// node action (internal.plaid.handleWebhook); always ack fast with a 200.
http.route({
  path: "/plaid/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    const signature = request.headers.get("Plaid-Verification") ?? undefined;
    await ctx.scheduler.runAfter(0, internal.plaid.handleWebhook, {
      body,
      signature,
    });
    return new Response(null, { status: 200 });
  }),
});

// Notion OAuth redirect target.
http.route({
  path: "/notion/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const appUrl = siteUrl();
    if (error || !code || !state) {
      return Response.redirect(`${appUrl}/notion?error=oauth_denied`, 302);
    }
    try {
      const origin = await ctx.runAction(internal.notion.completeOAuth, {
        code,
        state,
      });
      return Response.redirect(`${origin ?? appUrl}/notion?connected=1`, 302);
    } catch (err) {
      console.error("notion oauth callback failed", err);
      return Response.redirect(`${appUrl}/notion?error=oauth_failed`, 302);
    }
  }),
});

// Access-password redemption. Runs over HTTP (not the websocket) so the
// caller's IP is visible for the 3-strikes ban.
const corsHeaders = (request: Request): Record<string, string> => {
  const origin = request.headers.get("Origin") ?? "";
  if (!allowedOrigins().includes(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
};

http.route({
  path: "/access/redeem",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }),
});

http.route({
  path: "/access/redeem",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const headers = { ...corsHeaders(request), "Content-Type": "application/json" };
    const body = (await request.json().catch(() => null)) as {
      password?: string;
    } | null;
    if (typeof body?.password !== "string") {
      return new Response(JSON.stringify({ result: "wrong" }), {
        status: 400,
        headers,
      });
    }
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const result = await ctx.runMutation(internal.access.attemptRedeem, {
      ip,
      password: body.password,
    });
    const status =
      result === "ok"
        ? 200
        : result === "banned"
          ? 403
          : result === "unauthenticated"
            ? 401
            : result === "unconfigured"
              ? 503
              : 401;
    return new Response(JSON.stringify({ result }), { status, headers });
  }),
});

export default http;

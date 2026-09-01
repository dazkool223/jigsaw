/**
 * Mints short-lived TURN credentials for the browser, via Cloudflare Realtime's
 * TURN service.
 *
 * WHY THIS EXISTS. Anything prefixed `VITE_` is compiled into the client
 * bundle and shipped to every visitor, so a static TURN username and password
 * put there is a free relay for anyone who opens devtools. ADR-0001's whole
 * premise is that the bundle holds nothing worth stealing. This function keeps
 * the long-lived secret (the Cloudflare Turn Key API Token) server-side and
 * hands out credentials that expire, so that stays true once TURN is switched
 * on.
 *
 * Cloudflare mints and signs the credential itself - unlike coturn's
 * "use-auth-secret" REST scheme, there is no HMAC to compute here. This
 * function's only job is to hold the API token and relay Cloudflare's
 * response, whose `{ iceServers }` shape already matches what
 * `src/net/iceServers.ts` expects.
 *
 * SET UP CLOUDFLARE
 *   Dashboard -> Realtime -> TURN Service -> Create TURN App/Key. That gives
 *   you a Turn Key ID and a Turn Key API Token; no server to run or maintain.
 *
 * DEPLOY
 *   supabase secrets set CLOUDFLARE_TURN_KEY_ID=<the Turn Key ID>
 *   supabase secrets set CLOUDFLARE_TURN_API_TOKEN=<the Turn Key API Token>
 *   supabase functions deploy turn-credentials --no-verify-jwt
 *
 * Then set, in the app's environment:
 *   VITE_TURN_CREDENTIALS_URL=https://<project-ref>.functions.supabase.co/turn-credentials
 *
 * `--no-verify-jwt` is deliberate: the app has no sign-in (ADR-0001), so there
 * is no JWT to verify. The Room code is the only credential in this system.
 * That means this endpoint is open, which is why credentials are short-lived
 * and why Cloudflare's per-key request rate should be watched for abuse.
 */

/** How long issued credentials stay valid. Long enough to join, short enough to be worthless if leaked. */
const TTL_SECONDS = 12 * 60 * 60;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // These are per-request and time-limited; a cache would hand the same
      // expiring pair to everyone and break the point of rotating them.
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const keyId = Deno.env.get("CLOUDFLARE_TURN_KEY_ID");
  const apiToken = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN");

  if (!keyId || !apiToken) {
    // The client treats any non-2xx as "no relay available" and carries on with
    // STUN, so a misconfiguration degrades instead of breaking the Room.
    console.error("turn-credentials: CLOUDFLARE_TURN_KEY_ID and/or CLOUDFLARE_TURN_API_TOKEN are not set");
    return json({ error: "TURN is not configured" }, 503);
  }

  let cfResponse: Response;
  try {
    cfResponse = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );
  } catch (err) {
    console.error(`turn-credentials: could not reach Cloudflare (${String(err)})`);
    return json({ error: "TURN provider unreachable" }, 502);
  }

  if (!cfResponse.ok) {
    console.error(`turn-credentials: Cloudflare returned ${cfResponse.status}`);
    return json({ error: "TURN provider error" }, 502);
  }

  const { iceServers } = (await cfResponse.json()) as { iceServers?: unknown };
  if (!iceServers) {
    console.error("turn-credentials: Cloudflare response had no iceServers");
    return json({ error: "TURN provider error" }, 502);
  }

  return json({ iceServers, ttlSeconds: TTL_SECONDS });
});

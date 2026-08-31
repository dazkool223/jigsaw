/**
 * Mints short-lived TURN credentials for the browser.
 *
 * WHY THIS EXISTS. Anything prefixed `VITE_` is compiled into the client
 * bundle and shipped to every visitor, so a static TURN username and password
 * put there is a free relay for anyone who opens devtools. ADR-0001's whole
 * premise is that the bundle holds nothing worth stealing. This function keeps
 * the long-lived secret server-side and hands out credentials that expire, so
 * that stays true once TURN is switched on.
 *
 * It implements coturn's REST API scheme ("use-auth-secret"), which every
 * coturn build supports and several hosted providers accept:
 *
 *   username   = "<unix expiry>:<label>"
 *   credential = base64( HMAC-SHA1( username, shared secret ) )
 *
 * coturn verifies the HMAC itself and needs no per-user database. The secret
 * never leaves this function.
 *
 * DEPLOY
 *   supabase secrets set TURN_SECRET=<the same static-auth-secret as coturn>
 *   supabase secrets set TURN_URLS='turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp,turns:relay.example.com:5349?transport=tcp'
 *   supabase functions deploy turn-credentials --no-verify-jwt
 *
 * Then set, in the app's environment:
 *   VITE_TURN_CREDENTIALS_URL=https://<project-ref>.functions.supabase.co/turn-credentials
 *
 * `--no-verify-jwt` is deliberate: the app has no sign-in (ADR-0001), so there
 * is no JWT to verify. The Room code is the only credential in this system.
 * That means this endpoint is open, which is why credentials are short-lived
 * and why the TURN server itself should have a per-session quota configured.
 *
 * Include a TCP and a TLS-on-443 URL as above, not just UDP. Networks that
 * drop UDP entirely are one of the two failure modes this whole change exists
 * to fix, and only `turns:` on 443 reliably gets through them.
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

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const secret = Deno.env.get("TURN_SECRET");
  const urls = (Deno.env.get("TURN_URLS") ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  if (!secret || urls.length === 0) {
    // The client treats any non-2xx as "no relay available" and carries on with
    // STUN, so a misconfiguration degrades instead of breaking the Room.
    console.error("turn-credentials: TURN_SECRET and/or TURN_URLS are not set");
    return json({ error: "TURN is not configured" }, 503);
  }

  const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const username = `${expiry}:jigsaw`;
  const credential = await hmacSha1Base64(secret, username);

  return json({
    iceServers: [{ urls, username, credential }],
    ttlSeconds: TTL_SECONDS,
  });
});

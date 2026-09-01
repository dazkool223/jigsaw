/**
 * Builds the `RTCIceServer[]` every `RTCPeerConnection` in the app is
 * constructed with.
 *
 * Why this file exists: the app shipped with one UDP STUN server and no TURN,
 * which meant any Host behind a symmetric NAT (carrier-grade NAT on mobile
 * data is the common case) was unreachable by every Guest, from every network.
 * STUN only reports the address a NAT showed the STUN server; a symmetric NAT
 * hands out a different external port per destination, so that address is not
 * where a Guest must send. Nothing on the Guest's side fixes that. See
 * docs/rca/0001-guests-cannot-connect-across-networks.md.
 *
 * Two ways to supply TURN, in order of preference:
 *
 *   1. VITE_TURN_CREDENTIALS_URL - an endpoint that mints SHORT-LIVED
 *      credentials per request. This is the production setup. A ready-to-
 *      deploy Supabase Edge Function is in supabase/functions/turn-credentials.
 *
 *   2. VITE_TURN_URLS + VITE_TURN_USERNAME + VITE_TURN_CREDENTIAL - static
 *      credentials compiled into the bundle. Fine for a local coturn while
 *      testing; NOT fine in production. Anything prefixed VITE_ is shipped to
 *      every browser, so a static TURN password is a free relay for whoever
 *      reads the bundle. ADR-0001 is explicit that the client bundle holds no
 *      credential worth stealing, and a static TURN secret breaks that. This
 *      path logs a warning every time it is used.
 *
 * With neither set the app still runs, exactly as it does today, on STUN
 * alone - and `hasRelay()` reports false so the failure copy can say the real
 * reason ("this network needs a relay, and none is configured") rather than
 * blaming the user's Wi-Fi.
 */

import { ICE_CREDENTIAL_REFRESH_MARGIN_MS, ICE_FETCH_TIMEOUT_MS, STUN_SERVERS } from "../config";

/** What VITE_TURN_CREDENTIALS_URL is expected to return. */
interface IceCredentialsResponse {
  /** Providers differ: Cloudflare returns one object, coturn helpers an array. Both accepted. */
  readonly iceServers: RTCIceServer | readonly RTCIceServer[];
  /** Seconds the credentials stay valid. Used to decide when to re-fetch. */
  readonly ttlSeconds?: number;
}

const STUN_ONLY: readonly RTCIceServer[] = [{ urls: [...STUN_SERVERS] }];

/** Default validity assumed when a credentials endpoint doesn't say. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

interface CachedServers {
  readonly servers: readonly RTCIceServer[];
  /** Epoch ms after which these must be re-fetched. */
  readonly expiresAt: number;
}

let cache: CachedServers | undefined;
let inFlight: Promise<readonly RTCIceServer[]> | undefined;
let warnedAboutStaticCredentials = false;

function env(name: string): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>)[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/** `a, b , c` -> `["a", "b", "c"]`. Empty entries dropped. */
function splitUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/** True if any server in the list can allocate a relay (i.e. is TURN, not STUN). */
export function hasRelay(servers: readonly RTCIceServer[]): boolean {
  return servers.some((s) => {
    const urls = typeof s.urls === "string" ? [s.urls] : s.urls;
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });
}

function staticTurnServer(): RTCIceServer | undefined {
  const urls = env("VITE_TURN_URLS");
  if (!urls) return undefined;
  const username = env("VITE_TURN_USERNAME");
  const credential = env("VITE_TURN_CREDENTIAL");
  if (!username || !credential) {
    console.warn(
      "[ice] VITE_TURN_URLS is set but VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL are not - ignoring it. TURN needs all three.",
    );
    return undefined;
  }
  if (!warnedAboutStaticCredentials) {
    warnedAboutStaticCredentials = true;
    console.warn(
      "[ice] Using STATIC TURN credentials from the bundle. Anyone who opens devtools has them. " +
        "Use VITE_TURN_CREDENTIALS_URL with short-lived credentials in production.",
    );
  }
  return { urls: splitUrls(urls), username, credential };
}

function normaliseResponse(body: unknown): readonly RTCIceServer[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = (body as { iceServers?: unknown }).iceServers;
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const servers = list.filter(
    (s): s is RTCIceServer =>
      typeof s === "object" &&
      s !== null &&
      "urls" in s &&
      (typeof (s as RTCIceServer).urls === "string" || Array.isArray((s as RTCIceServer).urls)),
  );
  return servers.length > 0 ? servers : undefined;
}

async function fetchIceServers(url: string): Promise<CachedServers | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`[ice] credentials endpoint returned ${response.status} - falling back to STUN only`);
      return undefined;
    }
    const body = (await response.json()) as IceCredentialsResponse;
    const servers = normaliseResponse(body);
    if (!servers) {
      console.warn("[ice] credentials endpoint returned no usable iceServers - falling back to STUN only");
      return undefined;
    }
    const ttlMs =
      typeof body.ttlSeconds === "number" && body.ttlSeconds > 0
        ? body.ttlSeconds * 1000
        : DEFAULT_TTL_MS;
    // Re-fetch before the credentials actually expire: a connection started
    // just under the wire would otherwise get a relay allocation refused
    // partway through negotiation.
    const lifetime = Math.max(ttlMs - ICE_CREDENTIAL_REFRESH_MARGIN_MS, ttlMs / 2);
    return {
      servers: [...STUN_ONLY, ...servers],
      expiresAt: Date.now() + lifetime,
    };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timed out" : String(err);
    console.warn(`[ice] could not reach the credentials endpoint (${reason}) - falling back to STUN only`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The ICE servers to build the next `RTCPeerConnection` with. Cached for the
 * credentials' lifetime, so the common case is a resolved promise and the
 * connect path pays nothing.
 *
 * Never rejects. A TURN endpoint that is down degrades to STUN only, which is
 * worse but still works for most players, rather than blocking the Room.
 */
export async function resolveIceServers(): Promise<readonly RTCIceServer[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.servers;
  if (inFlight) return inFlight;

  const endpoint = env("VITE_TURN_CREDENTIALS_URL");
  if (!endpoint) {
    const staticTurn = staticTurnServer();
    const servers = staticTurn ? [...STUN_ONLY, staticTurn] : STUN_ONLY;
    if (!staticTurn) {
      console.warn(
        "[ice] No TURN server configured (VITE_TURN_CREDENTIALS_URL or VITE_TURN_URLS). " +
          "Players behind a symmetric NAT - most mobile data connections - will not be able to connect. " +
          "See docs/rca/0001-guests-cannot-connect-across-networks.md",
      );
    }
    // Static config can't go stale, but still cache so the warning is not
    // reprinted on every connection attempt.
    cache = { servers, expiresAt: Date.now() + DEFAULT_TTL_MS };
    return servers;
  }

  inFlight = (async () => {
    const fetched = await fetchIceServers(endpoint);
    cache = fetched ?? { servers: STUN_ONLY, expiresAt: Date.now() + ICE_FETCH_TIMEOUT_MS };
    inFlight = undefined;
    return cache.servers;
  })();
  return inFlight;
}

/**
 * Warm the cache so `resolveIceServers()` is already resolved by the time a
 * connection starts. Call on entering a Room; safe to call repeatedly.
 */
export function primeIceServers(): void {
  void resolveIceServers();
}

/** Tests only - drops the cached credentials and the "warned once" latch. */
export function resetIceServersForTest(): void {
  cache = undefined;
  inFlight = undefined;
  warnedAboutStaticCredentials = false;
}

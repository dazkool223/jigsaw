/**
 * Hash routing (see plan "Stack": static hosting needs no rewrite rules, so
 * `/#/r/<roomCode>` addresses a Room rather than a real path). Pure and
 * unit-tested - no DOM dependency beyond `location.hash` / `hashchange`,
 * which are only touched by the thin wrappers at the bottom of this file.
 *
 * Parsing is defensive by design: anything that isn't exactly `#/r/<code>`
 * (empty hash, junk, an unknown route, a code with an embedded slash) falls
 * back to Home rather than throwing or rendering a broken Room screen.
 */

export type Route = { readonly kind: "home" } | { readonly kind: "room"; readonly code: string };

const HOME_ROUTE: Route = { kind: "home" };

/** Matches "#/r/<code>" with a non-empty, single-segment code. */
const ROOM_HASH_PATTERN = /^#\/r\/([^/]+)$/;

/**
 * Parses a `location.hash`-shaped string (leading `#` included, as the
 * browser provides it) into a Route. Never throws - anything that doesn't
 * cleanly match the Room pattern is Home.
 */
export function parseHash(hash: string): Route {
  if (!hash || hash === "#" || hash === "#/") return HOME_ROUTE;

  const match = ROOM_HASH_PATTERN.exec(hash);
  if (!match) return HOME_ROUTE;

  const raw = match[1];
  let code: string;
  try {
    code = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding - treat as junk rather than crashing.
    return HOME_ROUTE;
  }
  if (code.trim() === "") return HOME_ROUTE;

  return { kind: "room", code };
}

/** Builds the `location.hash` string (including leading `#`) for Home. */
export function buildHomeHash(): string {
  return "#/";
}

/** Builds the `location.hash` string (including leading `#`) for a Room. */
export function buildRoomHash(code: string): string {
  return `#/r/${encodeURIComponent(code)}`;
}

/** The full join URL for a Room, suitable for ShareLink - origin + path + hash. */
export function buildRoomUrl(code: string, origin: string = defaultOrigin()): string {
  return `${origin}${buildRoomHash(code)}`;
}

function defaultOrigin(): string {
  return typeof location !== "undefined" ? `${location.origin}${location.pathname}` : "";
}

// ── Thin DOM wrappers - not exercised by routing.test.ts, kept minimal ──────

/** Reads the current route from `location.hash`. */
export function getCurrentRoute(): Route {
  return parseHash(typeof location !== "undefined" ? location.hash : "");
}

/** Navigates to Home by setting `location.hash`. */
export function navigateHome(): void {
  if (typeof location !== "undefined") location.hash = buildHomeHash();
}

/** Navigates to a Room by setting `location.hash`. */
export function navigateToRoom(code: string): void {
  if (typeof location !== "undefined") location.hash = buildRoomHash(code);
}

/** Subscribes to route changes (browser `hashchange`). Returns an unsubscribe fn. */
export function onRouteChange(handler: (route: Route) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler(getCurrentRoute());
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

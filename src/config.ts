/**
 * Every tunable constant in the project, with its meaning and the impact of
 * changing it. Nothing else in the codebase should hard-code a magic number.
 *
 * The file has two halves, and they are NOT equally safe to change:
 *
 *   GEOMETRY  - part of a Room's identity. A Room persists only
 *               (image, seed, rows, cols) and regenerates all geometry from it,
 *               so changing any geometry constant makes existing Rooms
 *               regenerate DIFFERENT shapes while their saved Snapshots still
 *               describe the old ones. Bump GEOMETRY_VERSION when you touch
 *               anything in this half; the Room row stores it so a mismatch
 *               becomes a clear message instead of a corrupt board.
 *
 *   RUNTIME   - safe to tune at any time. No effect on puzzle identity.
 */

// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY - baked into puzzle identity. Bump GEOMETRY_VERSION when changing.
// ─────────────────────────────────────────────────────────────────────────────

/** Bump whenever ANY constant in the geometry half changes. */
export const GEOMETRY_VERSION = 1;

/**
 * Selectable piece counts. Approximate: the grid is fitted to the image aspect
 * so cells stay roughly square, e.g. "500" on 4:3 yields 26x19 = 494.
 */
export const PIECE_PRESETS = [24, 100, 300, 500] as const;

/**
 * Longest edge of the normalised image, in pixels. Drives Cell size and
 * therefore texture sharpness. Larger = crisper but slower upload, more GPU
 * memory and a bigger atlas.
 */
export const IMAGE_MAX_EDGE = 2048;

/**
 * Tab height as a fraction of the SHORTER Cell dimension (cells are not exactly
 * square). ~0.22 is the classic jigsaw look. Larger = chunkier, more
 * distinctive Tabs, more texture overhang and fewer atlas slots.
 */
export const TAB_SIZE_RATIO = 0.22;

/**
 * Per-Edge random variation in Tab size, as a +/- fraction of TAB_SIZE_RATIO.
 * 0 makes every Tab identical, which looks machine-stamped.
 */
export const TAB_SIZE_JITTER = 0.15;

/**
 * Max displacement of interior Cell vertices as a fraction of Cell size - the
 * "hand-cut" look that stops the puzzle reading as a perfect grid. Too large
 * and a Tab neck can collide with an adjacent cut line: keep <= 0.10.
 */
export const VERTEX_JITTER = 0.08;

/**
 * How far along an Edge the Tab sits, as a fraction from the edge midpoint.
 * The Tab centre is 0.5 +/- this much. Keeps Tabs off the corners.
 */
export const TAB_POSITION_JITTER = 0.04;

/** Tab neck width as a fraction of Edge length. The pinch that makes Pieces lock. */
export const TAB_NECK_RATIO = 0.18;

/** Tab bulb width as a fraction of Edge length. Must exceed TAB_NECK_RATIO to interlock. */
export const TAB_BULB_RATIO = 0.34;

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME - safe to tune any time; no effect on puzzle identity.
// ─────────────────────────────────────────────────────────────────────────────

// ── Rendering ──

/**
 * Texture resolution multiplier when baking Pieces. Trades crispness at max
 * zoom against GPU memory: 2 keeps Pieces sharp at ZOOM_MAX but may need a
 * second atlas sheet at 500 pieces. Measure on real hardware before raising.
 */
export const BAKE_SCALE = 2;

/** Atlas sheet edge in pixels. More Pieces per sheet = fewer draw batches. */
export const ATLAS_SIZE = 4096;

/**
 * Outward expansion of each Piece's bake, in pixels. Adjacent baked Pieces are
 * complementary alpha shapes; without this overlap their antialiased edges
 * leave a visible hairline seam across the assembled image. 0 = seams appear.
 */
export const BAKE_EXPAND_PX = 1;

/** Transparent padding between Pieces in the atlas, to stop texture bleed. */
export const ATLAS_PADDING_PX = 2;

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;

/** Smoothing applied to other players' motion. Higher = smoother but laggier. */
export const REMOTE_LERP_MS = 100;

// ── Gameplay ──

/**
 * Merge distance as a fraction of Cell size. Higher = more forgiving snapping
 * but more accidental merges.
 */
export const SNAP_TOLERANCE = 0.15;

/**
 * How far outside the image Pieces are scattered at the start, as a multiple of
 * image size. Larger = more spread out, more panning to find Pieces.
 */
export const SCATTER_MARGIN = 0.35;

// ── Image upload ──

/** Files larger than this are rejected before we attempt to decode them. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export const WEBP_QUALITY = 0.8;

/** Used only when the browser cannot encode WebP. */
export const JPEG_FALLBACK_QUALITY = 0.85;

// ── Networking ──

/**
 * Host + 7 Guests. Star fan-out is O(n^2) through one residential uplink, so
 * this cannot grow far: at STREAM_HZ=25 and 8 players it is ~1050 msgs/sec.
 */
export const MAX_PLAYERS = 8;

/**
 * Display-name cap. A name rides every JOIN and then sits in a fixed-width
 * chip in the board chrome, so this is a layout bound as much as a wire one.
 * Applies wherever a name can be typed - the home screen and the in-room list.
 */
export const PLAYER_NAME_MAX_LENGTH = 24;

/** Cursor / mid-drag update rate. Higher = smoother remote motion, more bandwidth. */
export const STREAM_HZ = 25;

/**
 * Overall budget for a Guest to go from "offer sent" to "control channel
 * open". Covers signaling round-trips, ICE gathering, connectivity checks,
 * a possible TURN relay allocation and the DTLS handshake.
 *
 * This was 15s, which is tight for that whole chain over cellular - a
 * connection that would have succeeded got killed partway through. Fail-fast
 * for the case actually worth failing fast on (the Host never answering) now
 * lives in ANSWER_TIMEOUT_MS below, so this one can afford to be patient.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long a Guest waits for the Host's SDP answer before giving up. Purely a
 * signaling round-trip through Supabase Realtime, so it is quick when it works
 * at all; exceeding it means nobody is hosting (a stale Realtime presence
 * entry left by a slept laptop or a backgrounded mobile tab), not that the
 * network is bad. Kept well under CONNECT_TIMEOUT_MS so that diagnosis wins.
 */
export const ANSWER_TIMEOUT_MS = 8_000;

/** How long to wait on the TURN credentials endpoint before falling back to STUN only. */
export const ICE_FETCH_TIMEOUT_MS = 5_000;

/**
 * Re-fetch TURN credentials this long before they expire. Without a margin, a
 * connection started just under the wire can have its relay allocation refused
 * mid-negotiation.
 */
export const ICE_CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Host's periodic full-state broadcast, the drift safety net. */
export const RESYNC_INTERVAL_MS = 30_000;

/**
 * STUN alone only solves the easy half of NAT traversal. TURN is configured at
 * runtime from environment variables rather than here, because its credentials
 * must be short-lived - see net/iceServers.ts.
 */
export const STUN_SERVERS = ["stun:stun.l.google.com:19302"] as const;

// ── Persistence ──

/**
 * Snapshot write debounce. Lower = less progress lost if the Host crashes, but
 * more database writes.
 */
export const SNAPSHOT_DEBOUNCE_MS = 10_000;

/** The Room code IS the credential. Shorter = guessable. Do not reduce. */
export const ROOM_CODE_LENGTH = 10;

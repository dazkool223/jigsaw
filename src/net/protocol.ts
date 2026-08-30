/**
 * The canonical wire protocol for `src/net/`. Discriminated union on `type`,
 * JSON-encoded. This is the ONLY source of truth for what crosses the WebRTC
 * data channels - `hostNet.ts` / `guestNet.ts` never invent ad-hoc shapes.
 *
 * Two channels carry these messages (see `Channel` in `../types`):
 *   - `control` (reliable/ordered): JOIN, WELCOME, FULL_STATE, STATE_REQUEST,
 *     GRAB, GRAB_GRANTED, GRAB_DENIED, DROP, SNAP, PLAYER_LIST, COMPLETE,
 *     ROOM_FULL, HOST_CHANGED.
 *   - `stream` (unreliable/unordered, ~STREAM_HZ): MOVE, CURSOR. Both carry a
 *     monotonic `seq` so a receiver can drop anything older than the last
 *     seq it accepted - see `dropStale`.
 *
 * Everything arrives from the network, so nothing here is trusted by
 * construction. `parseMessage` is the single validated entry point: it never
 * throws, and returns `null` for anything that isn't a well-formed message.
 * Per-type guards (`isJoinMessage`, etc.) are exported too, for callers that
 * already know which shape they expect (e.g. after switching on `.type`).
 *
 * SEQUENCING: `seq` appears on two, deliberately different, kinds of
 * message:
 *   - Genuine `control`-channel BROADCASTS (GRAB_GRANTED, SNAP, PLAYER_LIST,
 *     COMPLETE, and the periodic-resync use of FULL_STATE) increment a
 *     single Host-side counter. A receiver gap-checks these against the
 *     last `seq` it accepted and pulls a resync (STATE_REQUEST) on a gap.
 *   - Unicast replies that also happen to carry `seq` (WELCOME, and the
 *     on-demand-reply use of FULL_STATE) use it only to (re-)establish the
 *     ONE Guest's baseline - the Host stamps the CURRENT counter value
 *     without incrementing it, and the receiver adopts it rather than
 *     gap-checking it. Otherwise, answering one Guest's on-demand
 *     STATE_REQUEST would manufacture a phantom sequence gap for everyone
 *     else, since they didn't see that unicast reply go by.
 *   - GRAB_DENIED and ROOM_FULL carry no `seq` at all: they're terminal,
 *     unicast, one-off replies outside the ordered stream.
 *   - `stream`-channel messages (MOVE, CURSOR) carry `seq` for an unrelated
 *     reason: not gap-detection but staleness-dropping (`dropStale`), since
 *     that channel is unreliable/unordered and drops there are normal, not
 *     bugs. Each sender keeps one counter for everything it sends on
 *     `stream`; each receiver keeps one `lastSeq` per *sender* it hears
 *     from.
 */

import type {
  GameState,
  Group,
  GroupId,
  PieceId,
  Player,
  PlayerId,
  Point,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Message shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Guest -> Host. First message on `control` after the data channel opens. */
export type JoinMessage = {
  readonly type: "JOIN";
  readonly playerId: PlayerId;
  readonly name: string;
  readonly color: string;
};

/**
 * Host -> Guest, reply to JOIN. Carries full authoritative state so the Guest
 * never needs a separate round-trip to get in sync.
 *
 * `seq` establishes the Guest's baseline for the ordered control stream (see
 * the module-level "Sequencing" note below) - it is NOT gap-checked, only
 * adopted, since a unicast reply to one joining Guest must never look like a
 * dropped broadcast to anyone else.
 */
export type WelcomeMessage = {
  readonly type: "WELCOME";
  /** Echoes the joining Guest's own id, so it can be told apart from itself in `players`. */
  readonly you: PlayerId;
  readonly players: readonly Player[];
  readonly state: GameState;
  readonly hostEpoch: number;
  readonly seq: number;
};

/**
 * Host -> Guest(s). Either a periodic broadcast resync (RESYNC_INTERVAL_MS -
 * a genuine broadcast, gap-checked like any other) or a unicast reply to one
 * Guest's STATE_REQUEST (re-baselines that Guest only, not gap-checked - see
 * the module-level "Sequencing" note). Same shape either way; which one a
 * given message is depends on whether it arrived via broadcast or unicast,
 * not on anything in the payload.
 */
export type FullStateMessage = {
  readonly type: "FULL_STATE";
  readonly state: GameState;
  readonly seq: number;
};

/** Guest -> Host. Sent when a Guest notices a seq gap on `stream` and wants to resync early. */
export type StateRequestMessage = {
  readonly type: "STATE_REQUEST";
  readonly playerId: PlayerId;
};

/** Guest -> Host. Lock request on a Group. */
export type GrabMessage = {
  readonly type: "GRAB";
  readonly groupId: GroupId;
  readonly playerId: PlayerId;
};

/**
 * Host -> all. The first requester wins; broadcast (not just to the winner)
 * so every client greys out the Group, and gap-checked like any other
 * control broadcast (see the module-level "Sequencing" note). `z` is the
 * Group's new draw order after being brought to front - grabbing always
 * raises a Group, and the winner is told the resulting value directly
 * instead of recomputing bringToFront's counter locally.
 */
export type GrabGrantedMessage = {
  readonly type: "GRAB_GRANTED";
  readonly groupId: GroupId;
  readonly playerId: PlayerId;
  readonly z: number;
  readonly seq: number;
};

/**
 * Host -> the losing Guest only. Tells it to snap the Group back locally.
 * Terminal, one-off, outside the ordered control stream - no `seq` (see the
 * module-level "Sequencing" note). `reason` distinguishes a race loss
 * ("held": someone else already had it) from a stale request against a
 * Group that no longer exists ("not-found", e.g. it merged away).
 */
export type GrabDeniedMessage = {
  readonly type: "GRAB_DENIED";
  readonly groupId: GroupId;
  readonly playerId: PlayerId;
  readonly reason: "held" | "not-found";
};

/** Guest -> Host, on `stream`. Optimistic mid-drag position while holding a Group. */
export type MoveMessage = {
  readonly type: "MOVE";
  readonly seq: number;
  readonly groupId: GroupId;
  readonly playerId: PlayerId;
  readonly offset: Point;
};

/** Guest -> Host, on `control`. Authoritative drop position; Host decides Merges from this. */
export type DropMessage = {
  readonly type: "DROP";
  readonly groupId: GroupId;
  readonly playerId: PlayerId;
  readonly offset: Point;
};

/**
 * Host -> all. The atomic result of a DROP: any Groups that merged are
 * replaced by their post-merge form in `groups`; Groups absorbed into another
 * Group (and so cease to exist) are listed in `removedGroupIds`. A dropped
 * Group is implicitly no longer held - receivers should clear `heldBy` for
 * every id in both `groups` and `removedGroupIds`. `nextZ` / `nextGroupId`
 * echo the Host's authoritative counters after the merge.
 */
export type SnapMessage = {
  readonly type: "SNAP";
  readonly groups: readonly Group[];
  readonly removedGroupIds: readonly GroupId[];
  readonly nextZ: number;
  readonly nextGroupId: GroupId;
  readonly seq: number;
};

/** Any player -> all, on `stream`. Live cursor position. */
export type CursorMessage = {
  readonly type: "CURSOR";
  readonly seq: number;
  readonly playerId: PlayerId;
  readonly point: Point;
};

/**
 * Host -> all. Roster snapshot, sent on join/leave/rename. Deliberately the
 * bulk roster rather than separate PLAYER_JOINED/PLAYER_LEFT events: the
 * roster is capped at MAX_PLAYERS (8), so resending it whole is cheap, and
 * one shape covers join, leave AND rename without a third message type.
 */
export type PlayerListMessage = {
  readonly type: "PLAYER_LIST";
  readonly players: readonly Player[];
  readonly seq: number;
};

/** Host -> all. Sent once, when the Group count drops to 1. */
export type CompleteMessage = {
  readonly type: "COMPLETE";
  readonly seq: number;
};

/**
 * Host -> rejected Guest. MAX_PLAYERS already reached. May be sent either
 * over signaling (before a data channel exists) or over `control` (if the
 * cap was hit mid-handshake) - see hostNet.ts.
 */
export type RoomFullMessage = {
  readonly type: "ROOM_FULL";
};

/**
 * Host -> all. Informational notice that a newer Host Epoch has been
 * observed (e.g. via Realtime while this Host is still connected to
 * Guests). Lets connected Guests learn about the takeover from a clean
 * message instead of just an abrupt disconnect when this Host tears itself
 * down. Does NOT itself arbitrate who the Host is - the Host Epoch in the
 * database does that (see CONTEXT.md).
 */
export type HostChangedMessage = {
  readonly type: "HOST_CHANGED";
  readonly hostId: PlayerId;
  readonly hostEpoch: number;
};

export type ProtocolMessage =
  | JoinMessage
  | WelcomeMessage
  | FullStateMessage
  | StateRequestMessage
  | GrabMessage
  | GrabGrantedMessage
  | GrabDeniedMessage
  | MoveMessage
  | DropMessage
  | SnapMessage
  | CursorMessage
  | PlayerListMessage
  | CompleteMessage
  | RoomFullMessage
  | HostChangedMessage;

/** Messages sent on the unreliable `stream` channel - the ones that carry `seq`. */
export type StreamMessage = MoveMessage | CursorMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Low-level value guards
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** GroupId / PieceId are plain `number` aliases; ids are non-negative integers. */
function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlayerId(v: unknown): v is PlayerId {
  return isNonEmptyString(v);
}

function isPoint(v: unknown): v is Point {
  return isRecord(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y);
}

function isPieceIdArray(v: unknown): v is readonly PieceId[] {
  return Array.isArray(v) && v.every(isId);
}

function isGroup(v: unknown): v is Group {
  return (
    isRecord(v) &&
    isId(v.id) &&
    isPieceIdArray(v.pieceIds) &&
    isPoint(v.offset) &&
    isFiniteNumber(v.z)
  );
}

/** A key of a JSON object standing in for a numeric GroupId. */
function isNumericKey(key: string): boolean {
  return /^\d+$/.test(key);
}

function isGroupRecord(v: unknown): v is Readonly<Record<GroupId, Group>> {
  if (!isRecord(v)) return false;
  for (const key of Object.keys(v)) {
    if (!isNumericKey(key) || !isGroup(v[key])) return false;
  }
  return true;
}

function isHeldByRecord(v: unknown): v is Readonly<Record<GroupId, PlayerId>> {
  if (!isRecord(v)) return false;
  for (const key of Object.keys(v)) {
    if (!isNumericKey(key) || !isPlayerId(v[key])) return false;
  }
  return true;
}

function isGameState(v: unknown): v is GameState {
  return (
    isRecord(v) &&
    isGroupRecord(v.groups) &&
    isHeldByRecord(v.heldBy) &&
    isFiniteNumber(v.nextZ) &&
    isId(v.nextGroupId)
  );
}

function isPlayer(v: unknown): v is Player {
  return (
    isRecord(v) &&
    isPlayerId(v.id) &&
    isNonEmptyString(v.name) &&
    isNonEmptyString(v.color)
  );
}

function isPlayerArray(v: unknown): v is readonly Player[] {
  return Array.isArray(v) && v.every(isPlayer);
}

function isGroupArray(v: unknown): v is readonly Group[] {
  return Array.isArray(v) && v.every(isGroup);
}

function isGroupIdArray(v: unknown): v is readonly GroupId[] {
  return Array.isArray(v) && v.every(isId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-message guards
// ─────────────────────────────────────────────────────────────────────────────

export function isJoinMessage(m: unknown): m is JoinMessage {
  return (
    isRecord(m) &&
    m.type === "JOIN" &&
    isPlayerId(m.playerId) &&
    isNonEmptyString(m.name) &&
    isNonEmptyString(m.color)
  );
}

export function isWelcomeMessage(m: unknown): m is WelcomeMessage {
  return (
    isRecord(m) &&
    m.type === "WELCOME" &&
    isPlayerId(m.you) &&
    isPlayerArray(m.players) &&
    isGameState(m.state) &&
    isFiniteNumber(m.hostEpoch) &&
    isFiniteNumber(m.seq)
  );
}

export function isFullStateMessage(m: unknown): m is FullStateMessage {
  return (
    isRecord(m) &&
    m.type === "FULL_STATE" &&
    isGameState(m.state) &&
    isFiniteNumber(m.seq)
  );
}

export function isStateRequestMessage(m: unknown): m is StateRequestMessage {
  return isRecord(m) && m.type === "STATE_REQUEST" && isPlayerId(m.playerId);
}

export function isGrabMessage(m: unknown): m is GrabMessage {
  return (
    isRecord(m) &&
    m.type === "GRAB" &&
    isId(m.groupId) &&
    isPlayerId(m.playerId)
  );
}

export function isGrabGrantedMessage(m: unknown): m is GrabGrantedMessage {
  return (
    isRecord(m) &&
    m.type === "GRAB_GRANTED" &&
    isId(m.groupId) &&
    isPlayerId(m.playerId) &&
    isFiniteNumber(m.z) &&
    isFiniteNumber(m.seq)
  );
}

function isGrabDeniedReason(v: unknown): v is "held" | "not-found" {
  return v === "held" || v === "not-found";
}

export function isGrabDeniedMessage(m: unknown): m is GrabDeniedMessage {
  return (
    isRecord(m) &&
    m.type === "GRAB_DENIED" &&
    isId(m.groupId) &&
    isPlayerId(m.playerId) &&
    isGrabDeniedReason(m.reason)
  );
}

export function isMoveMessage(m: unknown): m is MoveMessage {
  return (
    isRecord(m) &&
    m.type === "MOVE" &&
    isFiniteNumber(m.seq) &&
    isId(m.groupId) &&
    isPlayerId(m.playerId) &&
    isPoint(m.offset)
  );
}

export function isDropMessage(m: unknown): m is DropMessage {
  return (
    isRecord(m) &&
    m.type === "DROP" &&
    isId(m.groupId) &&
    isPlayerId(m.playerId) &&
    isPoint(m.offset)
  );
}

export function isSnapMessage(m: unknown): m is SnapMessage {
  return (
    isRecord(m) &&
    m.type === "SNAP" &&
    isGroupArray(m.groups) &&
    isGroupIdArray(m.removedGroupIds) &&
    isFiniteNumber(m.nextZ) &&
    isId(m.nextGroupId) &&
    isFiniteNumber(m.seq)
  );
}

export function isCursorMessage(m: unknown): m is CursorMessage {
  return (
    isRecord(m) &&
    m.type === "CURSOR" &&
    isFiniteNumber(m.seq) &&
    isPlayerId(m.playerId) &&
    isPoint(m.point)
  );
}

export function isPlayerListMessage(m: unknown): m is PlayerListMessage {
  return (
    isRecord(m) &&
    m.type === "PLAYER_LIST" &&
    isPlayerArray(m.players) &&
    isFiniteNumber(m.seq)
  );
}

export function isCompleteMessage(m: unknown): m is CompleteMessage {
  return isRecord(m) && m.type === "COMPLETE" && isFiniteNumber(m.seq);
}

export function isRoomFullMessage(m: unknown): m is RoomFullMessage {
  return isRecord(m) && m.type === "ROOM_FULL";
}

export function isHostChangedMessage(m: unknown): m is HostChangedMessage {
  return (
    isRecord(m) &&
    m.type === "HOST_CHANGED" &&
    isPlayerId(m.hostId) &&
    isFiniteNumber(m.hostEpoch)
  );
}

export function isStreamMessage(m: unknown): m is StreamMessage {
  return isMoveMessage(m) || isCursorMessage(m);
}

// ─────────────────────────────────────────────────────────────────────────────
// The single validated entry point
// ─────────────────────────────────────────────────────────────────────────────

const GUARDS_BY_TYPE: Readonly<
  Record<ProtocolMessage["type"], (m: unknown) => boolean>
> = {
  JOIN: isJoinMessage,
  WELCOME: isWelcomeMessage,
  FULL_STATE: isFullStateMessage,
  STATE_REQUEST: isStateRequestMessage,
  GRAB: isGrabMessage,
  GRAB_GRANTED: isGrabGrantedMessage,
  GRAB_DENIED: isGrabDeniedMessage,
  MOVE: isMoveMessage,
  DROP: isDropMessage,
  SNAP: isSnapMessage,
  CURSOR: isCursorMessage,
  PLAYER_LIST: isPlayerListMessage,
  COMPLETE: isCompleteMessage,
  ROOM_FULL: isRoomFullMessage,
  HOST_CHANGED: isHostChangedMessage,
};

/**
 * Validates data that arrived from the network. Never throws, regardless of
 * input shape - returns `null` for anything malformed. `raw` is expected to
 * already be a parsed JSON value (i.e. the caller does `JSON.parse` on the
 * wire string first); a raw JSON *string* is itself rejected as malformed,
 * since a valid message is always an object.
 */
export function parseMessage(raw: unknown): ProtocolMessage | null {
  try {
    if (!isRecord(raw)) return null;
    const type = raw.type;
    if (typeof type !== "string") return null;
    const guard = (GUARDS_BY_TYPE as Record<string, (m: unknown) => boolean>)[
      type
    ];
    if (!guard) return null;
    return guard(raw) ? (raw as ProtocolMessage) : null;
  } catch {
    // Defensive: guards above are all pure/total, but a hostile or exotic
    // input (e.g. a getter that throws) must never escape as an exception.
    return null;
  }
}

/**
 * For the unreliable `stream` channel: true if `msg` is stale relative to
 * `lastSeq` and should be dropped (out of order or a duplicate). A message
 * is accepted only if its `seq` is strictly greater than the last accepted
 * seq.
 */
export function dropStale(lastSeq: number, msg: StreamMessage): boolean {
  return msg.seq <= lastSeq;
}

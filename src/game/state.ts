/**
 * Pure state transitions for the authoritative board. No I/O, no randomness,
 * no clocks — every function here is a plain reducer: `(state, ...) => state`.
 *
 * Vocabulary and invariants: see CONTEXT.md and the `Group` doc comment in
 * ../types.ts. In particular: a Group's world position for each of its
 * Pieces is always `piece.solved + group.offset` — Pieces never store their
 * own position, so merging two Groups never moves Pieces relative to each
 * other, and "correctly placed" is simply `offset === (0, 0)`.
 */

import type {
  GameState,
  Group,
  GroupId,
  Piece,
  PieceId,
  Player,
  PlayerId,
  Point,
  Puzzle,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One Group per Piece, seeded from `scatterOffsets` (keyed by PieceId — every
 * peer derives the same scatter deterministically from the Room's seed, so a
 * fresh Room needs zero position sync). Groups are drawn back-to-front in
 * ascending Piece order (arbitrary but deterministic starting z).
 *
 * A Group's id equals its founding Piece's id — Groups only ever merge
 * (shrinking the population), never split or get created afresh in v1, so
 * Piece ids double as a ready-made supply of unique starting Group ids.
 */
export function createInitialState(
  puzzle: Puzzle,
  scatterOffsets: Readonly<Record<PieceId, Point>>
): GameState {
  const groups: Record<GroupId, Group> = {};
  let z = 0;
  let maxId = -1;

  for (const piece of puzzle.pieces) {
    const offset = scatterOffsets[piece.id] ?? { x: 0, y: 0 };
    groups[piece.id] = { id: piece.id, pieceIds: [piece.id], offset, z };
    z += 1;
    if (piece.id > maxId) maxId = piece.id;
  }

  return {
    groups,
    heldBy: {},
    nextZ: z,
    nextGroupId: maxId + 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a grab attempt. `granted` is false when the Group doesn't exist,
 * or is already held by a *different* player — first requester wins. Grabbing
 * a Group you already hold is a no-op success (idempotent).
 */
export type GrabOutcome =
  | { readonly state: GameState; readonly granted: true }
  | {
      readonly state: GameState;
      readonly granted: false;
      readonly reason: "not-found" | "held-by-other";
    };

export function grabGroup(state: GameState, groupId: GroupId, playerId: PlayerId): GrabOutcome {
  const group = state.groups[groupId];
  if (!group) {
    return { state, granted: false, reason: "not-found" };
  }
  const holder = state.heldBy[groupId];
  if (holder !== undefined && holder !== playerId) {
    return { state, granted: false, reason: "held-by-other" };
  }
  if (holder === playerId) {
    return { state, granted: true };
  }
  const heldBy = { ...state.heldBy, [groupId]: playerId };
  return { state: { ...state, heldBy }, granted: true };
}

/**
 * Releases the grab lock, but only if `playerId` is the current holder.
 * Releasing a Group you don't hold (already released, held by someone else,
 * or non-existent) is a no-op — returns `state` unchanged.
 */
export function releaseGroup(state: GameState, groupId: GroupId, playerId: PlayerId): GameState {
  if (state.heldBy[groupId] !== playerId) return state;
  const heldBy = { ...state.heldBy };
  delete heldBy[groupId];
  return { ...state, heldBy };
}

/**
 * Sets a Group's offset to an absolute new value (not a delta). Callers pass
 * the intended new world offset directly, e.g. from a drag or drop message.
 * A no-op if the Group doesn't exist.
 */
export function moveGroup(state: GameState, groupId: GroupId, offset: Point): GameState {
  const group = state.groups[groupId];
  if (!group) return state;
  const groups = { ...state.groups, [groupId]: { ...group, offset } };
  return { ...state, groups };
}

/**
 * Merges `fromId` into `intoId`: the union of their Pieces, keeping `intoId`'s
 * id and offset (per the KEY INVARIANT, this never moves any Piece — it just
 * relabels which Group they belong to). `fromId` ceases to exist. z becomes
 * the higher of the two so the merged Group doesn't visually drop behind.
 *
 * Which side is "into" vs "from" (larger-absorbs-smaller) is a decision made
 * by the caller (see snap.ts) — this reducer just performs the union.
 * A no-op if either Group is missing or the ids are equal.
 */
export function mergeGroups(state: GameState, intoId: GroupId, fromId: GroupId): GameState {
  if (intoId === fromId) return state;
  const into = state.groups[intoId];
  const from = state.groups[fromId];
  if (!into || !from) return state;

  const merged: Group = {
    id: intoId,
    pieceIds: [...into.pieceIds, ...from.pieceIds],
    offset: into.offset,
    z: Math.max(into.z, from.z),
  };

  const groups = { ...state.groups };
  delete groups[fromId];
  groups[intoId] = merged;

  const heldBy = { ...state.heldBy };
  delete heldBy[fromId];
  delete heldBy[intoId];

  return { ...state, groups, heldBy };
}

/** Moves a Group to the top of the draw order. A no-op if it doesn't exist. */
export function bringToFront(state: GameState, groupId: GroupId): GameState {
  const group = state.groups[groupId];
  if (!group) return state;
  const groups = { ...state.groups, [groupId]: { ...group, z: state.nextZ } };
  return { ...state, groups, nextZ: state.nextZ + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export function groupOfPiece(state: GameState, pieceId: PieceId): GroupId | undefined {
  for (const group of Object.values(state.groups)) {
    if (group.pieceIds.includes(pieceId)) return group.id;
  }
  return undefined;
}

/** True once every Piece belongs to a single remaining Group — Completion. */
export function isComplete(state: GameState): boolean {
  return Object.keys(state.groups).length === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialisation — the Snapshot wire shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wire shape, close to the plan's `FullState = {groups:[{id,pieceIds,x,y,z}],
 * heldBy}`. This is what gets persisted as a Snapshot and sent to Guests on
 * join/resync.
 */
export type SerializedGroup = {
  readonly id: GroupId;
  readonly pieceIds: readonly PieceId[];
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export type SerializedState = {
  readonly groups: readonly SerializedGroup[];
  readonly heldBy: Readonly<Record<GroupId, PlayerId>>;
  readonly nextZ: number;
  readonly nextGroupId: GroupId;
};

export function serialize(state: GameState): SerializedState {
  return {
    groups: Object.values(state.groups).map((g) => ({
      id: g.id,
      pieceIds: [...g.pieceIds],
      x: g.offset.x,
      y: g.offset.y,
      z: g.z,
    })),
    heldBy: { ...state.heldBy },
    nextZ: state.nextZ,
    nextGroupId: state.nextGroupId,
  };
}

export function deserialize(json: SerializedState): GameState {
  const groups: Record<GroupId, Group> = {};
  for (const g of json.groups) {
    groups[g.id] = {
      id: g.id,
      pieceIds: [...g.pieceIds],
      offset: { x: g.x, y: g.y },
      z: g.z,
    };
  }
  return {
    groups,
    heldBy: { ...json.heldBy },
    nextZ: json.nextZ,
    nextGroupId: json.nextGroupId,
  };
}

// Re-exported so snap.ts/host.ts/client.ts can build synthetic Pieces in
// tests without importing src/puzzle.
export type { Piece, Player };

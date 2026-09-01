/**
 * Shared domain types. Vocabulary follows CONTEXT.md - Piece, Edge, Tab, Blank,
 * Cell, Group, Lattice, Room, Host, Guest, Snapshot.
 *
 * This file is the contract between modules. Nothing here depends on Pixi,
 * React, Supabase or the DOM.
 */

export type Point = { readonly x: number; readonly y: number };

export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Puzzle geometry
// ─────────────────────────────────────────────────────────────────────────────

/** One cubic bezier segment. Absolute coordinates, image space. */
export type BezierSegment = {
  readonly c1: Point;
  readonly c2: Point;
  readonly to: Point;
};

/**
 * One cut line between two adjacent Pieces, or a straight outer boundary.
 *
 * INTERLOCK INVARIANT: each interior Edge is generated exactly once and shared
 * by both neighbouring Pieces - one of them traverses it reversed. Pieces must
 * never generate their own outlines from the PRNG, or neighbours get mismatched
 * curves and nothing interlocks.
 *
 * Traversed `from` -> `to` through `segments`.
 */
export type Edge = {
  readonly from: Point;
  readonly to: Point;
  readonly segments: readonly BezierSegment[];
};

export type PieceId = number;
export type GroupId = number;
export type PlayerId = string;

/** Grid geometry derived from image size and requested piece count. */
export type Grid = {
  readonly rows: number;
  readonly cols: number;
  /** Nominal Cell size. Cells are roughly, not exactly, square. */
  readonly cellW: number;
  readonly cellH: number;
  readonly imageW: number;
  readonly imageH: number;
};

/** A Piece's immutable geometry, in image space. */
export type Piece = {
  readonly id: PieceId;
  readonly row: number;
  readonly col: number;
  /**
   * The Piece's solved position: its nominal (unjittered) Cell origin.
   * This is the Lattice position - vertex jitter never moves it.
   */
  readonly solved: Point;
  /** Closed outline: 4 Edges, already oriented head-to-tail (top, right, bottom, left). */
  readonly outline: readonly Edge[];
  /** Bounding box including Tab overhang, image space. */
  readonly bbox: Rect;
};

/** The tuple that fully defines a puzzle. All that crosses the wire or persists. */
export type PuzzleDefinition = {
  readonly imageUrl: string;
  readonly seed: number;
  readonly rows: number;
  readonly cols: number;
};

export type Puzzle = {
  readonly definition: PuzzleDefinition;
  readonly grid: Grid;
  readonly pieces: readonly Piece[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Game state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rigid set of Pieces that moves as one. Every Piece belongs to exactly one
 * Group; a lone Piece is a Group of one.
 *
 * KEY INVARIANT - the whole snap/merge design rests on this:
 * a Group stores a single `offset`, a translation applied to every member
 * Piece's `solved` position. A Piece's world position is ALWAYS
 * `piece.solved + group.offset`. Pieces never store their own positions.
 *
 * It follows that:
 *  - a Group is correctly placed exactly when `offset` is (0, 0);
 *  - two Groups may Merge iff they contain orthogonally adjacent Pieces AND
 *    their offsets agree within tolerance - no per-Piece maths needed;
 *  - merging never moves Pieces relative to one another.
 */
export type Group = {
  readonly id: GroupId;
  readonly pieceIds: readonly PieceId[];
  readonly offset: Point;
  /** Draw order. Monotonic; higher is on top. */
  readonly z: number;
};

/**
 * Authoritative board state. Owned by the Host, serialised as the Snapshot,
 * and sent to Guests on join and on resync.
 */
export type GameState = {
  readonly groups: Readonly<Record<GroupId, Group>>;
  /** Grab locks: GroupId -> the PlayerId currently holding it. */
  readonly heldBy: Readonly<Record<GroupId, PlayerId>>;
  readonly nextZ: number;
  readonly nextGroupId: GroupId;
};

export type Player = {
  readonly id: PlayerId;
  /** Auto-assigned adjective-animal, editable. Cosmetic only. */
  readonly name: string;
  /** Cursor colour, CSS hex. */
  readonly color: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `control` is reliable and ordered (join, state, grab/drop/snap).
 * `stream` is unreliable and unordered (cursors, mid-drag positions).
 */
export type Channel = "control" | "stream";

export const BROADCAST = "*" as const;
export type Recipient = PlayerId | typeof BROADCAST;

/**
 * The seam that lets M1 run Host and Guest in one process over a loopback and
 * M3 swap in WebRTC without rewriting game logic. Implementations: LoopbackTransport
 * (game/loopback.ts) and the WebRTC pair in net/.
 */
/**
 * Connection state a Transport can report. `failed` and `roomFull` carry a
 * message written for a human - the plan requires the 15s connect timeout and
 * the player cap to surface as clear UI, not a silent hang.
 */
export type TransportStatus =
  | { readonly state: "new" | "connecting" | "connected" | "closed" }
  | { readonly state: "failed" | "roomFull"; readonly message: string };

/**
 * The common shape of Host's and Client's player-facing API: grab/move/drop
 * intents plus enough queries for the renderer (see render/board.ts) to
 * reconcile the scene, without caring which one it has. Both `Host` and
 * `Client` satisfy this structurally.
 */
export interface PlayerController {
  getState(): GameState;
  getPlayers(): readonly Player[];
  getPlayerId(): PlayerId | undefined;
  onChange(fn: () => void): () => void;
  grab(groupId: GroupId): void;
  move(groupId: GroupId, offset: Point): void;
  drop(groupId: GroupId, offset: Point): void;
}

export interface Transport {
  send(channel: Channel, to: Recipient, msg: unknown): void;
  /** Returns an unsubscribe function. */
  onMessage(handler: (from: PlayerId, channel: Channel, msg: unknown) => void): () => void;
  onPeerJoin(handler: (id: PlayerId) => void): () => void;
  onPeerLeave(handler: (id: PlayerId) => void): () => void;
  close(): void;

  /**
   * Optional because the in-process loopback has no connection to report - it
   * is always connected. Real WebRTC transports MUST implement both, so the UI
   * can show "couldn't connect" or "room is full" instead of hanging.
   */
  onStatus?(handler: (status: TransportStatus) => void): () => void;
  getStatus?(): TransportStatus;
}

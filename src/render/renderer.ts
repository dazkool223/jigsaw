/**
 * The PixiJS v8 board scene.
 *
 * One Container per Group (see the `Group` doc comment in ../types.ts and
 * CONTEXT.md): moving a Group is one container transform, never N sprite
 * updates. A Piece's world position is ALWAYS `piece.solved + group.offset`,
 * so a Group container's `position` IS `group.offset`, and each Sprite's
 * *local* position inside that container is fixed at
 * `piece.solved + frame.anchor` (computed once in `loadPuzzle`) - the
 * renderer never recomputes a Piece's world position by hand.
 *
 * This module owns Pixi. It has no knowledge of Host/Guest, networking, or
 * React - `sync(state, localPlayerId)` is fed a `GameState` snapshot (either
 * the authoritative one, or the caller's own optimistic view of it during a
 * local drag) and reconciles the scene to match. It never mutates game
 * state and never imports src/game or src/net.
 */

import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import type { GameState, GroupId, PieceId, Player, PlayerId, Point, Puzzle, Rect } from "../types";
import { BAKE_SCALE, REMOTE_LERP_MS } from "../config";
import type { CanvasLike, Frame } from "../puzzle/textures";
import type { Viewport } from "./viewport";

function hexToNumber(color: string): number {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0x000000;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export type PuzzleRendererOptions = {
  readonly width: number;
  readonly height: number;
  /** CSS hex/int background behind the board. Defaults to a light neutral. */
  readonly background?: number;
  /** Passed straight through to `app.init` - typically `window` or a wrapper element. */
  readonly resizeTo?: HTMLElement | Window;
  readonly antialias?: boolean;
  readonly resolution?: number;
};

type BadgeEntry = {
  readonly root: Container;
  readonly bg: Graphics;
  readonly label: Text;
  holderId: PlayerId;
  color: string;
};

type GroupEntry = {
  readonly container: Container;
  /** PieceIds already given a Sprite in this container - merges only add. */
  readonly pieceIds: Set<PieceId>;
  /** Latest authoritative/optimistic offset for this Group. */
  target: Point;
  /** false while held by the local player: position is set immediately, never lerped. */
  lerp: boolean;
  /** First sync must snap immediately even if it happens to be "remote". */
  initialized: boolean;
  /** Union bbox (rest space) of every Piece in this Group - grows as pieces merge in. Anchors the held-by badge. */
  localBbox: Rect | undefined;
  /** "Who's holding this piece" badge - present only while held by someone other than the local player. */
  badge: BadgeEntry | undefined;
};

/**
 * Public surface. Instantiate with `PuzzleRenderer.create(canvas, opts)`,
 * then `loadPuzzle` once after baking, then call `sync` whenever GameState
 * changes and `setViewport` whenever pan/zoom changes (see `interactions.ts`,
 * which produces both).
 */
export class PuzzleRenderer {
  readonly app: Application;
  /** Pan/zoom root: its transform IS the Viewport. Add world-space overlays here. */
  readonly worldRoot: Container;

  private readonly groupEntries = new Map<GroupId, GroupEntry>();
  private pieceTextures = new Map<PieceId, Texture>();
  private pieceLocalPos = new Map<PieceId, Point>();
  private pieceBbox = new Map<PieceId, Rect>();
  private puzzle: Puzzle | null = null;

  private readonly boardOutline: Graphics;
  private readonly ghostSprite: Sprite;

  private constructor(app: Application) {
    this.app = app;
    this.worldRoot = new Container();
    this.worldRoot.sortableChildren = true;
    app.stage.addChild(this.worldRoot);

    this.boardOutline = new Graphics();
    this.boardOutline.zIndex = -2;
    this.boardOutline.eventMode = "none";
    this.worldRoot.addChild(this.boardOutline);

    this.ghostSprite = new Sprite();
    this.ghostSprite.zIndex = -1;
    this.ghostSprite.eventMode = "none";
    this.ghostSprite.visible = false;
    this.worldRoot.addChild(this.ghostSprite);

    app.ticker.add((ticker) => this.tick(ticker.deltaMS));
  }

  static async create(
    canvas: HTMLCanvasElement,
    opts: PuzzleRendererOptions,
  ): Promise<PuzzleRenderer> {
    const app = new Application();
    await app.init({
      canvas,
      width: opts.width,
      height: opts.height,
      // Table felt - matches --felt in ui/theme.css. The board is most of the
      // pixels during play, so this is what makes the app read as one surface
      // rather than a canvas sitting in a page.
      background: opts.background ?? 0x1b3a2f,
      resizeTo: opts.resizeTo,
      antialias: opts.antialias ?? true,
      resolution: opts.resolution ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1),
      autoDensity: true,
    });
    return new PuzzleRenderer(app);
  }

  // ── Setup (called once per Room, after baking) ──────────────────────────

  /**
   * Wires up baked atlas sheets + frames for a Puzzle: builds one Pixi
   * Texture per atlas sheet, slices a per-Piece Texture via each Frame's
   * region, and precomputes every Piece's fixed local position
   * (`piece.solved + frame.anchor`). Also (re)draws the faint Lattice board
   * outline. Does NOT touch GameState - call `sync` after this to populate
   * Group containers.
   */
  loadPuzzle(puzzle: Puzzle, sheets: readonly CanvasLike[], frames: ReadonlyMap<PieceId, Frame>): void {
    this.puzzle = puzzle;

    // CanvasLike matches HTMLCanvasElement/OffscreenCanvas structurally; both
    // are valid Pixi texture sources at runtime.
    const sheetTextures = sheets.map((sheet) => Texture.from(sheet as unknown as HTMLCanvasElement));

    const pieceTextures = new Map<PieceId, Texture>();
    const pieceLocalPos = new Map<PieceId, Point>();
    const pieceBbox = new Map<PieceId, Rect>();
    for (const piece of puzzle.pieces) {
      const frame = frames.get(piece.id);
      if (!frame) continue; // caller's atlas didn't cover this piece - skip, don't crash the scene
      const sheetTexture = sheetTextures[frame.sheet];
      const sliced = new Texture({
        source: sheetTexture.source,
        frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
      });
      pieceTextures.set(piece.id, sliced);
      pieceLocalPos.set(piece.id, {
        x: piece.solved.x + frame.anchorX,
        y: piece.solved.y + frame.anchorY,
      });
      pieceBbox.set(piece.id, piece.bbox);
    }
    this.pieceTextures = pieceTextures;
    this.pieceLocalPos = pieceLocalPos;
    this.pieceBbox = pieceBbox;

    // Existing group containers reference stale/absent textures if this is a
    // reload - simplest safe path is to drop them; sync() rebuilds on the
    // next call. This should only happen once per Room in practice.
    for (const entry of this.groupEntries.values()) {
      entry.container.destroy({ children: true });
    }
    this.groupEntries.clear();

    this.drawBoardOutline(puzzle.grid.imageW, puzzle.grid.imageH);
  }

  private drawBoardOutline(imageW: number, imageH: number): void {
    this.boardOutline.clear();
    // Where the finished picture goes: a chalked-out rectangle on the felt,
    // light rather than dark so it reads as a marking on the table instead of
    // a shadow under it.
    this.boardOutline
      .rect(0, 0, imageW, imageH)
      .stroke({ width: 2, color: 0xded2bb, alpha: 0.22 });
  }

  /**
   * Optional ghost image: the source Puzzle picture at low alpha, drawn
   * behind every Piece. Pass `null` to hide it again.
   */
  setGhost(source: CanvasImageSource | null, alpha = 0.15): void {
    if (!source || !this.puzzle) {
      this.ghostSprite.visible = false;
      return;
    }
    this.ghostSprite.texture = Texture.from(source as unknown as HTMLImageElement);
    this.ghostSprite.width = this.puzzle.grid.imageW;
    this.ghostSprite.height = this.puzzle.grid.imageH;
    this.ghostSprite.alpha = alpha;
    this.ghostSprite.visible = true;
  }

  // ── Camera ────────────────────────────────────────────────────────────

  /** Applies a Viewport (see viewport.ts) to the world container's transform. */
  setViewport(viewport: Viewport): void {
    this.worldRoot.scale.set(viewport.scale, viewport.scale);
    this.worldRoot.position.set(
      -viewport.origin.x * viewport.scale,
      -viewport.origin.y * viewport.scale,
    );
  }

  // ── State reconciliation ─────────────────────────────────────────────

  /**
   * Reconciles the scene to `state`. Creates Group containers for new
   * Groups, adds Sprites for Pieces newly merged into an existing Group,
   * destroys containers for Groups that no longer exist (merged away), and
   * applies each Group's `z` as its container's `zIndex`.
   *
   * `localPlayerId`, when given, marks any Group currently `heldBy` that
   * player as local: its container snaps straight to the target offset
   * every call (drag must feel immediate). Every other Group's container
   * eases toward its target offset over `REMOTE_LERP_MS` (see `tick`).
   *
   * `players`, when given, drives a "held by" badge on any Group currently
   * held by someone other than `localPlayerId`: a name pill, tinted with
   * that player's identity color, anchored at the Group's corner. Omitted
   * (or a lookup miss) simply shows no badge - never blocks the sync.
   */
  sync(
    state: GameState,
    localPlayerId: PlayerId | null = null,
    players?: ReadonlyMap<PlayerId, Player>,
  ): void {
    const seen = new Set<GroupId>();

    for (const group of Object.values(state.groups)) {
      seen.add(group.id);
      let entry = this.groupEntries.get(group.id);
      if (!entry) {
        const container = new Container();
        this.worldRoot.addChild(container);
        entry = {
          container,
          pieceIds: new Set(),
          target: group.offset,
          lerp: false,
          initialized: false,
          localBbox: undefined,
          badge: undefined,
        };
        this.groupEntries.set(group.id, entry);
      }

      entry.container.zIndex = group.z;

      for (const pieceId of group.pieceIds) {
        if (entry.pieceIds.has(pieceId)) continue;
        entry.pieceIds.add(pieceId);
        const sprite = this.createPieceSprite(pieceId);
        if (sprite) entry.container.addChild(sprite);
        const bbox = this.pieceBbox.get(pieceId);
        if (bbox) entry.localBbox = entry.localBbox ? unionRect(entry.localBbox, bbox) : bbox;
      }

      const isLocal = localPlayerId != null && state.heldBy[group.id] === localPlayerId;
      entry.target = group.offset;
      entry.lerp = !isLocal;

      // Snap immediately: on first sight of a Group (no slide-in from the
      // origin), and always while it's held by the local player.
      if (isLocal || !entry.initialized) {
        entry.container.position.set(group.offset.x, group.offset.y);
      }
      entry.initialized = true;

      const holderId = state.heldBy[group.id];
      const holder = holderId && holderId !== localPlayerId ? players?.get(holderId) : undefined;
      if (holder && entry.localBbox) {
        this.syncBadge(entry, holder);
      } else if (entry.badge) {
        entry.badge.root.destroy({ children: true });
        entry.badge = undefined;
      }
    }

    for (const [id, entry] of this.groupEntries) {
      if (seen.has(id)) continue;
      entry.container.destroy({ children: true });
      this.groupEntries.delete(id);
    }
  }

  /** Creates/updates a Group's "held by" name pill, anchored above its bbox's top-left corner. */
  private syncBadge(entry: GroupEntry, holder: Player): void {
    if (!entry.badge) {
      const root = new Container();
      root.eventMode = "none";
      const bg = new Graphics();
      const label = new Text({ text: "", style: { fontSize: 11, fill: 0xffffff, fontFamily: "sans-serif" } });
      root.addChild(bg, label);
      entry.container.addChild(root); // added last - draws on top of the Group's Sprites
      entry.badge = { root, bg, label, holderId: holder.id, color: "" };
    }
    const badge = entry.badge;
    const changed = badge.label.text !== holder.name || badge.color !== holder.color;
    badge.holderId = holder.id;

    if (changed) {
      badge.label.text = holder.name;
      badge.color = holder.color;
      const paddingX = 6;
      const paddingY = 3;
      const w = badge.label.width + paddingX * 2;
      const h = badge.label.height + paddingY * 2;
      badge.bg.clear();
      badge.bg.roundRect(0, 0, w, h, 4).fill({ color: hexToNumber(holder.color) });
      badge.label.position.set(paddingX, paddingY);
    }

    const bbox = entry.localBbox;
    if (bbox) badge.root.position.set(bbox.x, bbox.y - badge.bg.height - 4);
  }

  private createPieceSprite(pieceId: PieceId): Sprite | null {
    const texture = this.pieceTextures.get(pieceId);
    const localPos = this.pieceLocalPos.get(pieceId);
    if (!texture || !localPos) return null;
    const sprite = new Sprite({ texture });
    // Baked at BAKE_SCALE for crispness at max zoom; scale back down so the
    // Sprite occupies its true image-space footprint.
    sprite.scale.set(1 / BAKE_SCALE);
    sprite.position.set(localPos.x, localPos.y);
    sprite.eventMode = "none"; // interactions.ts hit-tests independently; see interactions.ts
    return sprite;
  }

  // ── Per-frame lerp ────────────────────────────────────────────────────

  private tick(deltaMS: number): void {
    if (this.groupEntries.size === 0) return;
    const factor = REMOTE_LERP_MS > 0 ? 1 - Math.exp(-deltaMS / REMOTE_LERP_MS) : 1;
    for (const entry of this.groupEntries.values()) {
      if (!entry.lerp) continue;
      const pos = entry.container.position;
      const nx = pos.x + (entry.target.x - pos.x) * factor;
      const ny = pos.y + (entry.target.y - pos.y) * factor;
      entry.container.position.set(nx, ny);
    }
  }

  // ── Teardown ──────────────────────────────────────────────────────────

  destroy(): void {
    this.app.destroy(true, { children: true, texture: false });
  }
}

/**
 * Pointer input for the board: hit-testing, dragging a Group, panning, and
 * zooming. This module owns raw DOM pointer/wheel/keyboard events and turns
 * them into either Viewport changes (applied locally, no authority needed)
 * or *intents* delivered through callbacks - it never imports src/game or
 * src/net, and never mutates GameState itself. The caller (wired to
 * Host/Client) decides whether a grab is granted, performs the actual move,
 * and feeds the resulting GameState back through `PuzzleRenderer.sync`.
 *
 * Hit-testing follows the plan: a broad bbox pass first (cheap, over every
 * Piece), then an exact `Path2D` + `isPointInPath` pass only for candidates
 * that survive it. Piece outlines are already absolute image-space
 * coordinates at rest (Group offset (0, 0)), so testing a world-space click
 * only requires translating the point by *minus* the Group's current offset
 * before testing against the Piece's own (untranslated, cached) Path2D -
 * no per-drag path rebuilding.
 */

import type { GroupId, Piece, PieceId, Point, Rect } from "../types";
import { outlineToPath2D } from "../puzzle/textures";
import { clampAxisToBounds, clampViewport, pan, screenToWorld, zoomToCursor, type Viewport } from "./viewport";

export type InteractionCallbacks = {
  /** A Piece under the pointer resolved to `groupId` and the drag is starting. */
  readonly onGrab?: (groupId: GroupId, world: Point) => void;
  /** Continuous while dragging: `offset` is the proposed new Group.offset. */
  readonly onMove?: (groupId: GroupId, offset: Point) => void;
  /** Drag ended (pointerup/cancel) with the final proposed offset. */
  readonly onDrop?: (groupId: GroupId, offset: Point) => void;
  /** Fired whenever pan/zoom/pinch changes the Viewport. */
  readonly onViewportChange?: (viewport: Viewport) => void;
};

export type InteractionsOptions = {
  /** Element pointer/wheel/keyboard listeners attach to - typically the Pixi canvas. */
  readonly element: HTMLElement;
  readonly getViewport: () => Viewport;
  readonly getPieces: () => readonly Piece[];
  readonly getGroupOfPiece: (pieceId: PieceId) => GroupId | undefined;
  readonly getGroupZ: (groupId: GroupId) => number;
  readonly getGroupOffset: (groupId: GroupId) => Point | undefined;
  readonly callbacks: InteractionCallbacks;
  /** Wheel zoom step per notch; defaults to 1.1 (10% per click). */
  readonly wheelZoomStep?: number;
  /**
   * World-space rect that dragging a Group and panning/zooming the camera
   * are both confined to (see `puzzle/layout.ts#playAreaBounds`) - "restrict
   * canvas with certain space so pieces are not gone outside the window".
   */
  readonly bounds: Rect;
};

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

type PointerRecord = { readonly id: number; x: number; y: number };

type Mode =
  | { readonly kind: "idle" }
  | {
      readonly kind: "drag-group";
      readonly groupId: GroupId;
      readonly startOffset: Point;
      readonly startWorld: Point;
      /** Union bbox of the Group's member Pieces, in rest space - fixed for the drag's duration. */
      readonly groupBbox: Rect;
    }
  | { readonly kind: "pan"; last: Point }
  | { readonly kind: "pinch"; lastDistance: number; lastMidpoint: Point };

/**
 * Attaches listeners to `opts.element` on construction; call `destroy()` to
 * remove them. Stateless with respect to game logic - safe to construct
 * once per board mount and keep for the component's lifetime.
 */
export class Interactions {
  private viewport: Viewport;
  private mode: Mode = { kind: "idle" };
  private spaceHeld = false;
  private readonly pointers = new Map<number, PointerRecord>();
  private readonly scratchCtx: CanvasRenderingContext2D;
  private readonly pathCache = new Map<PieceId, Path2D>();

  private readonly onPointerDown = (e: PointerEvent) => this.handlePointerDown(e);
  private readonly onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private readonly onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);
  private readonly onWheel = (e: WheelEvent) => this.handleWheel(e);
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly onContextMenu = (e: MouseEvent) => e.preventDefault();

  constructor(private readonly opts: InteractionsOptions) {
    this.viewport = opts.getViewport();

    const scratch = document.createElement("canvas");
    scratch.width = 1;
    scratch.height = 1;
    const ctx = scratch.getContext("2d");
    if (!ctx) throw new Error("Interactions: could not create a 2D scratch context for hit-testing");
    this.scratchCtx = ctx;

    const el = opts.element;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    // Middle-drag pan should not open the browser's autoscroll/context menu.
    el.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  /** Sync after an external Viewport change (e.g. fitToContent on load/resize). */
  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
  }

  destroy(): void {
    const el = this.opts.element;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerUp);
    el.removeEventListener("wheel", this.onWheel);
    el.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.pointers.clear();
  }

  // ── Hit-testing ─────────────────────────────────────────────────────

  private pathFor(piece: Piece): Path2D {
    let path = this.pathCache.get(piece.id);
    if (!path) {
      path = outlineToPath2D(piece);
      this.pathCache.set(piece.id, path);
    }
    return path;
  }

  /** Broad-phase bbox pass, then exact Path2D pass; topmost Group by z wins. */
  private hitTestGroupAt(world: Point): GroupId | null {
    let best: { groupId: GroupId; z: number } | null = null;

    for (const piece of this.opts.getPieces()) {
      const groupId = this.opts.getGroupOfPiece(piece.id);
      if (groupId === undefined) continue;
      const offset = this.opts.getGroupOffset(groupId);
      if (!offset) continue;

      const bbox = piece.bbox;
      const left = bbox.x + offset.x;
      const top = bbox.y + offset.y;
      if (world.x < left || world.x > left + bbox.w || world.y < top || world.y > top + bbox.h) {
        continue; // broad phase: outside the (offset) bbox
      }

      // Exact test in the Piece's own rest-space: outline coordinates already
      // include jitter and assume offset (0, 0), so subtract the Group's
      // current offset from the world point rather than transforming the path.
      const local = { x: world.x - offset.x, y: world.y - offset.y };
      if (!this.scratchCtx.isPointInPath(this.pathFor(piece), local.x, local.y)) continue;

      const z = this.opts.getGroupZ(groupId);
      if (!best || z > best.z) best = { groupId, z };
    }

    return best?.groupId ?? null;
  }

  /** Union bbox (rest space) of every Piece currently in `groupId`. */
  private computeGroupBbox(groupId: GroupId): Rect {
    let box: Rect | undefined;
    for (const piece of this.opts.getPieces()) {
      if (this.opts.getGroupOfPiece(piece.id) !== groupId) continue;
      box = box ? unionRect(box, piece.bbox) : piece.bbox;
    }
    return box ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  /** Keeps a dragged Group's bbox (translated by `offset`) inside `opts.bounds`. */
  private clampGroupOffset(offset: Point, groupBbox: Rect): Point {
    const bounds = this.opts.bounds;
    return {
      x: clampAxisToBounds(groupBbox.x + offset.x, groupBbox.w, bounds.x, bounds.w) - groupBbox.x,
      y: clampAxisToBounds(groupBbox.y + offset.y, groupBbox.h, bounds.y, bounds.h) - groupBbox.y,
    };
  }

  /** Keeps the camera from panning/zooming past `opts.bounds`. */
  private clampCamera(viewport: Viewport): Viewport {
    const rect = this.opts.element.getBoundingClientRect();
    return clampViewport(viewport, this.opts.bounds, rect.width, rect.height);
  }

  // ── Screen helpers ──────────────────────────────────────────────────

  private toLocalScreen(e: PointerEvent | WheelEvent): Point {
    const rect = this.opts.element.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private emitViewport(): void {
    this.opts.callbacks.onViewportChange?.(this.viewport);
  }

  // ── Pointer handling ────────────────────────────────────────────────

  private handlePointerDown(e: PointerEvent): void {
    const screen = this.toLocalScreen(e);
    this.pointers.set(e.pointerId, { id: e.pointerId, x: screen.x, y: screen.y });
    this.opts.element.setPointerCapture?.(e.pointerId);

    if (this.pointers.size >= 2) {
      this.startPinch();
      return;
    }

    const isMiddleButton = e.button === 1;
    const wantsPan = this.spaceHeld || isMiddleButton || e.button === 2;

    if (!wantsPan) {
      const world = screenToWorld(this.viewport, screen);
      const groupId = this.hitTestGroupAt(world);
      if (groupId !== null) {
        const startOffset = this.opts.getGroupOffset(groupId) ?? { x: 0, y: 0 };
        const groupBbox = this.computeGroupBbox(groupId);
        this.mode = { kind: "drag-group", groupId, startOffset, startWorld: world, groupBbox };
        this.opts.callbacks.onGrab?.(groupId, world);
        return;
      }
    }

    this.mode = { kind: "pan", last: screen };
  }

  private handlePointerMove(e: PointerEvent): void {
    const screen = this.toLocalScreen(e);
    const record = this.pointers.get(e.pointerId);
    if (record) {
      record.x = screen.x;
      record.y = screen.y;
    }

    if (this.mode.kind === "pinch") {
      this.updatePinch();
      return;
    }

    if (this.mode.kind === "drag-group") {
      const world = screenToWorld(this.viewport, screen);
      const dx = world.x - this.mode.startWorld.x;
      const dy = world.y - this.mode.startWorld.y;
      const rawOffset = { x: this.mode.startOffset.x + dx, y: this.mode.startOffset.y + dy };
      const offset = this.clampGroupOffset(rawOffset, this.mode.groupBbox);
      this.opts.callbacks.onMove?.(this.mode.groupId, offset);
      return;
    }

    if (this.mode.kind === "pan") {
      const delta = { x: screen.x - this.mode.last.x, y: screen.y - this.mode.last.y };
      this.mode = { kind: "pan", last: screen };
      this.viewport = this.clampCamera(pan(this.viewport, delta));
      this.emitViewport();
      return;
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.opts.element.releasePointerCapture?.(e.pointerId);

    if (this.mode.kind === "drag-group") {
      const world = this.lastKnownWorld(e);
      const dx = world.x - this.mode.startWorld.x;
      const dy = world.y - this.mode.startWorld.y;
      const rawOffset = { x: this.mode.startOffset.x + dx, y: this.mode.startOffset.y + dy };
      const offset = this.clampGroupOffset(rawOffset, this.mode.groupBbox);
      this.opts.callbacks.onDrop?.(this.mode.groupId, offset);
    }

    if (this.pointers.size >= 2) {
      this.startPinch();
    } else {
      this.mode = { kind: "idle" };
    }
  }

  private lastKnownWorld(e: PointerEvent): Point {
    const screen = this.toLocalScreen(e);
    return screenToWorld(this.viewport, screen);
  }

  // ── Pinch (touch) ───────────────────────────────────────────────────

  private startPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.mode = { kind: "pinch", lastDistance: distance, lastMidpoint: midpoint };
  }

  private updatePinch(): void {
    if (this.mode.kind !== "pinch") return;
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const panDelta = { x: midpoint.x - this.mode.lastMidpoint.x, y: midpoint.y - this.mode.lastMidpoint.y };
    this.viewport = pan(this.viewport, panDelta);

    if (this.mode.lastDistance > 0 && distance > 0) {
      const deltaScale = distance / this.mode.lastDistance;
      this.viewport = zoomToCursor(this.viewport, midpoint, deltaScale);
    }

    this.viewport = this.clampCamera(this.viewport);
    this.mode = { kind: "pinch", lastDistance: distance, lastMidpoint: midpoint };
    this.emitViewport();
  }

  // ── Wheel zoom ──────────────────────────────────────────────────────

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const screen = this.toLocalScreen(e);
    const step = this.opts.wheelZoomStep ?? 1.1;
    const deltaScale = e.deltaY < 0 ? step : 1 / step;
    this.viewport = this.clampCamera(zoomToCursor(this.viewport, screen, deltaScale));
    this.emitViewport();
  }

  // ── Keyboard (space-drag pan) ───────────────────────────────────────

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.code === "Space") this.spaceHeld = true;
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.code === "Space") this.spaceHeld = false;
  }
}

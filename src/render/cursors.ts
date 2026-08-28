/**
 * Renders other players' cursors in world space: a small colour-tinted
 * pointer plus a name label, lerped by REMOTE_LERP_MS so remote motion looks
 * smooth despite arriving in bursts over the network. Never intercepts
 * pointer events — `eventMode` is "none" throughout, so the board's own
 * hit-testing (interactions.ts) is never shadowed by a cursor glyph.
 *
 * Pure Pixi presentation: this module knows nothing about Players, Peers or
 * networking beyond the small `CursorState` shape below, which the caller
 * (wired to net/) supplies on every update.
 */

import { Container, Graphics, Text } from "pixi.js";
import type { Application, Ticker } from "pixi.js";
import type { PlayerId, Point } from "../types";
import { REMOTE_LERP_MS } from "../config";

export type CursorState = {
  readonly playerId: PlayerId;
  readonly name: string;
  /** CSS hex colour, e.g. "#e05d44". */
  readonly color: string;
  /** World-space position (same space as Piece.solved / Group.offset). */
  readonly world: Point;
};

type CursorEntry = {
  readonly root: Container;
  readonly glyph: Graphics;
  readonly label: Text;
  target: Point;
  initialized: boolean;
  color: string;
};

const GLYPH_SIZE = 14;
const LABEL_OFFSET: Point = { x: GLYPH_SIZE * 0.9, y: GLYPH_SIZE * 0.9 };

function hexToNumber(color: string): number {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0x000000;
}

/** Draws a simple pointer/arrow glyph, tinted `color`, tip at local (0, 0). */
function drawGlyph(g: Graphics, color: string): void {
  g.clear();
  g.poly([0, 0, 0, GLYPH_SIZE, GLYPH_SIZE * 0.35, GLYPH_SIZE * 0.72]).fill({
    color: hexToNumber(color),
  });
  g.stroke({ width: 1, color: 0x000000, alpha: 0.35 });
}

/**
 * Owns a Pixi Container of cursor glyphs, added to the world root (so
 * cursors pan/zoom with the board) and driven by the same Application's
 * ticker for lerp. Instantiate once after `PuzzleRenderer.create`:
 *
 *   const cursors = new CursorLayer(renderer.app, renderer.worldRoot);
 *   ...
 *   cursors.sync(latestCursorStates);
 */
export class CursorLayer {
  readonly container: Container;

  private readonly entries = new Map<PlayerId, CursorEntry>();
  private readonly tickerListener: (ticker: Ticker) => void;
  private readonly app: Application;

  constructor(app: Application, worldRoot: Container, zIndex = 10_000) {
    this.app = app;
    this.container = new Container();
    this.container.zIndex = zIndex;
    this.container.eventMode = "none";
    worldRoot.addChild(this.container);

    this.tickerListener = (ticker: Ticker) => this.tick(ticker.deltaMS);
    app.ticker.add(this.tickerListener);
  }

  /** Reconciles displayed cursors to `states` — one entry per online peer (never the local player). */
  sync(states: readonly CursorState[]): void {
    const seen = new Set<PlayerId>();

    for (const state of states) {
      seen.add(state.playerId);
      let entry = this.entries.get(state.playerId);
      if (!entry) {
        const root = new Container();
        root.eventMode = "none";
        const glyph = new Graphics();
        glyph.eventMode = "none";
        const label = new Text({
          text: state.name,
          style: { fontSize: 12, fill: 0x000000, fontFamily: "sans-serif" },
        });
        label.eventMode = "none";
        label.position.set(LABEL_OFFSET.x, LABEL_OFFSET.y);
        root.addChild(glyph, label);
        this.container.addChild(root);

        entry = { root, glyph, label, target: state.world, initialized: false, color: "" };
        this.entries.set(state.playerId, entry);
      }

      if (entry.color !== state.color) {
        drawGlyph(entry.glyph, state.color);
        entry.color = state.color;
      }
      if (entry.label.text !== state.name) {
        entry.label.text = state.name;
      }

      entry.target = state.world;
      if (!entry.initialized) {
        entry.root.position.set(state.world.x, state.world.y);
        entry.initialized = true;
      }
    }

    for (const [playerId, entry] of this.entries) {
      if (seen.has(playerId)) continue;
      entry.root.destroy({ children: true });
      this.entries.delete(playerId);
    }
  }

  private tick(deltaMS: number): void {
    if (this.entries.size === 0) return;
    const factor = REMOTE_LERP_MS > 0 ? 1 - Math.exp(-deltaMS / REMOTE_LERP_MS) : 1;
    for (const entry of this.entries.values()) {
      const pos = entry.root.position;
      const nx = pos.x + (entry.target.x - pos.x) * factor;
      const ny = pos.y + (entry.target.y - pos.y) * factor;
      entry.root.position.set(nx, ny);
    }
  }

  destroy(): void {
    this.app.ticker.remove(this.tickerListener);
    this.container.destroy({ children: true });
    this.entries.clear();
  }
}

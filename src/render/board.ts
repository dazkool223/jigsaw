/**
 * Composition root: wires the pure `render/` modules (PuzzleRenderer,
 * Interactions, CursorLayer, viewport) to a live `PlayerController` (Host or
 * Client — see ../types.ts) and a DOM container. This is the seam app.tsx's
 * `handleBoardMount` TODO pointed at: nowhere else connects rendering to
 * game state, so this is the only module in `render/` allowed to import from
 * `../game`.
 *
 * `mountBoard` bakes the puzzle's texture atlases from the room image (once,
 * off the drag path — see ADR-0002 / CONTEXT.md "Image normalisation"), then
 * keeps the scene in sync with `controller.onChange` for as long as the
 * returned cleanup function hasn't been called.
 */

import { PuzzleRenderer } from "./renderer";
import { Interactions } from "./interactions";
import { CursorLayer, type CursorState } from "./cursors";
import { fitToContent } from "./viewport";
import { bakeAtlases } from "../puzzle/textures";
import { groupOfPiece } from "../game/state";
import type { PlayerController, Puzzle } from "../types";

export type MountBoardOptions = {
  readonly container: HTMLElement;
  readonly puzzle: Puzzle;
  readonly imageUrl: string;
  readonly controller: PlayerController;
};

/** Screen-space breathing room around the puzzle on initial fit. Not a config.ts
 * constant — a UI layout judgement call, not part of puzzle/session identity. */
const VIEWPORT_PADDING_PX = 32;

/** Mounts the full interactive board into `container`. Returns a cleanup function. */
export function mountBoard(opts: MountBoardOptions): () => void {
  const { container, puzzle, imageUrl, controller } = opts;
  let disposed = false;
  let cleanupInner: (() => void) | undefined;

  const canvas = document.createElement("canvas");
  canvas.style.touchAction = "none"; // Interactions owns pan/pinch; don't let the browser scroll/zoom the page too.
  container.appendChild(canvas);

  void (async () => {
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    const renderer = await PuzzleRenderer.create(canvas, { width, height, resizeTo: container });
    if (disposed) {
      renderer.destroy();
      return;
    }

    let image: HTMLImageElement;
    try {
      image = await loadImage(imageUrl);
    } catch {
      renderer.destroy();
      return; // Room load already validated the image (app.tsx's loadImageDimensions); a failure here is rare and non-fatal — the board just stays blank.
    }
    if (disposed) {
      renderer.destroy();
      return;
    }

    const { sheets, frames } = bakeAtlases(puzzle, image);
    renderer.loadPuzzle(puzzle, sheets, frames);

    let viewport = fitToContent(
      { x: 0, y: 0, w: puzzle.grid.imageW, h: puzzle.grid.imageH },
      container.clientWidth || width,
      container.clientHeight || height,
      VIEWPORT_PADDING_PX,
    );
    renderer.setViewport(viewport);

    const cursorLayer = new CursorLayer(renderer.app, renderer.worldRoot);
    const localPlayerId = controller.getPlayerId() ?? null;

    let ghostOn = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "g" && e.key !== "G") return;
      ghostOn = !ghostOn;
      renderer.setGhost(ghostOn ? image : null);
    };
    window.addEventListener("keydown", onKeyDown);

    const interactions = new Interactions({
      element: canvas,
      getViewport: () => viewport,
      getPieces: () => puzzle.pieces,
      getGroupOfPiece: (pieceId) => groupOfPiece(controller.getState(), pieceId),
      getGroupZ: (groupId) => controller.getState().groups[groupId]?.z ?? 0,
      getGroupOffset: (groupId) => controller.getState().groups[groupId]?.offset,
      callbacks: {
        onGrab: (groupId) => controller.grab(groupId),
        onMove: (groupId, offset) => controller.move(groupId, offset),
        onDrop: (groupId, offset) => controller.drop(groupId, offset),
        onViewportChange: (v) => {
          viewport = v;
          renderer.setViewport(v);
        },
        onCursorMove: (world) => controller.sendCursor(world),
      },
    });

    const renderState = () => {
      renderer.sync(controller.getState(), localPlayerId);
      const players = new Map(controller.getPlayers().map((p) => [p.id, p]));
      const cursorStates: CursorState[] = [];
      for (const [playerId, world] of controller.getCursors()) {
        if (playerId === localPlayerId) continue;
        const player = players.get(playerId);
        if (!player) continue; // seen a cursor before the roster caught up — skip this tick, next PLAYER_LIST fixes it
        cursorStates.push({ playerId, name: player.name, color: player.color, world });
      }
      cursorLayer.sync(cursorStates);
    };
    renderState();
    const unsubscribe = controller.onChange(renderState);

    cleanupInner = () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribe();
      interactions.destroy();
      cursorLayer.destroy();
      renderer.destroy();
    };
  })();

  return () => {
    disposed = true;
    cleanupInner?.();
    canvas.remove();
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load the puzzle image for rendering."));
    img.src = url;
  });
}

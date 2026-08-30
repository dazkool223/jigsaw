/**
 * Bakes Pieces into shared atlas sheets, once, off the gameplay path (see
 * CONTEXT.md "Baking and seams" / the plan's "Baking and seams" section).
 * After baking, Pieces are dumb Sprites - nothing here runs per-frame.
 *
 * This module is split in two:
 *   - PURE MATHS (region sizing, atlas packing, anchor computation) - plain
 *     functions over plain data, fully unit-tested without a DOM.
 *   - CANVAS I/O (`outlineToPath2D`, `bakeAtlases`) - needs `Path2D` /
 *     `CanvasRenderingContext2D`, only available in a browser, so it is
 *     exercised by hand / in the running app, not by vitest.
 */

import type { Edge, Piece, PieceId, Point, Puzzle, Rect } from "../types";
import { ATLAS_PADDING_PX, ATLAS_SIZE, BAKE_EXPAND_PX, BAKE_SCALE } from "../config";

// ─────────────────────────────────────────────────────────────────────────────
// PURE MATHS - packing, region sizing, anchors. No DOM.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One Piece's frame within the baked atlas: which sheet, where in it, and the
 * anchor the renderer needs to place the resulting Sprite.
 *
 * `anchorX`/`anchorY` are in image space (the same units as `Piece.solved`):
 * the offset from the Piece's solved position to the world-space point that
 * the frame's local (0, 0) - its top-left texel - represents. So the
 * renderer positions the Sprite at `piece.solved + anchor` and, because the
 * bake is `BAKE_SCALE`x oversized, scales the Sprite by `1 / BAKE_SCALE` to
 * bring it back to image-space size. This is what lets a Piece's rendered
 * position stay correct despite Tab overhang pushing its bbox origin away
 * from its solved Cell origin.
 */
export type Frame = {
  readonly sheet: number;
  /** Region origin within the sheet, in atlas (baked) pixels. */
  readonly x: number;
  readonly y: number;
  /** Region size within the sheet, in atlas (baked) pixels. */
  readonly w: number;
  readonly h: number;
  readonly anchorX: number;
  readonly anchorY: number;
};

/**
 * Size of the canvas region a Piece needs to be baked into: its bbox scaled
 * by `BAKE_SCALE` for crispness at max zoom, plus `BAKE_EXPAND_PX` of margin
 * on every side so the seam-hiding overdraw (see `bakeAtlases`) has room to
 * paint without being clipped by the region edge.
 */
export function bakeRegionSize(
  bbox: Rect,
  bakeScale: number = BAKE_SCALE,
  expandPx: number = BAKE_EXPAND_PX,
): { readonly w: number; readonly h: number } {
  return {
    w: Math.ceil(bbox.w * bakeScale) + expandPx * 2,
    h: Math.ceil(bbox.h * bakeScale) + expandPx * 2,
  };
}

/**
 * Offset (image space, i.e. same units as `piece.solved`) from the Piece's
 * solved position to the world point its baked frame's local (0, 0)
 * represents. Derived by inverting the bake transform (see `bakeAtlases`):
 * translate to the region's expand-inset origin, scale by `BAKE_SCALE`,
 * translate by `-bbox` origin.
 */
export function computeAnchor(
  piece: Piece,
  bakeScale: number = BAKE_SCALE,
  expandPx: number = BAKE_EXPAND_PX,
): Point {
  return {
    x: piece.bbox.x - expandPx / bakeScale - piece.solved.x,
    y: piece.bbox.y - expandPx / bakeScale - piece.solved.y,
  };
}

export type RegionSize = { readonly w: number; readonly h: number };

export type PackedRegion = {
  readonly sheet: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/**
 * Deterministic shelf/row packer: places regions left-to-right, wrapping to a
 * new row when one doesn't fit, and opening a new sheet when a row doesn't
 * fit vertically either. Not space-optimal, but correct (no overlaps, never
 * exceeds sheet bounds) and stable across runs given the same input order -
 * which is all baking needs, since it runs once per Room.
 *
 * `padding` separates every region from its neighbours and from the sheet
 * edge, so bilinear sampling at texture edges never bleeds into the next
 * Piece.
 */
export function packRegions(
  sizes: readonly RegionSize[],
  sheetSize: number = ATLAS_SIZE,
  padding: number = ATLAS_PADDING_PX,
): PackedRegion[] {
  const results: PackedRegion[] = [];
  let sheet = 0;
  let cursorX = padding;
  let cursorY = padding;
  let rowHeight = 0;

  for (const size of sizes) {
    if (size.w + padding * 2 > sheetSize || size.h + padding * 2 > sheetSize) {
      throw new Error(
        `Region ${size.w}x${size.h} (+padding) does not fit in a ${sheetSize}x${sheetSize} sheet`,
      );
    }

    // Wrap to a new row if this region doesn't fit on the current one.
    if (cursorX + size.w + padding > sheetSize) {
      cursorX = padding;
      cursorY += rowHeight + padding;
      rowHeight = 0;
    }

    // Open a new sheet if this row doesn't fit vertically either.
    if (cursorY + size.h + padding > sheetSize) {
      sheet += 1;
      cursorX = padding;
      cursorY = padding;
      rowHeight = 0;
    }

    results.push({ sheet, x: cursorX, y: cursorY, w: size.w, h: size.h });
    cursorX += size.w + padding;
    rowHeight = Math.max(rowHeight, size.h);
  }

  return results;
}

/** Number of sheets a packing result spans. */
export function sheetCount(regions: readonly PackedRegion[]): number {
  let max = -1;
  for (const r of regions) if (r.sheet > max) max = r.sheet;
  return max + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS I/O - needs a real DOM. Not exercised by vitest.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a closed Path2D from a Piece's outline: `moveTo` the first Edge's
 * `from`, then `bezierCurveTo` every segment of every Edge in order, then
 * close. Coordinates are absolute image space (the same space `Piece.outline`
 * is already defined in) - callers apply their own canvas transform rather
 * than this function baking one in, so the same path works both for baking
 * (translated/scaled into an atlas region) and for hit-testing in
 * `interactions.ts` (used directly in world space).
 */
export function outlineToPath2D(piece: Piece): Path2D {
  const path = new Path2D();
  const outline: readonly Edge[] = piece.outline;
  if (outline.length === 0) return path;

  path.moveTo(outline[0].from.x, outline[0].from.y);
  for (const edge of outline) {
    for (const seg of edge.segments) {
      path.bezierCurveTo(seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y, seg.to.x, seg.to.y);
    }
  }
  path.closePath();
  return path;
}

/** Minimal surface `bakeAtlases` needs from a canvas - satisfied by both
 * `HTMLCanvasElement` and `OffscreenCanvas`. */
export type CanvasLike = {
  width: number;
  height: number;
  getContext(contextId: "2d"): CanvasRenderingContext2D | null;
};

export type BakeOptions = {
  readonly sheetSize?: number;
  readonly padding?: number;
  readonly bakeScale?: number;
  readonly expandPx?: number;
  /** Injectable canvas factory - defaults to `document.createElement("canvas")`. */
  readonly createCanvas?: (size: number) => CanvasLike;
};

export type BakeResult = {
  readonly sheets: readonly CanvasLike[];
  readonly frames: ReadonlyMap<PieceId, Frame>;
};

function defaultCreateCanvas(size: number): CanvasLike {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * Bakes every Piece of `puzzle` from `image` into shared atlas sheets.
 *
 * For each Piece: reserve a `bakeRegionSize(piece.bbox)` region (packed via
 * `packRegions`), set up a canvas transform that maps image space into that
 * region (inset by `expandPx`, scaled by `bakeScale`), clip to the Piece's
 * exact outline and draw the source image, then apply the seam fix: stroke
 * the same outline with the source image as a pattern at `expandPx * 2`
 * width, so the Piece's visible baked pixels extend slightly past its exact
 * boundary. Adjacent Pieces are complementary shapes, so this overlap is
 * invisible while the antialiased-edge gap it replaces would not have been.
 */
export function bakeAtlases(
  puzzle: Puzzle,
  image: CanvasImageSource,
  opts: BakeOptions = {},
): BakeResult {
  const sheetSize = opts.sheetSize ?? ATLAS_SIZE;
  const padding = opts.padding ?? ATLAS_PADDING_PX;
  const bakeScale = opts.bakeScale ?? BAKE_SCALE;
  const expandPx = opts.expandPx ?? BAKE_EXPAND_PX;
  const createCanvas = opts.createCanvas ?? defaultCreateCanvas;

  const pieces = puzzle.pieces;
  const sizes = pieces.map((p) => bakeRegionSize(p.bbox, bakeScale, expandPx));
  const regions = packRegions(sizes, sheetSize, padding);

  const sheets: CanvasLike[] = [];
  for (let i = 0; i < sheetCount(regions); i++) {
    sheets.push(createCanvas(sheetSize));
  }

  const frames = new Map<PieceId, Frame>();

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const region = regions[i];
    const sheet = sheets[region.sheet];
    const ctx = sheet.getContext("2d");
    if (!ctx) {
      throw new Error(`bakeAtlases: sheet ${region.sheet} produced no 2d context`);
    }

    bakePiece(ctx, piece, region, image, bakeScale, expandPx);

    frames.set(piece.id, {
      sheet: region.sheet,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      anchorX: computeAnchor(piece, bakeScale, expandPx).x,
      anchorY: computeAnchor(piece, bakeScale, expandPx).y,
    });
  }

  return { sheets, frames };
}

function bakePiece(
  ctx: CanvasRenderingContext2D,
  piece: Piece,
  region: PackedRegion,
  image: CanvasImageSource,
  bakeScale: number,
  expandPx: number,
): void {
  const path = outlineToPath2D(piece);

  ctx.save();
  ctx.translate(region.x + expandPx, region.y + expandPx);
  ctx.scale(bakeScale, bakeScale);
  ctx.translate(-piece.bbox.x, -piece.bbox.y);

  // Exact fill: clip to the Piece's true outline, draw the source image.
  ctx.save();
  ctx.clip(path);
  ctx.drawImage(image, 0, 0);
  ctx.restore();

  // Seam fix: overpaint a band straddling the boundary with the image itself
  // (as a pattern, so content lines up pixel-for-pixel with the clipped
  // fill) so the visible Piece extends ~expandPx past its exact outline.
  // Complementary neighbours then overlap instead of leaving a hairline gap.
  const pattern = ctx.createPattern(image, "no-repeat");
  if (pattern) {
    ctx.lineJoin = "round";
    ctx.lineWidth = (expandPx * 2) / bakeScale;
    ctx.strokeStyle = pattern;
    ctx.stroke(path);
  }

  ctx.restore();
}

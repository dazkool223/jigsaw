import { describe, expect, it } from "vitest";
import type { Piece } from "../types";
import { ATLAS_PADDING_PX, ATLAS_SIZE, BAKE_EXPAND_PX, BAKE_SCALE } from "../config";
import { bakeRegionSize, computeAnchor, packRegions, sheetCount, type PackedRegion } from "./textures";

// Textures.ts is split into pure maths (tested here, no DOM) and canvas I/O
// (outlineToPath2D / bakeAtlases, which need Path2D / CanvasRenderingContext2D
// and are only exercised in the browser).

function makePiece(bboxX: number, bboxY: number, bboxW: number, bboxH: number, solvedX: number, solvedY: number): Piece {
  return {
    id: 0,
    row: 0,
    col: 0,
    solved: { x: solvedX, y: solvedY },
    outline: [],
    bbox: { x: bboxX, y: bboxY, w: bboxW, h: bboxH },
  };
}

describe("bakeRegionSize", () => {
  it("scales bbox dimensions by BAKE_SCALE and adds BAKE_EXPAND_PX margin on each side", () => {
    const size = bakeRegionSize({ x: 0, y: 0, w: 100, h: 50 });
    expect(size.w).toBe(Math.ceil(100 * BAKE_SCALE) + BAKE_EXPAND_PX * 2);
    expect(size.h).toBe(Math.ceil(50 * BAKE_SCALE) + BAKE_EXPAND_PX * 2);
  });

  it("ceils fractional scaled dimensions so the region always fully covers the bbox", () => {
    const size = bakeRegionSize({ x: 0, y: 0, w: 10.1, h: 10.1 }, 2, 1);
    // 10.1 * 2 = 20.2 -> ceil 21, + 2*1 = 23
    expect(size.w).toBe(23);
    expect(size.h).toBe(23);
  });

  it("honours explicit bakeScale/expandPx overrides independent of config defaults", () => {
    const size = bakeRegionSize({ x: 0, y: 0, w: 100, h: 100 }, 1, 0);
    expect(size).toEqual({ w: 100, h: 100 });
  });

  it("region size is unaffected by bbox origin, only its extent", () => {
    const a = bakeRegionSize({ x: 0, y: 0, w: 40, h: 60 });
    const b = bakeRegionSize({ x: 500, y: -200, w: 40, h: 60 });
    expect(a).toEqual(b);
  });
});

describe("computeAnchor", () => {
  it("is zero when bbox origin equals solved and expand is zero", () => {
    const piece = makePiece(10, 20, 30, 30, 10, 20);
    const anchor = computeAnchor(piece, 1, 0);
    expect(anchor).toEqual({ x: 0, y: 0 });
  });

  it("equals bbox-minus-solved offset (pre-expand) when expandPx is zero", () => {
    // Tab overhang: bbox origin sits to the upper-left of the Cell origin.
    const piece = makePiece(-15, -8, 100, 90, 0, 0);
    const anchor = computeAnchor(piece, 1, 0);
    expect(anchor).toEqual({ x: -15, y: -8 });
  });

  it("subtracts expandPx/bakeScale from the bbox-minus-solved offset", () => {
    const piece = makePiece(-15, -8, 100, 90, 0, 0);
    const anchor = computeAnchor(piece, 2, 4);
    // expand contributes -4/2 = -2 on each axis, on top of the bbox offset.
    expect(anchor.x).toBeCloseTo(-15 - 2, 9);
    expect(anchor.y).toBeCloseTo(-8 - 2, 9);
  });

  it("uses config BAKE_SCALE/BAKE_EXPAND_PX defaults when not overridden", () => {
    const piece = makePiece(5, 5, 50, 50, 0, 0);
    const anchor = computeAnchor(piece);
    expect(anchor.x).toBeCloseTo(5 - BAKE_EXPAND_PX / BAKE_SCALE, 9);
    expect(anchor.y).toBeCloseTo(5 - BAKE_EXPAND_PX / BAKE_SCALE, 9);
  });
});

describe("packRegions", () => {
  it("places a single region at the padded origin of sheet 0", () => {
    const regions = packRegions([{ w: 100, h: 100 }], 4096, 2);
    expect(regions).toEqual([{ sheet: 0, x: 2, y: 2, w: 100, h: 100 }]);
  });

  it("packs regions left-to-right on the same row without overlapping", () => {
    const regions = packRegions(
      [
        { w: 100, h: 50 },
        { w: 200, h: 60 },
        { w: 50, h: 40 },
      ],
      4096,
      2,
    );
    expect(regions).toHaveLength(3);
    expect(regions.every((r) => r.sheet === 0)).toBe(true);
    assertNoOverlaps(regions);
    assertWithinBounds(regions, 4096);
  });

  it("wraps to a new row when a region no longer fits horizontally", () => {
    // Sheet 100px wide, padding 0: two 60-wide regions can't share a row.
    const regions = packRegions([{ w: 60, h: 20 }, { w: 60, h: 20 }], 100, 0);
    expect(regions[0]).toEqual({ sheet: 0, x: 0, y: 0, w: 60, h: 20 });
    expect(regions[1]).toEqual({ sheet: 0, x: 0, y: 20, w: 60, h: 20 });
    assertNoOverlaps(regions);
  });

  it("opens a new sheet when a sheet is full vertically", () => {
    // Sheet 50x50, padding 0: three 30x30 regions can't all fit one sheet
    // (each row wraps after one region since 30+30>50; two rows of 30 = 60 > 50).
    const regions = packRegions(
      [
        { w: 30, h: 30 },
        { w: 30, h: 30 },
        { w: 30, h: 30 },
      ],
      50,
      0,
    );
    expect(regions[0].sheet).toBe(0);
    expect(regions[1].sheet).toBe(1);
    expect(regions[2].sheet).toBe(2);
    assertNoOverlaps(regions.filter((r) => r.sheet === 0));
  });

  it("packs many small regions deterministically within bounds and without overlap", () => {
    const sizes = Array.from({ length: 200 }, (_, i) => ({
      w: 20 + (i % 7),
      h: 20 + (i % 5),
    }));
    const regionsA = packRegions(sizes, ATLAS_SIZE, ATLAS_PADDING_PX);
    const regionsB = packRegions(sizes, ATLAS_SIZE, ATLAS_PADDING_PX);
    expect(regionsA).toEqual(regionsB); // deterministic given the same input
    assertWithinBounds(regionsA, ATLAS_SIZE);
    // Overlap check per-sheet (regions on different sheets may share x/y).
    for (const sheet of new Set(regionsA.map((r) => r.sheet))) {
      assertNoOverlaps(regionsA.filter((r) => r.sheet === sheet));
    }
  });

  it("throws if a single region cannot possibly fit in a sheet", () => {
    expect(() => packRegions([{ w: 5000, h: 5000 }], 4096, 2)).toThrow();
  });

  it("uses config ATLAS_SIZE/ATLAS_PADDING_PX defaults when not overridden", () => {
    const regions = packRegions([{ w: 10, h: 10 }]);
    expect(regions).toEqual([{ sheet: 0, x: ATLAS_PADDING_PX, y: ATLAS_PADDING_PX, w: 10, h: 10 }]);
  });
});

describe("sheetCount", () => {
  it("is 0 for no regions", () => {
    expect(sheetCount([])).toBe(0);
  });

  it("is 1 when everything fits on sheet 0", () => {
    const regions = packRegions([{ w: 10, h: 10 }, { w: 10, h: 10 }], 4096, 2);
    expect(sheetCount(regions)).toBe(1);
  });

  it("counts the highest sheet index + 1, even out of order", () => {
    const regions: PackedRegion[] = [
      { sheet: 2, x: 0, y: 0, w: 1, h: 1 },
      { sheet: 0, x: 0, y: 0, w: 1, h: 1 },
    ];
    expect(sheetCount(regions)).toBe(3);
  });
});

// ─── helpers ───

function assertNoOverlaps(regions: readonly PackedRegion[]): void {
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i];
      const b = regions[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap).toBe(false);
    }
  }
}

function assertWithinBounds(regions: readonly PackedRegion[], sheetSize: number): void {
  for (const r of regions) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(sheetSize);
    expect(r.y + r.h).toBeLessThanOrEqual(sheetSize);
  }
}

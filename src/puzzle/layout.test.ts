import { describe, expect, it } from "vitest";
import { SCATTER_MARGIN } from "../config";
import { fitGrid, scatterOffsets } from "./layout";

describe("fitGrid", () => {
  it("matches the documented 4:3 500-piece example: 26x19 = 494", () => {
    const grid = fitGrid(2048, 1536, 500);
    expect(grid.cols).toBe(26);
    expect(grid.rows).toBe(19);
    expect(grid.rows * grid.cols).toBe(494);
  });

  it("derives cell size from image size and grid", () => {
    const grid = fitGrid(2048, 1536, 500);
    expect(grid.cellW).toBeCloseTo(2048 / 26);
    expect(grid.cellH).toBeCloseTo(1536 / 19);
    expect(grid.imageW).toBe(2048);
    expect(grid.imageH).toBe(1536);
  });

  it("never yields fewer than 2 rows or 2 columns, even for tiny targets", () => {
    const grid = fitGrid(1000, 1000, 1);
    expect(grid.rows).toBeGreaterThanOrEqual(2);
    expect(grid.cols).toBeGreaterThanOrEqual(2);
  });

  it("stays sane at an extreme wide aspect ratio (4000x400)", () => {
    const grid = fitGrid(4000, 400, 300);
    expect(grid.rows).toBeGreaterThanOrEqual(2);
    expect(grid.cols).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(grid.cellW)).toBe(true);
    expect(Number.isFinite(grid.cellH)).toBe(true);
    expect(grid.cellW).toBeGreaterThan(0);
    expect(grid.cellH).toBeGreaterThan(0);
    // Wide image -> many more columns than rows.
    expect(grid.cols).toBeGreaterThan(grid.rows);
  });

  it("stays sane at an extreme tall aspect ratio (400x4000)", () => {
    const grid = fitGrid(400, 4000, 300);
    expect(grid.rows).toBeGreaterThanOrEqual(2);
    expect(grid.cols).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(grid.cellW)).toBe(true);
    expect(Number.isFinite(grid.cellH)).toBe(true);
    expect(grid.cellW).toBeGreaterThan(0);
    expect(grid.cellH).toBeGreaterThan(0);
    expect(grid.rows).toBeGreaterThan(grid.cols);
  });

  it("piece count is always positive and grid dims match cell dims", () => {
    for (const target of [24, 100, 300, 500]) {
      const grid = fitGrid(1920, 1080, target);
      expect(grid.rows * grid.cols).toBeGreaterThan(0);
      expect(grid.cellW * grid.cols).toBeCloseTo(1920);
      expect(grid.cellH * grid.rows).toBeCloseTo(1080);
    }
  });
});

describe("scatterOffsets", () => {
  const grid = fitGrid(800, 600, 24);

  it("returns one offset per piece, row-major (id = row*cols+col)", () => {
    const offsets = scatterOffsets(grid, 1);
    expect(offsets.length).toBe(grid.rows * grid.cols);
  });

  it("is deterministic for a given seed", () => {
    const a = scatterOffsets(grid, 42);
    const b = scatterOffsets(grid, 42);
    expect(a).toEqual(b);
  });

  it("differs for a different seed", () => {
    const a = scatterOffsets(grid, 1);
    const b = scatterOffsets(grid, 2);
    expect(a).not.toEqual(b);
  });

  it("scatters every piece within the image area expanded by SCATTER_MARGIN", () => {
    const offsets = scatterOffsets(grid, 7);
    const marginX = grid.imageW * SCATTER_MARGIN;
    const marginY = grid.imageH * SCATTER_MARGIN;
    let idx = 0;
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const solved = { x: col * grid.cellW, y: row * grid.cellH };
        const offset = offsets[idx++];
        const worldX = solved.x + offset.x;
        const worldY = solved.y + offset.y;
        expect(worldX).toBeGreaterThanOrEqual(-marginX - 1e-6);
        expect(worldX).toBeLessThanOrEqual(grid.imageW + marginX + 1e-6);
        expect(worldY).toBeGreaterThanOrEqual(-marginY - 1e-6);
        expect(worldY).toBeLessThanOrEqual(grid.imageH + marginY + 1e-6);
      }
    }
  });

  it("does not place every piece at the same spot (spread sanity check)", () => {
    const offsets = scatterOffsets(grid, 7);
    const distinctX = new Set(offsets.map((o) => o.x));
    expect(distinctX.size).toBeGreaterThan(1);
  });
});

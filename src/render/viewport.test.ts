import { describe, expect, it } from "vitest";
import { ZOOM_MAX, ZOOM_MIN } from "../config";
import {
  clampScale,
  fitToContent,
  pan,
  screenToWorld,
  worldToScreen,
  zoomToCursor,
  type Viewport,
} from "./viewport";

describe("clampScale", () => {
  it("passes through values already in range", () => {
    expect(clampScale(1)).toBe(1);
  });

  it("clamps below ZOOM_MIN up to ZOOM_MIN", () => {
    expect(clampScale(ZOOM_MIN - 5)).toBe(ZOOM_MIN);
  });

  it("clamps above ZOOM_MAX down to ZOOM_MAX", () => {
    expect(clampScale(ZOOM_MAX + 5)).toBe(ZOOM_MAX);
  });
});

describe("screenToWorld / worldToScreen round-trip", () => {
  it("round-trips an arbitrary point at scale 1, origin 0", () => {
    const vp: Viewport = { origin: { x: 0, y: 0 }, scale: 1 };
    const world = screenToWorld(vp, { x: 123, y: 456 });
    expect(world).toEqual({ x: 123, y: 456 });
    expect(worldToScreen(vp, world)).toEqual({ x: 123, y: 456 });
  });

  it("round-trips with a non-trivial origin and scale", () => {
    const vp: Viewport = { origin: { x: 200, y: -50 }, scale: 2.5 };
    const screen = { x: 317, y: 42 };
    const world = screenToWorld(vp, screen);
    const back = worldToScreen(vp, world);
    expect(back.x).toBeCloseTo(screen.x, 9);
    expect(back.y).toBeCloseTo(screen.y, 9);
  });

  it("worldToScreen is the inverse of screenToWorld for many random points", () => {
    const vp: Viewport = { origin: { x: -37.5, y: 812.1 }, scale: 0.73 };
    for (let i = 0; i < 20; i++) {
      const world = { x: i * 17.3 - 100, y: i * -8.1 + 50 };
      const screen = worldToScreen(vp, world);
      const roundTrip = screenToWorld(vp, screen);
      expect(roundTrip.x).toBeCloseTo(world.x, 9);
      expect(roundTrip.y).toBeCloseTo(world.y, 9);
    }
  });
});

describe("pan", () => {
  it("moves the origin opposite to the screen delta, scaled", () => {
    const vp: Viewport = { origin: { x: 0, y: 0 }, scale: 2 };
    const panned = pan(vp, { x: 20, y: -10 });
    expect(panned.origin).toEqual({ x: -10, y: 5 });
    expect(panned.scale).toBe(2);
  });

  it("panning keeps the point under the pointer fixed on screen", () => {
    // Standard drag-to-pan feel: the world point that was under the pointer
    // before the pan is still under the pointer after.
    const vp: Viewport = { origin: { x: 10, y: 10 }, scale: 1.5 };
    const screenPoint = { x: 100, y: 80 };
    const worldBefore = screenToWorld(vp, screenPoint);

    const delta = { x: 30, y: -15 };
    const panned = pan(vp, delta);
    const screenAfter = worldToScreen(panned, worldBefore);

    // The pointer moved by `delta` on screen; the same world point should
    // now render `delta` away from where it was.
    expect(screenAfter.x).toBeCloseTo(screenPoint.x + delta.x, 9);
    expect(screenAfter.y).toBeCloseTo(screenPoint.y + delta.y, 9);
  });

  it("is a no-op with a zero delta", () => {
    const vp: Viewport = { origin: { x: 5, y: 5 }, scale: 3 };
    expect(pan(vp, { x: 0, y: 0 })).toEqual(vp);
  });
});

describe("zoomToCursor", () => {
  it("keeps the world point under the cursor fixed on screen after zooming in", () => {
    const vp: Viewport = { origin: { x: 12, y: -8 }, scale: 1 };
    const cursor = { x: 250, y: 140 };
    const worldUnderCursor = screenToWorld(vp, cursor);

    const zoomed = zoomToCursor(vp, cursor, 1.5);

    expect(zoomed.scale).toBeCloseTo(1.5, 9);
    const screenAfter = worldToScreen(zoomed, worldUnderCursor);
    expect(screenAfter.x).toBeCloseTo(cursor.x, 9);
    expect(screenAfter.y).toBeCloseTo(cursor.y, 9);
  });

  it("keeps the world point under the cursor fixed on screen after zooming out", () => {
    const vp: Viewport = { origin: { x: 0, y: 0 }, scale: 2 };
    const cursor = { x: 50, y: 900 };
    const worldUnderCursor = screenToWorld(vp, cursor);

    const zoomed = zoomToCursor(vp, cursor, 0.5);

    expect(zoomed.scale).toBeCloseTo(1, 9);
    const screenAfter = worldToScreen(zoomed, worldUnderCursor);
    expect(screenAfter.x).toBeCloseTo(cursor.x, 9);
    expect(screenAfter.y).toBeCloseTo(cursor.y, 9);
  });

  it("clamps at ZOOM_MAX and still holds the cursor point fixed at the achieved scale", () => {
    const vp: Viewport = { origin: { x: 0, y: 0 }, scale: ZOOM_MAX - 0.1 };
    const cursor = { x: 400, y: 300 };
    const worldUnderCursor = screenToWorld(vp, cursor);

    const zoomed = zoomToCursor(vp, cursor, 10); // way past the max

    expect(zoomed.scale).toBe(ZOOM_MAX);
    const screenAfter = worldToScreen(zoomed, worldUnderCursor);
    expect(screenAfter.x).toBeCloseTo(cursor.x, 9);
    expect(screenAfter.y).toBeCloseTo(cursor.y, 9);
  });

  it("clamps at ZOOM_MIN and still holds the cursor point fixed at the achieved scale", () => {
    const vp: Viewport = { origin: { x: 0, y: 0 }, scale: ZOOM_MIN + 0.1 };
    const cursor = { x: 400, y: 300 };
    const worldUnderCursor = screenToWorld(vp, cursor);

    const zoomed = zoomToCursor(vp, cursor, 0.01); // way past the min

    expect(zoomed.scale).toBe(ZOOM_MIN);
    const screenAfter = worldToScreen(zoomed, worldUnderCursor);
    expect(screenAfter.x).toBeCloseTo(cursor.x, 9);
    expect(screenAfter.y).toBeCloseTo(cursor.y, 9);
  });

  it("is a no-op (same viewport reference) when already clamped and pushed further", () => {
    const vp: Viewport = { origin: { x: 3, y: 4 }, scale: ZOOM_MAX };
    const zoomed = zoomToCursor(vp, { x: 10, y: 10 }, 2);
    expect(zoomed).toBe(vp);
  });
});

describe("fitToContent", () => {
  it("centres square content in a square screen at scale 1", () => {
    const content = { x: 0, y: 0, w: 800, h: 800 };
    const vp = fitToContent(content, 800, 800, 0);
    expect(vp.scale).toBeCloseTo(1, 9);
    // World (0,0) should map to screen (0,0), world (800,800) to (800,800).
    expect(worldToScreen(vp, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    const br = worldToScreen(vp, { x: 800, y: 800 });
    expect(br.x).toBeCloseTo(800, 9);
    expect(br.y).toBeCloseTo(800, 9);
  });

  it("picks the limiting axis for non-square content on a square screen", () => {
    // Wide content: width is the limiting dimension.
    const content = { x: 0, y: 0, w: 2000, h: 500 };
    const vp = fitToContent(content, 1000, 1000, 0);
    expect(vp.scale).toBeCloseTo(0.5, 9);
  });

  it("respects padding", () => {
    const content = { x: 0, y: 0, w: 100, h: 100 };
    const vp = fitToContent(content, 200, 200, 50);
    // available = 200 - 2*50 = 100 -> scale 1
    expect(vp.scale).toBeCloseTo(1, 9);
  });

  it("centres content within the screen", () => {
    const content = { x: 10, y: 10, w: 100, h: 100 };
    const vp = fitToContent(content, 200, 200, 0);
    const contentCenterScreen = worldToScreen(vp, { x: 60, y: 60 });
    expect(contentCenterScreen.x).toBeCloseTo(100, 9);
    expect(contentCenterScreen.y).toBeCloseTo(100, 9);
  });

  it("clamps scale to ZOOM_MAX for tiny content in a huge screen", () => {
    const content = { x: 0, y: 0, w: 1, h: 1 };
    const vp = fitToContent(content, 100000, 100000, 0);
    expect(vp.scale).toBe(ZOOM_MAX);
  });

  it("clamps scale to ZOOM_MIN for huge content in a tiny screen", () => {
    const content = { x: 0, y: 0, w: 1000000, h: 1000000 };
    const vp = fitToContent(content, 10, 10, 0);
    expect(vp.scale).toBe(ZOOM_MIN);
  });
});

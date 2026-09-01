import { describe, expect, it } from "vitest";
import type { Rect } from "../types";
import { ZOOM_MAX, ZOOM_MIN } from "../config";
import {
  clampAxisToBounds,
  clampScale,
  clampViewport,
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

describe("clampAxisToBounds", () => {
  it("passes through a position already fully inside the bounds", () => {
    expect(clampAxisToBounds(50, 20, 0, 100)).toBe(50);
  });

  it("clamps up to the bound's near edge when the box sits before it", () => {
    expect(clampAxisToBounds(-30, 20, 0, 100)).toBe(0);
  });

  it("clamps down to the bound's far edge when the box sits past it", () => {
    expect(clampAxisToBounds(90, 20, 0, 100)).toBe(80);
  });

  it("centers the box when it is bigger than the bounds, instead of picking an edge", () => {
    expect(clampAxisToBounds(0, 150, 0, 100)).toBe(-25);
    expect(clampAxisToBounds(1000, 150, 0, 100)).toBe(-25); // same result regardless of where it started
  });
});

describe("clampViewport - restricts the camera to a play-area rect", () => {
  const bounds: Rect = { x: -100, y: -50, w: 800, h: 400 }; // e.g. an image + SCATTER_MARGIN

  it("is a no-op when the visible rect is already inside bounds", () => {
    const vp: Viewport = { origin: { x: 0, y: 0 }, scale: 1 };
    // 200x150 visible at scale 1 fits well inside the 800x400 bounds.
    expect(clampViewport(vp, bounds, 200, 150)).toEqual(vp);
  });

  it("pulls the origin back when panned past the bounds' near edge", () => {
    const vp: Viewport = { origin: { x: -500, y: -50 }, scale: 1 };
    const clamped = clampViewport(vp, bounds, 200, 150);
    expect(clamped.origin.x).toBe(bounds.x);
  });

  it("pulls the origin back when panned past the bounds' far edge", () => {
    const vp: Viewport = { origin: { x: 900, y: -50 }, scale: 1 };
    const clamped = clampViewport(vp, bounds, 200, 150);
    expect(clamped.origin.x).toBe(bounds.x + bounds.w - 200);
  });

  it("never changes scale - only origin is clamped", () => {
    const vp: Viewport = { origin: { x: 900, y: -50 }, scale: 2.3 };
    expect(clampViewport(vp, bounds, 200, 150).scale).toBe(2.3);
  });

  // Mobile: a narrow, tall (portrait) screen - the visible rect's aspect
  // ratio differs sharply from the bounds rect's. Each axis must clamp
  // independently rather than assuming a landscape-ish screen.
  describe("mobile portrait screen (390x844, an iPhone-sized viewport)", () => {
    const screenW = 390;
    const screenH = 844;

    it("keeps a normally-panned view untouched when both axes already fit", () => {
      // At scale 3 the visible rect (130x281) fits inside bounds (800x400)
      // on both axes, so a view already within bounds passes through as-is.
      const vp: Viewport = { origin: { x: 100, y: 0 }, scale: 3 };
      expect(clampViewport(vp, bounds, screenW, screenH)).toEqual(vp);
    });

    it("clamps horizontal pan independently of the tall vertical extent", () => {
      const vp: Viewport = { origin: { x: -1000, y: 0 }, scale: 1 };
      const clamped = clampViewport(vp, bounds, screenW, screenH);
      expect(clamped.origin.x).toBe(bounds.x);
    });

    it("centers vertically when zoomed out enough that the tall screen sees past the bounds' height", () => {
      // At scale 1, visibleH (844) > bounds.h (400) - the screen shows more
      // vertical extent than the play area has, so it should center rather
      // than pin to bounds.y.
      const vp: Viewport = { origin: { x: 0, y: 5000 }, scale: 1 };
      const clamped = clampViewport(vp, bounds, screenW, screenH);
      expect(clamped.origin.y).toBeCloseTo(bounds.y + (bounds.h - screenH) / 2, 9);
    });

    it("clamps to the bottom edge when partially zoomed in on a tall screen", () => {
      // scale 3 -> visibleH = 844/3 ≈ 281.3, smaller than bounds.h (400), so
      // normal edge-clamping applies on the vertical axis.
      const vp: Viewport = { origin: { x: 0, y: 1000 }, scale: 3 };
      const clamped = clampViewport(vp, bounds, screenW, screenH);
      const visibleH = screenH / 3;
      expect(clamped.origin.y).toBeCloseTo(bounds.y + bounds.h - visibleH, 9);
    });
  });

  it("centers on both axes when fully zoomed out past the bounds on a small screen", () => {
    const smallBounds: Rect = { x: -100, y: -50, w: 300, h: 200 };
    const vp: Viewport = { origin: { x: 0, y: 0 }, scale: ZOOM_MIN };
    const clamped = clampViewport(vp, smallBounds, 100, 100);
    const visibleW = 100 / ZOOM_MIN;
    const visibleH = 100 / ZOOM_MIN;
    expect(clamped.origin.x).toBeCloseTo(smallBounds.x + (smallBounds.w - visibleW) / 2, 9);
    expect(clamped.origin.y).toBeCloseTo(smallBounds.y + (smallBounds.h - visibleH) / 2, 9);
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

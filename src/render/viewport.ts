/**
 * Pure pan/zoom maths for the board camera. No Pixi, no DOM - everything here
 * is testable without a browser.
 *
 * The Viewport maps world space (image-space puzzle coordinates) to screen
 * space (CSS pixels of the canvas element):
 *
 *   screen = (world - origin) * scale
 *   world  = screen / scale + origin
 *
 * `origin` is the world-space point that sits at screen (0, 0); `scale` is
 * the current zoom factor, clamped to [ZOOM_MIN, ZOOM_MAX].
 */

import type { Point, Rect } from "../types";
import { ZOOM_MAX, ZOOM_MIN } from "../config";

export type Viewport = {
  readonly origin: Point;
  readonly scale: number;
};

/** Clamp a raw scale value into the configured zoom range. */
export function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

export function screenToWorld(viewport: Viewport, screen: Point): Point {
  return {
    x: screen.x / viewport.scale + viewport.origin.x,
    y: screen.y / viewport.scale + viewport.origin.y,
  };
}

export function worldToScreen(viewport: Viewport, world: Point): Point {
  return {
    x: (world.x - viewport.origin.x) * viewport.scale,
    y: (world.y - viewport.origin.y) * viewport.scale,
  };
}

/**
 * Pan by a screen-space delta (e.g. pointer movement in CSS pixels). Positive
 * `dx`/`dy` drags the content toward the pointer, i.e. the world scrolls
 * opposite to the screen delta.
 */
export function pan(viewport: Viewport, screenDelta: Point): Viewport {
  return {
    ...viewport,
    origin: {
      x: viewport.origin.x - screenDelta.x / viewport.scale,
      y: viewport.origin.y - screenDelta.y / viewport.scale,
    },
  };
}

/**
 * Zoom so that `screenPoint` (in CSS pixels, relative to the canvas) stays
 * fixed in screen space - the standard "zoom to cursor" feel. `deltaScale` is
 * a multiplier applied to the current scale (e.g. 1.1 to zoom in 10%), and
 * the result is clamped to [ZOOM_MIN, ZOOM_MAX]. If the clamp caps the
 * requested scale, the cursor point is still held fixed at the achieved
 * scale (not the requested one).
 */
export function zoomToCursor(viewport: Viewport, screenPoint: Point, deltaScale: number): Viewport {
  const newScale = clampScale(viewport.scale * deltaScale);
  if (newScale === viewport.scale) return viewport;

  // World point currently under the cursor, at the OLD scale.
  const worldAtCursor = screenToWorld(viewport, screenPoint);

  // Choose a new origin so that worldAtCursor maps back to screenPoint at
  // the NEW scale: screenPoint = (worldAtCursor - newOrigin) * newScale.
  const newOrigin: Point = {
    x: worldAtCursor.x - screenPoint.x / newScale,
    y: worldAtCursor.y - screenPoint.y / newScale,
  };

  return { origin: newOrigin, scale: newScale };
}

/**
 * A Viewport that fits `content` (world-space rect) centred within a screen
 * of size `screenW` x `screenH`, with `paddingPx` of screen-space breathing
 * room on every side. Scale is clamped to [ZOOM_MIN, ZOOM_MAX] - a content
 * rect much larger or smaller than the screen will not perfectly fill it if
 * that would require zooming past the configured limits.
 */
export function fitToContent(
  content: Rect,
  screenW: number,
  screenH: number,
  paddingPx = 0,
): Viewport {
  const availW = Math.max(1, screenW - paddingPx * 2);
  const availH = Math.max(1, screenH - paddingPx * 2);
  const scaleX = content.w > 0 ? availW / content.w : ZOOM_MAX;
  const scaleY = content.h > 0 ? availH / content.h : ZOOM_MAX;
  const scale = clampScale(Math.min(scaleX, scaleY));

  const contentCenter: Point = {
    x: content.x + content.w / 2,
    y: content.y + content.h / 2,
  };
  const screenCenter: Point = { x: screenW / 2, y: screenH / 2 };

  const origin: Point = {
    x: contentCenter.x - screenCenter.x / scale,
    y: contentCenter.y - screenCenter.y / scale,
  };

  return { origin, scale };
}

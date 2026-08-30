/**
 * The image normalisation pipeline (see docs/adr/0002-image-normalisation-pipeline.md
 * and plan "Image normalisation"). Runs once, at upload, off the gameplay path:
 *
 *   1. reject files over UPLOAD_MAX_BYTES BEFORE decoding
 *   2. decode with createImageBitmap - no extension gating; format support is
 *      a property of the browser, not the filename
 *   3. downscale so the longest side is at most IMAGE_MAX_EDGE
 *   4. encode WebP at WEBP_QUALITY; fall back to JPEG at JPEG_FALLBACK_QUALITY
 *      if the browser can't encode WebP
 *   5. upload to rooms/<code>/image-<random> with the REAL content type
 *      (see uploadPathForRoom for why the random suffix)
 *
 * The pure, testable parts (size check, dimension maths, format decision) are
 * exported separately from the I/O (decode, canvas, upload) so they can be
 * unit-tested without a browser or network - see storageUpload.test.ts.
 */

import { nanoid } from "nanoid";
import { IMAGE_MAX_EDGE, JPEG_FALLBACK_QUALITY, UPLOAD_MAX_BYTES, WEBP_QUALITY } from "../config";
import { supabase } from "./client";

const BUCKET = "puzzles";

// ─────────────────────────────────────────────────────────────────────────────
// Errors - each carries a message safe to show directly to the user.
// ─────────────────────────────────────────────────────────────────────────────

export class UploadTooLargeError extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `That image is ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB, which is over the ` +
        `${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit. Try a smaller image.`,
    );
    this.name = "UploadTooLargeError";
  }
}

/** The HEIC-in-Chrome case: createImageBitmap rejected the file. */
export class UnsupportedImageFormatError extends Error {
  constructor() {
    super(
      "This image format isn't supported by your browser - export it as JPEG " +
        "or take a screenshot of it.",
    );
    this.name = "UnsupportedImageFormatError";
  }
}

export class ImageEncodeError extends Error {
  constructor() {
    super("This browser couldn't prepare the image for upload. Try a different browser.");
    this.name = "ImageEncodeError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic - unit-tested directly, no DOM/network required.
// ─────────────────────────────────────────────────────────────────────────────

/** Step 1. Throws UploadTooLargeError; call this BEFORE any decode is attempted. */
export function assertUploadSize(sizeBytes: number, maxBytes: number = UPLOAD_MAX_BYTES): void {
  if (sizeBytes > maxBytes) {
    throw new UploadTooLargeError(sizeBytes, maxBytes);
  }
}

/**
 * Step 3's maths. Downscales so the longer side is at most maxEdge, preserving
 * aspect ratio. Never upscales - an image already within the limit is returned
 * unchanged (same object shape, values may be identical to the input).
 */
export function computeScaledDimensions(
  width: number,
  height: number,
  maxEdge: number = IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Minimal shape of what step 4 needs from a canvas - real HTMLCanvasElement satisfies it. */
export type BlobEncodableCanvas = {
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
};

/** Promise-wrapped canvas.toBlob. */
export function canvasToBlob(
  canvas: BlobEncodableCanvas,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Step 4: try WebP, fall back to JPEG. "The browser cannot encode WebP" shows
 * up as toBlob(..., 'image/webp') either yielding null OR yielding a blob
 * whose .type isn't 'image/webp' (some browsers silently substitute PNG) -
 * both are treated as "no WebP support" and trigger the JPEG fallback.
 */
export async function encodeNormalisedImage(
  canvas: BlobEncodableCanvas,
  webpQuality: number = WEBP_QUALITY,
  jpegQuality: number = JPEG_FALLBACK_QUALITY,
): Promise<{ blob: Blob; contentType: string }> {
  const webpBlob = await canvasToBlob(canvas, "image/webp", webpQuality);
  if (webpBlob && webpBlob.type === "image/webp") {
    return { blob: webpBlob, contentType: "image/webp" };
  }

  const jpegBlob = await canvasToBlob(canvas, "image/jpeg", jpegQuality);
  if (!jpegBlob) {
    throw new ImageEncodeError();
  }
  return { blob: jpegBlob, contentType: jpegBlob.type || "image/jpeg" };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O - decode, canvas, network. Not unit-tested (needs a real browser).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Steps 1-2: size check then decode. Split out from the rest of the pipeline
 * so "oversize is rejected before decode" is directly testable by stubbing
 * global.createImageBitmap and asserting it was never called.
 */
export async function decodeUpload(
  file: Blob,
  maxBytes: number = UPLOAD_MAX_BYTES,
): Promise<ImageBitmap> {
  assertUploadSize(file.size, maxBytes);

  try {
    return await createImageBitmap(file);
  } catch {
    throw new UnsupportedImageFormatError();
  }
}

export type UploadResult = { path: string; contentType: string };

/**
 * A fresh storage path for a Room's image, under its code (still requires
 * the code to construct - see ADR-0001) but never reused across upload
 * attempts. `rooms/<code>/image` alone would collide if a user re-picks the
 * image before clicking "Create puzzle" (no Room row exists yet to gate a
 * second upload), and Storage's own overwrite mechanisms both turned out to
 * be unusable here: `upsert: true` needs a SELECT policy we deliberately
 * don't grant (ADR-0001 - it would let the bundled publishable key list and
 * enumerate every Room code), and delete-then-insert should in principle
 * work with an insert+delete-only grant but Storage's DELETE endpoint
 * silently no-ops for the publishable key in production testing - a random
 * suffix per attempt sidesteps both instead of chasing why. An abandoned
 * attempt's object is harmless clutter (see CONTEXT.md TODO "Storage/Room
 * hygiene"), never referenced by any Room since only the path actually
 * passed to `create_room` becomes `image_path`.
 */
export function uploadPathForRoom(code: string): string {
  return `rooms/${code}/image-${nanoid(8)}`;
}

/**
 * The public CDN URL for an object at `path` (as stored in a Room's
 * `image_path` - see supabase/rooms.ts). `BUCKET` is intentionally not
 * exported - this is the one place that needs to know its name, so every
 * caller goes through here instead of each hand-rolling `/storage/v1/...`
 * (there is no anon SELECT policy on this bucket, per schema.sql, so this
 * public-object URL is the only way to read an image back; see ADR-0001).
 */
export function getPublicImageUrl(path: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** The full pipeline: validate, decode, downscale, encode, upload. */
export async function normaliseAndUploadImage(file: File, code: string): Promise<UploadResult> {
  const bitmap = await decodeUpload(file);

  const { width, height } = computeScaledDimensions(bitmap.width, bitmap.height, IMAGE_MAX_EDGE);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new ImageEncodeError();
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const { blob, contentType } = await encodeNormalisedImage(canvas);

  const path = uploadPathForRoom(code);
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType });
  if (error) {
    throw new Error(`Image upload failed: ${error.message}`);
  }

  return { path, contentType };
}

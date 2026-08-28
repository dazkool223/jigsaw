import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertUploadSize,
  type BlobEncodableCanvas,
  computeScaledDimensions,
  decodeUpload,
  encodeNormalisedImage,
  UnsupportedImageFormatError,
  UploadTooLargeError,
} from "./storageUpload";
import { IMAGE_MAX_EDGE, UPLOAD_MAX_BYTES } from "../config";

describe("assertUploadSize", () => {
  it("passes files at or under the limit", () => {
    expect(() => assertUploadSize(UPLOAD_MAX_BYTES, UPLOAD_MAX_BYTES)).not.toThrow();
    expect(() => assertUploadSize(100, UPLOAD_MAX_BYTES)).not.toThrow();
  });

  it("rejects files over the limit", () => {
    expect(() => assertUploadSize(UPLOAD_MAX_BYTES + 1, UPLOAD_MAX_BYTES)).toThrow(
      UploadTooLargeError,
    );
  });
});

describe("decodeUpload — size is rejected before any decode is attempted", () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  });

  it("never calls createImageBitmap for an oversize file", async () => {
    const createImageBitmap = vi.fn();
    globalThis.createImageBitmap = createImageBitmap as unknown as typeof globalThis.createImageBitmap;

    const oversizeFile = { size: UPLOAD_MAX_BYTES + 1 } as unknown as Blob;

    await expect(decodeUpload(oversizeFile)).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("attempts decode for a file within the size limit", async () => {
    const fakeBitmap = { width: 100, height: 100 } as unknown as ImageBitmap;
    const createImageBitmap = vi.fn().mockResolvedValue(fakeBitmap);
    globalThis.createImageBitmap = createImageBitmap as unknown as typeof globalThis.createImageBitmap;

    const okFile = { size: 100 } as unknown as Blob;
    const result = await decodeUpload(okFile);

    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(result).toBe(fakeBitmap);
  });

  it("reports a specific, user-showable error when decode fails (HEIC-in-Chrome case)", async () => {
    const createImageBitmap = vi.fn().mockRejectedValue(new Error("not a supported image type"));
    globalThis.createImageBitmap = createImageBitmap as unknown as typeof globalThis.createImageBitmap;

    const okFile = { size: 100 } as unknown as Blob;
    await expect(decodeUpload(okFile)).rejects.toBeInstanceOf(UnsupportedImageFormatError);
  });
});

describe("computeScaledDimensions", () => {
  it("downscales a landscape image, preserving aspect ratio", () => {
    const result = computeScaledDimensions(4096, 2048, IMAGE_MAX_EDGE);
    expect(result).toEqual({ width: 2048, height: 1024 });
  });

  it("downscales a portrait image, preserving aspect ratio", () => {
    const result = computeScaledDimensions(2048, 4096, IMAGE_MAX_EDGE);
    expect(result).toEqual({ width: 1024, height: 2048 });
  });

  it("downscales a square image, preserving aspect ratio", () => {
    const result = computeScaledDimensions(3000, 3000, IMAGE_MAX_EDGE);
    expect(result).toEqual({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE });
  });

  it("never upscales an image already smaller than the limit", () => {
    expect(computeScaledDimensions(500, 300, IMAGE_MAX_EDGE)).toEqual({ width: 500, height: 300 });
    expect(computeScaledDimensions(300, 500, IMAGE_MAX_EDGE)).toEqual({ width: 300, height: 500 });
    expect(computeScaledDimensions(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, IMAGE_MAX_EDGE)).toEqual({
      width: IMAGE_MAX_EDGE,
      height: IMAGE_MAX_EDGE,
    });
  });

  it("uses an arbitrary maxEdge and always keeps the longest side within it", () => {
    const result = computeScaledDimensions(1000, 250, 500);
    expect(result.width).toBe(500);
    expect(result.height).toBe(125);
  });
});

describe("encodeNormalisedImage — WebP-vs-JPEG fallback decision", () => {
  function stubCanvas(
    behavior: (type: string | undefined) => Blob | null,
  ): BlobEncodableCanvas {
    return {
      toBlob(callback, type) {
        callback(behavior(type));
      },
    };
  }

  it("uses WebP when the browser can encode it", async () => {
    const canvas = stubCanvas((type) =>
      type === "image/webp" ? ({ type: "image/webp" } as Blob) : ({ type: "image/jpeg" } as Blob),
    );

    const result = await encodeNormalisedImage(canvas);
    expect(result.contentType).toBe("image/webp");
  });

  it("falls back to JPEG when toBlob returns null for WebP", async () => {
    const canvas = stubCanvas((type) =>
      type === "image/webp" ? null : ({ type: "image/jpeg" } as Blob),
    );

    const result = await encodeNormalisedImage(canvas);
    expect(result.contentType).toBe("image/jpeg");
  });

  it("falls back to JPEG when toBlob silently substitutes a different type for WebP", async () => {
    // Some browsers return a blob (not null) but of a different type when
    // asked to encode a format they don't support.
    const canvas = stubCanvas((type) =>
      type === "image/webp" ? ({ type: "image/png" } as Blob) : ({ type: "image/jpeg" } as Blob),
    );

    const result = await encodeNormalisedImage(canvas);
    expect(result.contentType).toBe("image/jpeg");
  });

  it("passes the configured quality values through to toBlob", async () => {
    const calls: Array<{ type?: string; quality?: number }> = [];
    const canvas: BlobEncodableCanvas = {
      toBlob(callback, type, quality) {
        calls.push({ type, quality });
        callback(type === "image/webp" ? ({ type: "image/webp" } as Blob) : null);
      },
    };

    await encodeNormalisedImage(canvas, 0.7, 0.9);
    expect(calls[0]).toEqual({ type: "image/webp", quality: 0.7 });
  });
});

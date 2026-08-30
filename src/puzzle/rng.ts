/**
 * Deterministic PRNG. Every geometry aspect (vertex jitter, Tab direction,
 * Tab position, Tab size, scatter offsets, ...) must derive its randomness
 * from here - never `Math.random`, `Date.now`, or any other external entropy
 * - so that the same (image, seed, rows, cols) always regenerates byte-
 * identical geometry on every peer and every run.
 *
 * `mulberry32` is pure 32-bit integer/float arithmetic (no platform-specific
 * float rounding paths), so it is byte-identical across machines and JS
 * engines, unlike relying on Math.random's implementation-defined algorithm.
 */

export type RandomFn = () => number;

/**
 * mulberry32: a small, fast, seeded PRNG. Returns floats in [0, 1).
 * Public-domain algorithm; ~2^32 period, good statistical quality for our
 * purposes (visual jitter/placement, not cryptography).
 */
export function mulberry32(seed: number): RandomFn {
  let a = seed >>> 0;
  return function random(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash. Deterministic, dependency-free. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Final mix step (murmur3-style) so xor-combined seeds don't leak structure. */
function mix32(x: number): number {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = x ^ (x >>> 16);
  return x >>> 0;
}

/**
 * Derive a deterministic sub-seed from a base seed and a string/coords key
 * (e.g. `"vertex:3,4"`, `"edge:h:2:5"`, `"scatter:12"`). Different geometry
 * aspects can then each draw from their own independent PRNG instance without
 * order-coupling: it does not matter whether the caller generates vertex
 * (3,4) before or after edge h(2,5), the sequence each one sees is fixed by
 * its own key, not by call order.
 */
export function subSeed(baseSeed: number, key: string): number {
  const combined = (baseSeed >>> 0) ^ fnv1a(key);
  return mix32(combined);
}

/** Convenience: a fresh PRNG derived directly from a base seed + key. */
export function keyedRandom(baseSeed: number, key: string): RandomFn {
  return mulberry32(subSeed(baseSeed, key));
}

/** Map a [0,1) draw to [-1, 1), for symmetric jitter around zero. */
export function signedUnit(r: number): number {
  return r * 2 - 1;
}

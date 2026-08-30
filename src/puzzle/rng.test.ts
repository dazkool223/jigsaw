import { describe, expect, it } from "vitest";
import { keyedRandom, mulberry32, signedUnit, subSeed } from "./rng";

function take(rand: () => number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rand());
  return out;
}

describe("mulberry32", () => {
  it("is deterministic: same seed gives byte-identical output", () => {
    const a = take(mulberry32(12345), 50);
    const b = take(mulberry32(12345), 50);
    expect(a).toEqual(b);
  });

  it("different seeds give different output", () => {
    const a = take(mulberry32(1), 20);
    const b = take(mulberry32(2), 20);
    expect(a).not.toEqual(b);
  });

  it("always returns floats in [0, 1)", () => {
    const values = take(mulberry32(999), 2000);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("does not repeat immediately (sanity: not a constant stream)", () => {
    const values = take(mulberry32(42), 10);
    const distinct = new Set(values);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("negative and non-integer seeds still produce valid, deterministic output", () => {
    const a = take(mulberry32(-7), 10);
    const b = take(mulberry32(-7), 10);
    expect(a).toEqual(b);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("subSeed", () => {
  it("is deterministic for a given base seed + key", () => {
    expect(subSeed(1, "vertex:3:4")).toBe(subSeed(1, "vertex:3:4"));
  });

  it("differs across keys for the same base seed", () => {
    expect(subSeed(1, "vertex:3:4")).not.toBe(subSeed(1, "vertex:3:5"));
    expect(subSeed(1, "vertex:3:4")).not.toBe(subSeed(1, "edge:h:3:4"));
  });

  it("differs across base seeds for the same key", () => {
    expect(subSeed(1, "k")).not.toBe(subSeed(2, "k"));
  });

  it("is order-independent: computing other sub-seeds first does not change a given key's sub-seed", () => {
    const direct = subSeed(7, "target");
    // Derive a bunch of unrelated sub-seeds first, in a different order.
    subSeed(7, "z");
    subSeed(7, "a");
    subSeed(7, "middle");
    const afterOthers = subSeed(7, "target");
    expect(afterOthers).toBe(direct);
  });
});

describe("keyedRandom", () => {
  it("gives the same sequence for the same base seed + key regardless of call order", () => {
    const seqA = take(keyedRandom(5, "edge:h:2:3"), 10);
    // Draw from an unrelated keyed stream in between.
    take(keyedRandom(5, "edge:v:0:0"), 10);
    const seqB = take(keyedRandom(5, "edge:h:2:3"), 10);
    expect(seqA).toEqual(seqB);
  });

  it("gives independent streams for different keys", () => {
    const a = take(keyedRandom(5, "a"), 10);
    const b = take(keyedRandom(5, "b"), 10);
    expect(a).not.toEqual(b);
  });
});

describe("signedUnit", () => {
  it("maps 0 -> -1, 0.5 -> 0, 1 -> 1", () => {
    expect(signedUnit(0)).toBe(-1);
    expect(signedUnit(0.5)).toBe(0);
    expect(signedUnit(1)).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { buildHomeHash, buildRoomHash, buildRoomUrl, parseHash } from "./routing";

describe("parseHash", () => {
  it("treats an empty hash as Home", () => {
    expect(parseHash("")).toEqual({ kind: "home" });
  });

  it("treats a bare '#' as Home", () => {
    expect(parseHash("#")).toEqual({ kind: "home" });
  });

  it("treats '#/' as Home", () => {
    expect(parseHash("#/")).toEqual({ kind: "home" });
  });

  it("parses a well-formed Room hash", () => {
    expect(parseHash("#/r/abc123XYZ_")).toEqual({ kind: "room", code: "abc123XYZ_" });
  });

  it("parses a Room hash with nanoid-style hyphens/underscores", () => {
    expect(parseHash("#/r/a1B2-c3D4_e")).toEqual({ kind: "room", code: "a1B2-c3D4_e" });
  });

  it("falls back to Home for an empty code", () => {
    expect(parseHash("#/r/")).toEqual({ kind: "home" });
  });

  it("falls back to Home for an unknown route segment", () => {
    expect(parseHash("#/x/whatever")).toEqual({ kind: "home" });
  });

  it("falls back to Home for junk", () => {
    expect(parseHash("not-a-hash-at-all")).toEqual({ kind: "home" });
    expect(parseHash("#random garbage !!! ")).toEqual({ kind: "home" });
  });

  it("falls back to Home when the code contains an embedded slash", () => {
    expect(parseHash("#/r/abc/def")).toEqual({ kind: "home" });
  });

  it("does not throw and falls back to Home on malformed percent-encoding", () => {
    expect(() => parseHash("#/r/%E0%A4%A")).not.toThrow();
    expect(parseHash("#/r/%E0%A4%A")).toEqual({ kind: "home" });
  });

  it("decodes a percent-encoded code", () => {
    expect(parseHash("#/r/abc%20def")).toEqual({ kind: "room", code: "abc def" });
  });

  it("falls back to Home for whitespace-only code", () => {
    expect(parseHash("#/r/%20%20")).toEqual({ kind: "home" });
  });
});

describe("buildRoomHash / buildHomeHash round-trip", () => {
  it("round-trips a plain room code", () => {
    const code = "a1B2c3D4e5";
    expect(parseHash(buildRoomHash(code))).toEqual({ kind: "room", code });
  });

  it("round-trips a code containing characters that need encoding", () => {
    const code = "weird code/with slash";
    const hash = buildRoomHash(code);
    // The built hash must not itself look like a multi-segment path.
    expect(hash.startsWith("#/r/")).toBe(true);
    expect(parseHash(hash)).toEqual({ kind: "room", code });
  });

  it("buildHomeHash parses back to Home", () => {
    expect(parseHash(buildHomeHash())).toEqual({ kind: "home" });
  });
});

describe("buildRoomUrl", () => {
  it("concatenates the given origin with the room hash", () => {
    expect(buildRoomUrl("abc123XYZ_", "https://example.com/")).toBe(
      "https://example.com/#/r/abc123XYZ_",
    );
  });
});

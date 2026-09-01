import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasRelay, resolveIceServers, resetIceServersForTest } from "./iceServers";

const STUN_URL = "stun:stun.l.google.com:19302";

function urlsOf(servers: readonly RTCIceServer[]): string[] {
  return servers.flatMap((s) => (typeof s.urls === "string" ? [s.urls] : [...s.urls]));
}

beforeEach(() => {
  resetIceServersForTest();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetIceServersForTest();
});

describe("hasRelay", () => {
  it("is false for STUN only - the configuration that caused the outage", () => {
    expect(hasRelay([{ urls: [STUN_URL] }])).toBe(false);
  });

  it("is true for turn: and turns:", () => {
    expect(hasRelay([{ urls: ["turn:relay.example:3478"] }])).toBe(true);
    expect(hasRelay([{ urls: "turns:relay.example:5349?transport=tcp" }])).toBe(true);
  });

  it("finds a relay mixed in among STUN servers", () => {
    expect(hasRelay([{ urls: [STUN_URL] }, { urls: ["turn:relay.example:3478"] }])).toBe(true);
  });
});

describe("resolveIceServers with nothing configured", () => {
  it("falls back to STUN only and says loudly that nobody behind a strict NAT will connect", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const servers = await resolveIceServers();

    expect(urlsOf(servers)).toEqual([STUN_URL]);
    expect(hasRelay(servers)).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/no turn server configured/i);
  });
});

describe("resolveIceServers with static credentials", () => {
  it("appends the TURN server to STUN and warns that the credentials are public", async () => {
    vi.stubEnv("VITE_TURN_URLS", "turn:relay.example:3478,turns:relay.example:5349");
    vi.stubEnv("VITE_TURN_USERNAME", "user");
    vi.stubEnv("VITE_TURN_CREDENTIAL", "secret");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const servers = await resolveIceServers();

    expect(urlsOf(servers)).toEqual([
      STUN_URL,
      "turn:relay.example:3478",
      "turns:relay.example:5349",
    ]);
    expect(hasRelay(servers)).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/static turn credentials/i);
  });

  it("ignores TURN urls with no credentials rather than building an unusable server", async () => {
    vi.stubEnv("VITE_TURN_URLS", "turn:relay.example:3478");

    const servers = await resolveIceServers();

    expect(hasRelay(servers)).toBe(false);
  });
});

describe("resolveIceServers with a credentials endpoint", () => {
  function stubFetch(body: unknown, ok = true): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    vi.stubEnv("VITE_TURN_CREDENTIALS_URL", "https://example.test/turn");
  });

  it("uses short-lived credentials from the endpoint", async () => {
    stubFetch({
      iceServers: [
        { urls: ["turn:relay.example:3478"], username: "ephemeral", credential: "hmac" },
      ],
      ttlSeconds: 3600,
    });

    const servers = await resolveIceServers();

    expect(hasRelay(servers)).toBe(true);
    expect(servers.at(-1)).toMatchObject({ username: "ephemeral", credential: "hmac" });
    expect(urlsOf(servers)[0]).toBe(STUN_URL); // STUN stays: it is cheaper when it works
  });

  it("accepts a single object as well as an array (providers differ)", async () => {
    stubFetch({
      iceServers: { urls: "turn:relay.example:3478", username: "u", credential: "c" },
    });

    expect(hasRelay(await resolveIceServers())).toBe(true);
  });

  it("caches, so a Room's connections do not each re-fetch", async () => {
    const fetchMock = stubFetch({
      iceServers: [{ urls: ["turn:relay.example:3478"], username: "u", credential: "c" }],
      ttlSeconds: 3600,
    });

    await resolveIceServers();
    await resolveIceServers();
    await resolveIceServers();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight request across concurrent callers", async () => {
    const fetchMock = stubFetch({
      iceServers: [{ urls: ["turn:relay.example:3478"], username: "u", credential: "c" }],
    });

    await Promise.all([resolveIceServers(), resolveIceServers(), resolveIceServers()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to STUN rather than blocking the Room when the endpoint errors", async () => {
    stubFetch({}, false);

    const servers = await resolveIceServers();

    expect(urlsOf(servers)).toEqual([STUN_URL]);
  });

  it("degrades to STUN when the endpoint returns nothing usable", async () => {
    stubFetch({ somethingElse: true });

    expect(hasRelay(await resolveIceServers())).toBe(false);
  });

  it("degrades to STUN when the request throws, and never rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(resolveIceServers()).resolves.toBeDefined();
    expect(hasRelay(await resolveIceServers())).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { CURSOR_COLORS, IdentityStore, type IdentityStorage } from "./identity";

/** In-memory stand-in for localStorage, shared across IdentityStore instances
 * the way real localStorage is shared across "reloads" of the same origin. */
class FakeStorage implements IdentityStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** Simulates a storage that is present but throws on every access (Safari
 * private-mode style, or a quota error). */
class ThrowingStorage implements IdentityStorage {
  getItem(): string | null {
    throw new Error("storage disabled");
  }
  setItem(): void {
    throw new Error("storage disabled");
  }
}

describe("identity", () => {
  it("gives a fresh device a name and a colour", () => {
    const store = new IdentityStore(new FakeStorage());
    const identity = store.getIdentity();

    expect(identity.id).toBeTruthy();
    expect(identity.name).toMatch(/^\S+ \S+$/); // "Adjective Animal"
    expect(CURSOR_COLORS).toContain(identity.color);
  });

  it("persists identity across reloads (new store instance, same backing storage)", () => {
    const backing = new FakeStorage();

    const first = new IdentityStore(backing).getIdentity();
    const second = new IdentityStore(backing).getIdentity();

    expect(second).toEqual(first);
  });

  it("persists a rename across reloads", () => {
    const backing = new FakeStorage();

    const store = new IdentityStore(backing);
    store.getIdentity();
    const renamed = store.rename("Custom Name");
    expect(renamed.name).toBe("Custom Name");

    const reloaded = new IdentityStore(backing).getIdentity();
    expect(reloaded.name).toBe("Custom Name");
    expect(reloaded.id).toBe(renamed.id);
  });

  it("ignores a blank rename", () => {
    const store = new IdentityStore(new FakeStorage());
    const before = store.getIdentity();
    const after = store.rename("   ");
    expect(after.name).toBe(before.name);
  });

  it("falls back to an in-memory identity when storage throws, instead of crashing", () => {
    const store = new IdentityStore(new ThrowingStorage());

    expect(() => store.getIdentity()).not.toThrow();
    const identity = store.getIdentity();
    expect(identity.name).toMatch(/^\S+ \S+$/);
    expect(CURSOR_COLORS).toContain(identity.color);

    // Rename should also not throw, and should be reflected for the life of
    // this in-memory instance even though nothing can actually be persisted.
    expect(() => store.rename("Still Works")).not.toThrow();
    expect(store.getIdentity().name).toBe("Still Works");
  });

  it("falls back gracefully when storage is null/unavailable entirely", () => {
    const store = new IdentityStore(null);
    expect(() => store.getIdentity()).not.toThrow();
    expect(store.getIdentity().id).toBe(store.getIdentity().id); // stable within instance
  });

  it("draws colours from a distinct palette", () => {
    const unique = new Set(CURSOR_COLORS);
    expect(unique.size).toBe(CURSOR_COLORS.length);
    expect(CURSOR_COLORS.length).toBeGreaterThanOrEqual(8);

    for (let i = 0; i < 25; i++) {
      const identity = new IdentityStore(new FakeStorage()).getIdentity();
      expect(CURSOR_COLORS).toContain(identity.color);
    }
  });
});

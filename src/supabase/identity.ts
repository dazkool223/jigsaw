/**
 * Per-device Player identity (see CONTEXT.md "Player", plan "Players").
 *
 * Auto-assigned adjective-animal name + a cursor colour from a distinct
 * palette on first use, persisted in localStorage (NOT sessionStorage —
 * identity should survive across days, not just a tab's lifetime) so it
 * carries across visits on the same device. Renaming is allowed and persists.
 *
 * Identity is COSMETIC ONLY (CONTEXT.md is explicit: "no state of consequence
 * is keyed to it") — nothing here needs to be secure or globally unique, only
 * stable per device and pleasant to look at.
 *
 * localStorage can be unavailable or throw (private/incognito mode, quota
 * exceeded, disabled by policy). Every access is guarded; on failure this
 * falls back to an in-memory identity for the life of the page rather than
 * crashing the app.
 */

import type { Player, PlayerId } from "../types";

const STORAGE_KEY = "jigsaw:identity";

// A visually distinct, colour-blind-conscious palette (based on Paul Tol's/
// Sasha Trubetskoy's distinct-colours work) — no two entries should read as
// "the same cursor colour" at a glance.
export const CURSOR_COLORS: readonly string[] = [
  "#e6194b", // red
  "#3cb44b", // green
  "#4363d8", // blue
  "#f58231", // orange
  "#911eb4", // purple
  "#42d4f4", // cyan
  "#f032e6", // magenta
  "#bfef45", // lime
  "#fabed4", // pink
  "#469990", // teal
  "#dcbeff", // lavender
  "#9a6324", // brown
  "#800000", // maroon
  "#808000", // olive
  "#000075", // navy
];

const ADJECTIVES: readonly string[] = [
  "Amber",
  "Brave",
  "Chatty",
  "Dizzy",
  "Eager",
  "Fuzzy",
  "Gentle",
  "Happy",
  "Icy",
  "Jolly",
  "Keen",
  "Lucky",
  "Mellow",
  "Nimble",
  "Orbiting",
  "Plucky",
  "Quiet",
  "Rowdy",
  "Sunny",
  "Tidy",
  "Upbeat",
  "Vivid",
  "Wobbly",
  "Zesty",
];

const ANIMALS: readonly string[] = [
  "Otter",
  "Panda",
  "Falcon",
  "Badger",
  "Heron",
  "Lynx",
  "Puffin",
  "Marmot",
  "Weasel",
  "Gecko",
  "Wombat",
  "Toucan",
  "Beaver",
  "Ferret",
  "Ibis",
  "Newt",
  "Ocelot",
  "Quokka",
  "Raven",
  "Seal",
  "Tapir",
  "Urchin",
  "Vole",
  "Yak",
];

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

/** A fresh adjective-animal name, e.g. "Sunny Otter". Exported for testing/reuse. */
export function generateName(): string {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

/** A colour drawn from CURSOR_COLORS. Exported for testing/reuse. */
export function generateColor(): string {
  return pick(CURSOR_COLORS);
}

function generatePlayerId(): PlayerId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older browsers).
  return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function generateIdentity(): Player {
  return { id: generatePlayerId(), name: generateName(), color: generateColor() };
}

function isPlayer(value: unknown): value is Player {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.color === "string";
}

/** The minimal storage shape this module needs — real localStorage satisfies it. */
export type IdentityStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Probes whether `storage` is actually usable (present AND not throwing —
 * Safari private mode historically exposed localStorage but threw on any
 * write, and some environments throw just on access).
 */
function probeStorage(storage: IdentityStorage | undefined | null): IdentityStorage | null {
  if (!storage) return null;
  try {
    const probeKey = "__jigsaw_identity_probe__";
    storage.setItem(probeKey, "1");
    storage.getItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

function defaultLocalStorage(): IdentityStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some environments throw just accessing the global (e.g. certain
    // sandboxed iframes / privacy modes).
    return null;
  }
}

/**
 * Manages one device's Player identity. A default instance backed by
 * `localStorage` is exported below for app code; the class itself takes an
 * injectable storage so tests can supply a stub (including one that throws).
 */
export class IdentityStore {
  private storage: IdentityStorage | null;
  private cached: Player | null = null;
  /** Module-level-ish fallback so an in-memory identity is stable for this instance's life. */
  private memoryIdentity: Player | null = null;

  constructor(storage?: IdentityStorage | null) {
    this.storage = probeStorage(storage === undefined ? defaultLocalStorage() : storage);
  }

  /** Returns this device's identity, generating and persisting one on first call. */
  getIdentity(): Player {
    if (this.cached) return this.cached;

    if (this.storage) {
      const loaded = this.tryLoad();
      if (loaded) {
        this.cached = loaded;
        return loaded;
      }
      const fresh = generateIdentity();
      this.persist(fresh);
      this.cached = fresh;
      return fresh;
    }

    if (!this.memoryIdentity) {
      this.memoryIdentity = generateIdentity();
    }
    this.cached = this.memoryIdentity;
    return this.memoryIdentity;
  }

  /** Renames the current identity (trimmed; a blank name is ignored) and persists it. */
  rename(name: string): Player {
    const trimmed = name.trim();
    const current = this.getIdentity();
    if (trimmed === "" || trimmed === current.name) return current;

    const next: Player = { ...current, name: trimmed };
    this.cached = next;
    if (this.storage) {
      this.persist(next);
    } else {
      this.memoryIdentity = next;
    }
    return next;
  }

  private tryLoad(): Player | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isPlayer(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private persist(identity: Player): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(identity));
    } catch {
      // Storage became unusable (quota, private-mode write throw, etc).
      // Fall back to in-memory for the rest of this instance's life.
      this.storage = null;
      this.memoryIdentity = identity;
    }
  }
}

let defaultStore: IdentityStore | null = null;
function getDefaultStore(): IdentityStore {
  if (!defaultStore) defaultStore = new IdentityStore();
  return defaultStore;
}

/** This device's Player identity, generating one on first call. */
export function getIdentity(): Player {
  return getDefaultStore().getIdentity();
}

/** Renames this device's Player identity. */
export function renameIdentity(name: string): Player {
  return getDefaultStore().rename(name);
}

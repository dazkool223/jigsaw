/**
 * The Snapshot save scheduler (see CONTEXT.md "Snapshot", plan "Persistence").
 *
 * Gameplay performance is the top priority: serialisation must stay OFF the
 * drag path. `markDirty()` is the cheap call the game loop makes on every
 * move - it just sets a flag and (re)arms a debounce timer. The actual
 * serialise-and-write work happens only inside the debounced flush, never on
 * every move.
 *
 * Also flushes immediately on `visibilitychange` -> hidden (Chrome throttles
 * background-tab timers, so this is the only reliable save before an
 * alt-tab/close - see plan "Backgrounded Host") and must be called
 * explicitly on Completion.
 *
 * Every write carries the current Host Epoch (ADR-0001). When a write comes
 * back epoch-rejected, `onDeposed` fires so the app can tear down hosting and
 * offer Rejoin - this module never decides what demotion looks like, only
 * detects it.
 */

import { SNAPSHOT_DEBOUNCE_MS } from "../config";
import { saveSnapshot, type SaveSnapshotResult } from "./rooms";

/** What to serialise into the Snapshot at flush time. Called lazily - never eagerly. */
export type SnapshotSource = () => { snapshot: unknown; completed: boolean };

/** Matches saveSnapshot's signature; overridable in tests so no network is touched. */
export type SaveSnapshotFn = (
  code: string,
  epoch: number,
  snapshot: unknown,
  completed: boolean,
) => Promise<SaveSnapshotResult>;

export type SnapshotSchedulerOptions = {
  code: string;
  /** Read lazily at flush time - always the Host's current epoch, never captured stale. */
  getEpoch: () => number;
  getSnapshotData: SnapshotSource;
  /** Fired when a write is epoch-rejected: a newer Host has claimed the Room. */
  onDeposed: () => void;
  debounceMs?: number;
  /** Injectable for tests; defaults to the real RPC wrapper. */
  save?: SaveSnapshotFn;
  /** Injectable for tests; defaults to the global `document`. */
  documentRef?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
};

export class SnapshotScheduler {
  private readonly code: string;
  private readonly getEpoch: () => number;
  private readonly getSnapshotData: SnapshotSource;
  private readonly onDeposed: () => void;
  private readonly debounceMs: number;
  private readonly save: SaveSnapshotFn;
  private readonly documentRef: SnapshotSchedulerOptions["documentRef"];

  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private pendingRetry = false;

  constructor(options: SnapshotSchedulerOptions) {
    this.code = options.code;
    this.getEpoch = options.getEpoch;
    this.getSnapshotData = options.getSnapshotData;
    this.onDeposed = options.onDeposed;
    this.debounceMs = options.debounceMs ?? SNAPSHOT_DEBOUNCE_MS;
    this.save = options.save ?? saveSnapshot;
    this.documentRef = options.documentRef ?? (typeof document !== "undefined" ? document : undefined);

    this.documentRef?.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  /**
   * Cheap: call on every move. Never serialises - only marks state dirty and
   * arms the debounce timer if one isn't already running.
   */
  markDirty(): void {
    this.dirty = true;
    this.armTimer();
  }

  /** Call on Completion (in addition to any markDirty already called) to save right away. */
  async flushOnCompletion(): Promise<void> {
    this.dirty = true;
    await this.flushNow();
  }

  /** Serialises and writes immediately if there's anything dirty. Safe to call freely. */
  async flushNow(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty || this.flushing) return;

    this.flushing = true;
    this.dirty = false;
    this.pendingRetry = false;
    try {
      const { snapshot, completed } = this.getSnapshotData();
      const epoch = this.getEpoch();
      const result = await this.save(this.code, epoch, snapshot, completed);

      if (result.outcome === "deposed") {
        this.onDeposed();
      } else if (result.outcome === "error") {
        // Transient (network, etc). Leave the door open for the next
        // markDirty or an explicit flush to retry rather than losing the write.
        this.pendingRetry = true;
      }
    } finally {
      this.flushing = false;
      if (this.pendingRetry) {
        this.dirty = true;
        this.pendingRetry = false;
      }
    }
  }

  /** Removes the visibilitychange listener and cancels any pending timer. Call on teardown. */
  destroy(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.documentRef?.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private armTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushNow();
    }, this.debounceMs);
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.documentRef?.visibilityState === "hidden") {
      void this.flushNow();
    }
  };
}

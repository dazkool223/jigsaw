/**
 * Screen orchestration (plan "Project structure": "main.tsx, app.tsx - Home vs
 * Room screens"). Two responsibilities live here:
 *
 *  1. Hash routing between Home and a Room (see ui/routing.ts).
 *  2. For a Room, the session lifecycle state machine (ADR-0001, CONTEXT.md
 *     "Session lifecycle"): load the Room row, detect a geometry_version
 *     mismatch, check whether a Host is currently online, connect as a
 *     Guest or offer an explicit "Resume puzzle" claim, and react to being
 *     deposed.
 *
 * `RoomState` below is the explicit state machine the brief asks for - every
 * screen the user can be looking at while viewing a Room is one named
 * variant, never an implicit combination of booleans. `RoomSessionController`
 * is the imperative engine behind it: it owns the live Transport / Host /
 * Client / SnapshotScheduler objects (none of which are React state - they
 * have their own lifecycles) and calls `setState` whenever the *visible*
 * state changes.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Player, PlayerController, PlayerId, Puzzle } from "./types";
import { getIdentity, renameIdentity } from "./supabase/identity";
import { supabase } from "./supabase/client";
import { getRoom, claimHost as claimHostRpc, type RoomRow } from "./supabase/rooms";
import { SnapshotScheduler } from "./supabase/snapshot";
import { getPublicImageUrl } from "./supabase/storageUpload";
import { buildPuzzle } from "./puzzle/geometry";
import { scatterOffsets } from "./puzzle/layout";
import { isComplete, serialize } from "./game/state";
import { Host } from "./game/host";
import { Client } from "./game/client";
import { HostNet } from "./net/hostNet";
import { GuestNet } from "./net/guestNet";
import { primeIceServers } from "./net/iceServers";
import { mountBoard } from "./render/board";

import { HomeScreen } from "./ui/HomeScreen";
import { BoardMount } from "./ui/BoardMount";
import { BoxArt } from "./ui/BoxArt";
import { PlayerList } from "./ui/PlayerList";
import { ShareLink } from "./ui/ShareLink";
import { ConnectionOverlay } from "./ui/ConnectionOverlay";
import { ResumeHostScreen } from "./ui/ResumeHostScreen";
import { DeposedOverlay } from "./ui/DeposedOverlay";
import { WinDialog } from "./ui/WinDialog";
import {
  buildRoomUrl,
  getCurrentRoute,
  navigateHome,
  navigateToRoom,
  onRouteChange,
  type Route,
} from "./ui/routing";

// ─────────────────────────────────────────────────────────────────────────────
// Image URL helper
// ─────────────────────────────────────────────────────────────────────────────

function loadImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Couldn't load the puzzle image."));
    img.src = url;
  });
}

/** scatterOffsets() returns one Point per Piece in row-major id order - see layout.ts. */
function toScatterRecord(points: readonly { x: number; y: number }[]): Record<number, { x: number; y: number }> {
  const rec: Record<number, { x: number; y: number }> = {};
  points.forEach((p, i) => {
    rec[i] = p;
  });
  return rec;
}

// NOTE: TransportStatus (types.ts) bundles "failed" and "roomFull" into one
// union member sharing `message`, so switching on a *mapped* TransportStatus
// doesn't narrow per-literal (both arms collapse to `state: "failed" |
// "roomFull"`). ConnectionOverlay therefore declares its own precise
// per-state prop types instead of deriving them via `Extract<TransportStatus, ...>`,
// and the switch below stays on the raw `ConnectionStatus` (a proper 3-way
// discriminated union) so `status.message` narrows correctly per case.

// ─────────────────────────────────────────────────────────────────────────────
// Room session state machine
// ─────────────────────────────────────────────────────────────────────────────

type PuzzleSession = {
  readonly puzzle: Puzzle;
  readonly imageUrl: string;
  readonly room: RoomRow;
};

/**
 * Every screen a Room can show. Named states, not booleans - see module
 * doc comment. `session` (the loaded Room row + regenerated Puzzle
 * geometry) is threaded through from "checking-presence" onward since every
 * later screen either needs it directly or needs to keep it alive across a
 * retry.
 */
type RoomState =
  | { readonly kind: "loading" }
  | { readonly kind: "not-found" }
  | { readonly kind: "geometry-mismatch" }
  | { readonly kind: "load-error"; readonly message: string }
  | { readonly kind: "checking-presence"; readonly session: PuzzleSession }
  | { readonly kind: "connecting"; readonly session: PuzzleSession }
  | {
      readonly kind: "connect-failed";
      readonly session: PuzzleSession;
      readonly status: {
        readonly state: "failed";
        readonly message: string;
        readonly hint?: string;
      };
    }
  | {
      readonly kind: "room-full";
      readonly session: PuzzleSession;
      readonly status: { readonly state: "roomFull"; readonly message: string };
    }
  | {
      readonly kind: "resume-available";
      readonly session: PuzzleSession;
      readonly claiming: boolean;
      readonly claimError?: string;
    }
  | {
      readonly kind: "playing";
      readonly session: PuzzleSession;
      readonly role: "host" | "guest";
      readonly players: readonly Player[];
      readonly completed: boolean;
      readonly startedAt: number;
      readonly completedAt?: number;
    }
  | { readonly kind: "deposed"; readonly session: PuzzleSession };

/**
 * How long to wait for a Realtime presence signal before assuming no Host is
 * online and offering ResumeHostScreen. Presence sync normally arrives
 * within a second of subscribing; this is a generous fallback so a slow
 * network degrades to "show the resume screen" rather than hanging forever.
 * Not a config.ts constant - it's a UI-only judgement call, not part of
 * puzzle/session identity.
 */
const PRESENCE_WAIT_MS = 4000;

/** How often the Host's own chrome (PlayerList, Completion, Snapshot dirty-check) polls Host - see report: Host has no onChange. */
const HOST_POLL_MS = 1000;

/**
 * The imperative engine behind RoomState. Owns everything with its own
 * lifecycle (Transport, Host, Client, SnapshotScheduler, timers) and pushes
 * a new RoomState whenever what the user should see changes. One instance
 * per mounted Room; disposed on unmount/navigation.
 */
class RoomSessionController {
  private cancelled = false;
  private session: PuzzleSession | undefined;

  private guestNet: GuestNet | undefined;
  private client: Client | undefined;
  private guestUnsubs: Array<() => void> = [];
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;

  private hostNet: HostNet | undefined;
  private host: Host | undefined;
  private scheduler: SnapshotScheduler | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastHostState: ReturnType<Host["getState"]> | undefined;

  private role: "host" | "guest" | undefined;
  private epoch: number | undefined;
  private startedAt: number | undefined;
  private completedAt: number | undefined;

  constructor(
    private readonly code: string,
    private readonly setState: (state: RoomState) => void,
  ) {}

  start(): void {
    // Fetch TURN credentials alongside the Room load rather than on the
    // connect path, where the round trip would sit between the player
    // pressing Join and anything happening.
    primeIceServers();
    void this.loadRoom();
  }

  /** For BoardMount's onMount (see handleBoardMount below) - read fresh at mount time, not captured in a stale render closure. */
  getSession(): PuzzleSession | undefined {
    return this.session;
  }

  /** The active Host or Client, whichever this browser currently is. Undefined outside "playing". */
  getController(): PlayerController | undefined {
    if (this.role === "guest") return this.client;
    if (this.role === "host") return this.host;
    return undefined;
  }

  dispose(): void {
    this.cancelled = true;
    // Leaving the Room (navigating home to start another puzzle, or plain
    // unmount) would otherwise drop up to SNAPSHOT_DEBOUNCE_MS of moves on
    // the floor: teardownHost only cancels the pending timer. Fire the write
    // first - it serialises synchronously, so the request is already on the
    // wire before the scheduler goes away. Deliberately not in teardownHost
    // itself, which also runs on the deposed path where our epoch is stale
    // and the write is guaranteed to be rejected.
    void this.scheduler?.flushNow();
    this.teardownGuest();
    this.teardownHost();
  }

  /** ConnectionOverlay Retry, and the fallback path when claimHost() loses a race. */
  retryGuestConnect(): void {
    this.beginGuestFlow();
  }

  /** ResumeHostScreen's explicit "Resume puzzle" button. Never called automatically. */
  resumeAsHost(): void {
    if (!this.session || this.cancelled) return;
    const session = this.session;
    this.setState({ kind: "resume-available", session, claiming: true });
    void (async () => {
      const result = await claimHostRpc(this.code, session.room.host_epoch);
      if (this.cancelled || !this.session) return;
      if (result.outcome === "error") {
        this.setState({ kind: "resume-available", session: this.session, claiming: false, claimError: result.error });
        return;
      }
      if (result.outcome === "lost") {
        // Someone else's claim won the race - a Host now exists; join them.
        this.beginGuestFlow();
        return;
      }
      this.startHosting(result.epoch);
    })();
  }

  /** DeposedOverlay's single Rejoin button - joins the new Host, or lands back on Resume if they've also left. */
  rejoin(): void {
    this.beginGuestFlow();
  }

  /** "Try again" on the load-error screen. */
  retryLoad(): void {
    void this.loadRoom();
  }

  // ── Room load ──────────────────────────────────────────────────────────

  private async loadRoom(): Promise<void> {
    this.setState({ kind: "loading" });
    const result = await getRoom(this.code);
    if (this.cancelled) return;

    if (result.outcome === "not_found") {
      this.setState({ kind: "not-found" });
      return;
    }
    if (result.outcome === "geometry_mismatch") {
      this.setState({ kind: "geometry-mismatch" });
      return;
    }
    if (result.outcome === "error") {
      this.setState({ kind: "load-error", message: result.error });
      return;
    }

    const room = result.room;
    if (!room.image_path) {
      this.setState({ kind: "load-error", message: "This room has no image." });
      return;
    }

    const imageUrl = getPublicImageUrl(room.image_path);
    let dims: { width: number; height: number };
    try {
      dims = await loadImageDimensions(imageUrl);
    } catch (err) {
      this.setState({
        kind: "load-error",
        message: err instanceof Error ? err.message : "Couldn't load the puzzle image.",
      });
      return;
    }
    if (this.cancelled) return;

    const puzzle = buildPuzzle(
      { imageUrl, seed: room.seed, rows: room.rows, cols: room.cols },
      dims.width,
      dims.height,
    );
    this.session = { puzzle, imageUrl, room };
    this.setState({ kind: "checking-presence", session: this.session });
    this.beginGuestFlow();
  }

  // ── Guest connect flow ────────────────────────────────────────────────

  private beginGuestFlow(): void {
    if (!this.session || this.cancelled) return;
    this.teardownGuest();
    this.teardownHost();
    const session = this.session;
    this.setState({ kind: "checking-presence", session });

    const identity = getIdentity();
    const guestNet = new GuestNet({ client: supabase, roomCode: this.code, selfId: identity.id });
    this.guestNet = guestNet;
    this.role = "guest";

    let settled = false;
    const decide = (online: boolean): void => {
      if (settled || this.cancelled || this.guestNet !== guestNet) return;
      settled = true;
      if (this.presenceTimer !== undefined) {
        clearTimeout(this.presenceTimer);
        this.presenceTimer = undefined;
      }
      if (online) {
        this.attachGuestStatusHandling(guestNet, identity.id);
        guestNet.connect();
      } else {
        guestNet.close();
        if (this.guestNet === guestNet) this.guestNet = undefined;
        if (this.session) this.setState({ kind: "resume-available", session: this.session, claiming: false });
      }
    };

    this.guestUnsubs.push(guestNet.onHostPresenceChange(decide));
    this.presenceTimer = setTimeout(() => decide(false), PRESENCE_WAIT_MS);
  }

  private attachGuestStatusHandling(guestNet: GuestNet, selfId: PlayerId): void {
    const unsub = guestNet.onConnectionStatus((status) => {
      if (this.cancelled || this.guestNet !== guestNet || !this.session) return;
      const session = this.session;
      switch (status.state) {
        case "new":
          break;
        case "connecting":
          this.setState({ kind: "connecting", session });
          break;
        case "failed":
          this.setState({
            kind: "connect-failed",
            session,
            // message AND hint come from the transport: it is the only layer
            // that knows which failure this was (see net/peer.ts).
            status: { state: "failed", message: status.message, hint: status.hint },
          });
          break;
        case "room_full":
          this.setState({ kind: "room-full", session, status: { state: "roomFull", message: status.message } });
          break;
        case "connected": {
          const identity = getIdentity();
          const client = new Client({
            transport: guestNet,
            playerId: selfId,
            name: identity.name,
            color: identity.color,
          });
          this.client = client;
          this.startedAt = this.startedAt ?? Date.now();
          this.completedAt = undefined;
          this.guestUnsubs.push(client.onChange(() => this.pushPlayingUpdate()));
          this.pushPlayingUpdate();
          break;
        }
        case "closed":
          this.client?.close();
          this.client = undefined;
          this.setState({ kind: "resume-available", session, claiming: false });
          break;
      }
    });
    this.guestUnsubs.push(unsub);
  }

  private teardownGuest(): void {
    for (const unsub of this.guestUnsubs) unsub();
    this.guestUnsubs = [];
    if (this.presenceTimer !== undefined) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = undefined;
    }
    this.client?.close();
    this.client = undefined;
    this.guestNet?.close();
    this.guestNet = undefined;
    if (this.role === "guest") this.role = undefined;
  }

  // ── Hosting ────────────────────────────────────────────────────────────

  private startHosting(epoch: number): void {
    if (!this.session || this.cancelled) return;
    this.teardownGuest();
    this.teardownHost();
    const session = this.session;

    const identity = getIdentity();
    const hostNet = new HostNet({ client: supabase, roomCode: this.code, selfId: identity.id });
    const scatter = toScatterRecord(scatterOffsets(session.puzzle.grid, session.room.seed));
    const host = new Host({
      transport: hostNet,
      puzzle: session.puzzle,
      scatterOffsets: scatter,
      hostPlayerId: identity.id,
      hostPlayer: identity,
      hostEpoch: epoch,
    });

    this.hostNet = hostNet;
    this.host = host;
    this.role = "host";
    this.epoch = epoch;
    this.startedAt = this.startedAt ?? Date.now();
    this.completedAt = undefined;
    this.lastHostState = undefined;

    this.scheduler = new SnapshotScheduler({
      code: this.code,
      getEpoch: () => this.epoch ?? epoch,
      getSnapshotData: () => ({
        snapshot: serialize(host.getState()),
        completed: isComplete(host.getState()),
      }),
      onDeposed: () => this.handleDeposed(),
    });

    this.pollTimer = setInterval(() => this.pushPlayingUpdate(), HOST_POLL_MS);
    this.pushPlayingUpdate();
  }

  private handleDeposed(): void {
    if (!this.session || this.cancelled) return;
    const session = this.session;
    this.teardownHost();
    this.setState({ kind: "deposed", session });
  }

  private teardownHost(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.scheduler?.destroy();
    this.scheduler = undefined;
    this.host?.close();
    this.host = undefined;
    this.hostNet?.close();
    this.hostNet = undefined;
    if (this.role === "host") this.role = undefined;
  }

  // ── Shared "playing" projection ──────────────────────────────────────

  private pushPlayingUpdate(): void {
    if (!this.session || this.cancelled) return;
    const session = this.session;

    if (this.role === "guest" && this.client) {
      const completed = this.client.isComplete();
      if (completed && this.completedAt === undefined) this.completedAt = Date.now();
      this.setState({
        kind: "playing",
        session,
        role: "guest",
        players: this.client.getPlayers(),
        completed,
        startedAt: this.startedAt ?? Date.now(),
        completedAt: this.completedAt,
      });
      return;
    }

    if (this.role === "host" && this.host) {
      const gameState = this.host.getState();
      if (gameState !== this.lastHostState) {
        this.lastHostState = gameState;
        this.scheduler?.markDirty();
      }
      const completed = isComplete(gameState);
      const justCompleted = completed && this.completedAt === undefined;
      if (justCompleted) {
        this.completedAt = Date.now();
        void this.scheduler?.flushOnCompletion();
      }
      this.setState({
        kind: "playing",
        session,
        role: "host",
        players: this.host.getPlayers(),
        completed,
        startedAt: this.startedAt ?? Date.now(),
        completedAt: this.completedAt,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function assertNever(x: never): never {
  throw new Error(`RoomSessionController: unhandled RoomState ${JSON.stringify(x)}`);
}

function RoomScreenController({ code }: { code: string }) {
  const [state, setState] = useState<RoomState>({ kind: "loading" });
  const controllerRef = useRef<RoomSessionController | null>(null);
  const [selfNameOverride, setSelfNameOverride] = useState<string | null>(null);

  useEffect(() => {
    setSelfNameOverride(null);
    const controller = new RoomSessionController(code, setState);
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [code]);

  const handleBoardMount = useCallback((el: HTMLDivElement) => {
    // Read the live controller/session off the ref rather than the `state`
    // in scope: this callback has a stable identity (empty deps, so
    // BoardMount mounts it once per "playing" entry - see BoardMount's doc
    // comment), so a `state` closed over here would be whatever it was on
    // the render that created the callback, not the "playing" one that
    // actually triggers the mount.
    const controller = controllerRef.current;
    const session = controller?.getSession();
    const playerController = controller?.getController();
    if (!session || !playerController) return;
    return mountBoard({
      container: el,
      puzzle: session.puzzle,
      imageUrl: session.imageUrl,
      controller: playerController,
    });
  }, []);

  switch (state.kind) {
    case "loading":
      return <CenteredMessage title="Getting the box out" spinner />;

    case "not-found":
      return (
        <CenteredMessage
          title="No puzzle at this link"
          body="This link doesn't point to a puzzle that exists. It may have been mistyped, or the puzzle was never created."
        >
          <HomeButton />
        </CenteredMessage>
      );

    case "geometry-mismatch":
      return (
        <CenteredMessage
          title="This puzzle was cut by an older version"
          body="The piece shapes have changed since this room was made, so the saved board can't be put back together safely. Start a fresh puzzle from the same photo to keep playing."
        >
          <HomeButton />
        </CenteredMessage>
      );

    case "load-error":
      return (
        <CenteredMessage title="Couldn't open this puzzle" body={state.message}>
          <button type="button" className="btn" onClick={() => controllerRef.current?.retryLoad()}>
            Try again
          </button>
          <HomeButton />
        </CenteredMessage>
      );

    case "checking-presence":
      return <CenteredMessage title="Looking for a host" spinner />;

    case "connecting":
      return (
        <ConnectionOverlay
          status={{ state: "connecting" }}
          onRetry={() => controllerRef.current?.retryGuestConnect()}
          onBackToHome={navigateHome}
        />
      );

    case "connect-failed":
      return (
        <ConnectionOverlay
          status={state.status}
          onRetry={() => controllerRef.current?.retryGuestConnect()}
          onBackToHome={navigateHome}
        />
      );

    case "room-full":
      return (
        <ConnectionOverlay
          status={state.status}
          onRetry={() => controllerRef.current?.retryGuestConnect()}
          onBackToHome={navigateHome}
        />
      );

    case "resume-available":
      return (
        <ResumeHostScreen
          claiming={state.claiming}
          error={state.claimError}
          onResume={() => controllerRef.current?.resumeAsHost()}
        />
      );

    case "deposed":
      return <DeposedOverlay onRejoin={() => controllerRef.current?.rejoin()} />;

    case "playing": {
      const identity = getIdentity();
      const players = state.players.map((p) =>
        p.id === identity.id && selfNameOverride ? { ...p, name: selfNameOverride } : p,
      );
      const roomUrl = buildRoomUrl(code);
      return (
        <div className="board-root">
          <BoardMount onMount={handleBoardMount} />
          <div className="chrome chrome--left">
            <ShareLink url={roomUrl} />
            {/* Progress is saved on the way out (see dispose), and this Room
                keeps its link - so this is "start another one", not "quit". */}
            <button type="button" className="tag tag--btn" onClick={navigateHome}>
              Start a new puzzle
            </button>
            {/* The lid propped up beside the table - the finished picture to
                check pieces against. */}
            <BoxArt puzzle={state.session.puzzle} imageUrl={state.session.imageUrl} />
          </div>
          <div className="chrome chrome--right">
            <PlayerList
              players={players}
              selfId={identity.id}
              onRename={(name) => {
                renameIdentity(name);
                setSelfNameOverride(name);
              }}
            />
          </div>
          {state.completed && (
            <WinDialog
              pieceCount={state.session.puzzle.pieces.length}
              elapsedMs={(state.completedAt ?? Date.now()) - state.startedAt}
              shareUrl={roomUrl}
            />
          )}
        </div>
      );
    }

    default:
      return assertNever(state);
  }
}


function CenteredMessage({
  title,
  body,
  spinner,
  children,
}: {
  title: string;
  body?: string;
  spinner?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="page">
      <div className="card">
        <div className="card__body">
          {spinner && <div className="card__spinner" aria-hidden="true" />}
          <h2 className="card__title">{title}</h2>
          {body && <p className="card__text">{body}</p>}
        </div>
        {children && (
          <div className="card__tray">
            <div className="card__actions">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function HomeButton() {
  return (
    <button type="button" className="btn btn--ghost" onClick={navigateHome}>
      Back to home
    </button>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => getCurrentRoute());

  useEffect(() => onRouteChange(setRoute), []);

  return route.kind === "home" ? (
    <HomeScreen onRoomCreated={(code) => navigateToRoom(code)} />
  ) : (
    <RoomScreenController key={route.code} code={route.code} />
  );
}

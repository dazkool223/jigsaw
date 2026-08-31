/**
 * A thin, protocol-agnostic wrapper around one `RTCPeerConnection` and its
 * two data channels (`control`: reliable/ordered, `stream`: unreliable/
 * unordered). This file knows nothing about `protocol.ts` - it moves bytes
 * (JSON-encoded) in and out and manages connection lifecycle.
 *
 * WebRTC lifecycle is the highest-risk part of this project (see the plan's
 * "Risks" section): callback ordering across `RTCPeerConnection` is not
 * something to infer implicitly. So `Peer` exposes a TINY EXPLICIT STATE
 * MACHINE instead:
 *
 *   new -> connecting -> connected -> failed
 *                   \-> failed        \-> closed
 *                    \-> closed
 *
 * Every transition is logged. `failed` carries a `PeerFailureReason` and
 * matching user-facing copy, so the UI can say which of several very
 * different problems actually happened.
 *
 * The Guest is ALWAYS the offerer (role: "offerer") and the Host ALWAYS
 * answers (role: "answerer") - this sidesteps negotiation glare entirely,
 * so there is no glare-handling logic here by design.
 *
 * TWO THINGS HERE EXIST BECAUSE OF A REAL OUTAGE
 * (docs/rca/0001-guests-cannot-connect-across-networks.md):
 *
 *  1. Remote ICE candidates are BUFFERED until the remote description is
 *     applied. `addIceCandidate()` rejects with InvalidStateError while
 *     `remoteDescription` is null, and trickled candidates routinely beat the
 *     SDP they belong to through signaling. Dropping them costs nothing on
 *     localhost, where any surviving loopback pair connects, and costs the
 *     whole connection across NAT, where the reflexive candidate may be the
 *     only usable one.
 *
 *  2. Failures are DIAGNOSED, not guessed. Every failure used to report the
 *     same "this can happen on some mobile networks" sentence, whether ICE
 *     failed, the Host never answered, or the data channel died - which sent
 *     real users off switching networks for a problem that was not theirs.
 *
 * The `RTCPeerConnection` constructor is injectable via `createPeerConnection`
 * so this class can be driven by a fake in tests, without a real browser.
 */

import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, STUN_SERVERS } from "../config";
import type { Channel } from "../types";

export type PeerRole = "offerer" | "answerer";

export type PeerState = "new" | "connecting" | "connected" | "failed" | "closed";

/**
 * Why a `Peer` reached `failed`. These are genuinely different problems with
 * genuinely different fixes, and telling them apart is most of the value:
 * only `ice-failed` is ever the player's network.
 */
export type PeerFailureReason =
  | "no-answer" // the Host never sent an SDP answer - nobody is hosting
  | "no-candidates" // ICE gathering produced nothing - UDP blocked, or STUN unreachable
  | "ice-failed" // candidates gathered, but no pair worked - needs a relay
  | "channel-error" // negotiated fine, then the control channel errored
  | "timeout"; // ran out of time somewhere the states above don't pin down

export interface PeerFailure {
  readonly reason: PeerFailureReason;
  /** What happened, in a sentence a player can read. */
  readonly message: string;
  /** What they can do about it. Empty when there is nothing useful to suggest. */
  readonly hint: string;
}

/**
 * `hint` is deliberately honest about which failures the player can do
 * anything about. Telling someone to switch networks when the Host has closed
 * their laptop wastes their time; that is exactly what happened in the outage
 * this file's diagnostics were written for.
 */
const FAILURE_COPY: Record<PeerFailureReason, Omit<PeerFailure, "reason">> = {
  "no-answer": {
    message: "The host didn't answer.",
    hint: "They may have closed the puzzle or gone offline. Try again in a moment, or take over hosting yourself.",
  },
  "no-candidates": {
    message: "This device couldn't find a way out to the network.",
    hint: "A VPN or a strict firewall is usually the cause. Turning off the VPN, or trying another network, should clear it.",
  },
  "ice-failed": {
    message: "Couldn't find a route to the host.",
    hint: "This happens when both sides are behind strict NATs and no relay server is available.",
  },
  "channel-error": {
    message: "The connection to the host dropped.",
    hint: "Try again - this is usually temporary.",
  },
  timeout: {
    message: "Couldn't connect to the host in time.",
    hint: "Try again, or ask the host to reload their puzzle.",
  },
};

/**
 * Copy for `ice-failed` when the app knows no TURN server is configured. The
 * generic version above tells the player to change networks, which cannot help
 * here: a Host behind a symmetric NAT is unreachable from EVERY network until
 * a relay exists. See net/iceServers.ts.
 */
const NO_RELAY_HINT =
  "No relay server is configured for this deployment, so strict networks can't be worked around. This is a setup problem, not your connection.";

export function describeFailure(reason: PeerFailureReason, relayAvailable: boolean): PeerFailure {
  const copy = FAILURE_COPY[reason];
  if (reason === "ice-failed" && !relayAvailable) {
    return { reason, message: copy.message, hint: NO_RELAY_HINT };
  }
  return { reason, ...copy };
}

/** The subset of `RTCDataChannel` this module needs. Real channels satisfy it. */
export interface DataChannelLike {
  readonly label: string;
  readyState: RTCDataChannelState;
  send(data: string): void;
  close(): void;
  onopen: ((this: DataChannelLike, ev: Event) => void) | null;
  onclose: ((this: DataChannelLike, ev: Event) => void) | null;
  onerror: ((this: DataChannelLike, ev: Event) => void) | null;
  onmessage: ((this: DataChannelLike, ev: MessageEvent) => void) | null;
}

/**
 * The subset of `RTCPeerConnection` this module needs. Real connections
 * satisfy it.
 *
 * The `ice*` members are optional so test fakes need not implement them, but
 * NOTE that `addIceCandidate` must behave like the real thing and reject when
 * no remote description has been set - a fake that accepts candidates
 * unconditionally cannot see the bug this module now guards against.
 */
export interface PeerConnectionLike {
  connectionState: RTCPeerConnectionState;
  iceConnectionState?: RTCIceConnectionState;
  iceGatheringState?: RTCIceGatheringState;
  onconnectionstatechange: ((this: PeerConnectionLike, ev: Event) => void) | null;
  oniceconnectionstatechange?: ((this: PeerConnectionLike, ev: Event) => void) | null;
  onicegatheringstatechange?: ((this: PeerConnectionLike, ev: Event) => void) | null;
  onicecandidateerror?: ((this: PeerConnectionLike, ev: Event) => void) | null;
  onicecandidate:
    | ((this: PeerConnectionLike, ev: { candidate: RTCIceCandidateInit | null }) => void)
    | null;
  ondatachannel:
    | ((this: PeerConnectionLike, ev: { channel: DataChannelLike }) => void)
    | null;
  createDataChannel(label: string, options?: RTCDataChannelInit): DataChannelLike;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  close(): void;
}

export type CreatePeerConnection = () => PeerConnectionLike;

function defaultCreatePeerConnection(iceServers: readonly RTCIceServer[]): PeerConnectionLike {
  return new RTCPeerConnection({
    iceServers: [...iceServers],
  }) as unknown as PeerConnectionLike;
}

export interface PeerOptions {
  readonly role: PeerRole;
  /**
   * ICE servers for the underlying connection. Resolve these with
   * `iceServers.ts` rather than hard-coding: whether a relay is present
   * changes both connectivity and the failure copy. Defaults to STUN only.
   */
  readonly iceServers?: readonly RTCIceServer[];
  /** Injectable for testing; defaults to the real global RTCPeerConnection. */
  readonly createPeerConnection?: CreatePeerConnection;
  /** Overrides CONNECT_TIMEOUT_MS from config - tests only. */
  readonly connectTimeoutMs?: number;
  /** Overrides ANSWER_TIMEOUT_MS from config - tests only. */
  readonly answerTimeoutMs?: number;
  /** Optional label for log lines, e.g. a PlayerId. */
  readonly logLabel?: string;
}

type Unsubscribe = () => void;

/** Upper bound on remote candidates held while waiting for the remote description. */
const MAX_PENDING_REMOTE_CANDIDATES = 64;

/** `candidate:1 1 UDP 2130706431 10.0.0.2 54321 typ host` -> `host`. */
function candidateType(candidate: RTCIceCandidateInit): string {
  const match = /\btyp\s+(\w+)/.exec(candidate.candidate ?? "");
  return match ? match[1] : "unknown";
}

/**
 * One WebRTC connection to one remote peer, with its `control` and `stream`
 * data channels. The Host owns one `Peer` per connected Guest; a Guest owns
 * exactly one `Peer` (to the Host).
 */
export class Peer {
  readonly role: PeerRole;

  private readonly pc: PeerConnectionLike;
  private readonly connectTimeoutMs: number;
  private readonly answerTimeoutMs: number;
  private readonly logLabel: string;
  private readonly relayAvailable: boolean;

  private state: PeerState = "new";
  private failure: PeerFailure | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;

  private controlChannel: DataChannelLike | null = null;
  private streamChannel: DataChannelLike | null = null;

  /**
   * Remote candidates that arrived before the remote description was applied.
   * Flushed in order by `markRemoteDescriptionApplied()`. See the file header.
   * The window is short (bounded by the answer timeout) and a browser gathers
   * far fewer than the cap; the cap only bounds what a hostile signaling peer
   * can make this tab hold.
   */
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionApplied = false;

  /** Types of LOCAL candidate gathered so far, e.g. host / srflx / relay. Diagnostics only. */
  private readonly gatheredTypes = new Set<string>();

  private readonly stateHandlers = new Set<
    (state: PeerState, message: string | undefined) => void
  >();
  private readonly messageHandlers = new Set<
    (channel: Channel, data: unknown) => void
  >();
  private readonly iceCandidateHandlers = new Set<
    (candidate: RTCIceCandidateInit) => void
  >();

  constructor(options: PeerOptions) {
    this.role = options.role;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.answerTimeoutMs = options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
    this.logLabel = options.logLabel ?? options.role;

    const iceServers = options.iceServers ?? [{ urls: [...STUN_SERVERS] }];
    this.relayAvailable = iceServers.some((s) => {
      const urls = typeof s.urls === "string" ? [s.urls] : s.urls;
      return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
    });

    this.pc =
      options.createPeerConnection?.() ?? defaultCreatePeerConnection(iceServers);

    this.pc.onconnectionstatechange = () => this.handleConnectionStateChange();
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.gatheredTypes.add(candidateType(ev.candidate));
        for (const h of this.iceCandidateHandlers) h(ev.candidate);
      }
    };

    // Diagnostics. `connectionState` alone says a connection failed but never
    // why; the ICE states and the set of gathered candidate types are what
    // separate "no route out of this device" from "no route to that host".
    this.pc.oniceconnectionstatechange = () => {
      console.debug(`[peer:${this.logLabel}] iceConnectionState=${this.pc.iceConnectionState}`);
      if (this.pc.iceConnectionState === "failed") {
        this.fail(this.gatheredTypes.size === 0 ? "no-candidates" : "ice-failed");
      }
    };
    this.pc.onicegatheringstatechange = () => {
      if (this.pc.iceGatheringState === "complete") {
        console.debug(
          `[peer:${this.logLabel}] ICE gathering complete; candidate types: ` +
            `${[...this.gatheredTypes].join(", ") || "NONE"}` +
            `${this.relayAvailable ? "" : " (no TURN server configured)"}`,
        );
      }
    };
    this.pc.onicecandidateerror = (ev) => {
      // Common and usually harmless (one STUN server of several not answering),
      // so this is a debug line, not a failure.
      console.debug(`[peer:${this.logLabel}] ICE candidate error`, ev);
    };

    if (this.role === "answerer") {
      // The offerer (Guest) creates the data channels; the answerer (Host)
      // receives them here.
      this.pc.ondatachannel = (ev) => this.attachChannel(ev.channel);
    }
  }

  getState(): PeerState {
    return this.state;
  }

  /** Set only when state is "failed" - a user-facing explanation. */
  getFailureMessage(): string | undefined {
    return this.failure?.message;
  }

  /** Set only when state is "failed" - reason, message and a hint. */
  getFailure(): PeerFailure | undefined {
    return this.failure;
  }

  /** True when a TURN server was supplied. Drives the "ice-failed" copy. */
  hasRelay(): boolean {
    return this.relayAvailable;
  }

  /** Local ICE candidate types gathered so far (host / srflx / relay). Diagnostics. */
  getGatheredCandidateTypes(): readonly string[] {
    return [...this.gatheredTypes];
  }

  // ── Offer/answer exchange ────────────────────────────────────────────────

  /** Guest only. Creates both data channels and returns a local offer. */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.role !== "offerer") {
      throw new Error("createOffer() may only be called by the offerer (Guest)");
    }
    this.enterConnecting();
    this.attachChannel(
      this.pc.createDataChannel("control", { ordered: true }),
    );
    this.attachChannel(
      this.pc.createDataChannel("stream", { ordered: false, maxRetransmits: 0 }),
    );
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Guest only. Applies the Host's answer once it arrives via signaling. */
  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (this.role !== "offerer") {
      throw new Error("acceptAnswer() may only be called by the offerer (Guest)");
    }
    await this.pc.setRemoteDescription(answer);
    await this.markRemoteDescriptionApplied();
  }

  /** Host only. Applies a Guest's offer and returns a local answer. */
  async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (this.role !== "answerer") {
      throw new Error("createAnswer() may only be called by the answerer (Host)");
    }
    this.enterConnecting();
    await this.pc.setRemoteDescription(offer);
    await this.markRemoteDescriptionApplied();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Both roles, as trickle ICE candidates arrive over signaling.
   *
   * Safe to call before the remote description exists: candidates are held and
   * replayed in order once it does. Never rejects - a candidate the browser
   * refuses is logged and skipped, because one bad candidate must not abort
   * the others.
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.state === "closed" || this.state === "failed") return;
    if (!this.remoteDescriptionApplied) {
      if (this.pendingRemoteCandidates.length < MAX_PENDING_REMOTE_CANDIDATES) {
        this.pendingRemoteCandidates.push(candidate);
      }
      return;
    }
    await this.applyRemoteCandidate(candidate);
  }

  /** How many remote candidates are waiting on the remote description. Tests/diagnostics. */
  getPendingCandidateCount(): number {
    return this.pendingRemoteCandidates.length;
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  send(channel: Channel, data: unknown): void {
    const dc = channel === "control" ? this.controlChannel : this.streamChannel;
    if (!dc || dc.readyState !== "open") {
      console.warn(
        `[peer:${this.logLabel}] dropped send on "${channel}" - channel not open`,
      );
      return;
    }
    dc.send(JSON.stringify(data));
  }

  onMessage(handler: (channel: Channel, data: unknown) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStateChange(
    handler: (state: PeerState, message: string | undefined) => void,
  ): Unsubscribe {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onIceCandidate(handler: (candidate: RTCIceCandidateInit) => void): Unsubscribe {
    this.iceCandidateHandlers.add(handler);
    return () => this.iceCandidateHandlers.delete(handler);
  }

  close(): void {
    if (this.state === "closed") return;
    this.clearTimers();
    this.pendingRemoteCandidates = [];
    this.controlChannel?.close();
    this.streamChannel?.close();
    try {
      this.pc.close();
    } catch {
      // already closed - fine.
    }
    this.transition("closed");
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async applyRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // Was a silent unhandled rejection before, which is how an entire class
      // of connection failures went unnoticed. Never let it be silent again.
      console.warn(
        `[peer:${this.logLabel}] browser rejected a remote ICE candidate (typ ${candidateType(candidate)})`,
        err,
      );
    }
  }

  /**
   * Called immediately after `setRemoteDescription` resolves, in either role.
   * Drains whatever arrived early, in arrival order.
   */
  private async markRemoteDescriptionApplied(): Promise<void> {
    if (this.remoteDescriptionApplied) return;
    this.remoteDescriptionApplied = true;
    this.clearAnswerTimer();

    const pending = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    if (pending.length > 0) {
      console.debug(
        `[peer:${this.logLabel}] flushing ${pending.length} ICE candidate(s) buffered before the remote description`,
      );
    }
    for (const candidate of pending) {
      await this.applyRemoteCandidate(candidate);
    }
  }

  private enterConnecting(): void {
    this.transition("connecting");
    this.clearTimers();

    this.connectTimer = setTimeout(() => {
      if (this.state !== "connecting") return;
      // Time ran out with no more specific signal. If ICE never produced a
      // single local candidate, that is the diagnosis; otherwise it is a plain
      // timeout, distinct from ICE actively reporting failure.
      this.fail(this.gatheredTypes.size === 0 ? "no-candidates" : "timeout");
    }, this.connectTimeoutMs);

    // Only the Guest waits on an answer; the Host applies the offer it was
    // handed, so markRemoteDescriptionApplied() clears this almost at once.
    if (this.role === "offerer") {
      this.answerTimer = setTimeout(() => {
        if (this.state === "connecting" && !this.remoteDescriptionApplied) {
          this.fail("no-answer");
        }
      }, this.answerTimeoutMs);
    }
  }

  private attachChannel(dc: DataChannelLike): void {
    if (dc.label === "control") {
      this.controlChannel = dc;
    } else if (dc.label === "stream") {
      this.streamChannel = dc;
    } else {
      console.warn(`[peer:${this.logLabel}] ignoring unknown data channel "${dc.label}"`);
      return;
    }

    dc.onopen = () => {
      // "connected" is gated on the reliable control channel being open -
      // that's the channel JOIN/WELCOME/GRAB/etc. travel on, so it's the
      // meaningful readiness signal. `stream` opening is not separately
      // tracked as a state - it's best-effort by design.
      if (dc.label === "control" && this.state === "connecting") {
        this.transition("connected");
      }
    };
    dc.onclose = () => {
      if (dc.label === "control" && (this.state === "connected" || this.state === "connecting")) {
        this.transition("closed");
      }
    };
    dc.onerror = () => {
      if (dc.label === "control" && this.state !== "closed" && this.state !== "failed") {
        this.fail("channel-error");
      }
    };
    dc.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        console.warn(`[peer:${this.logLabel}] dropped unparseable message on "${dc.label}"`);
        return;
      }
      const channel: Channel = dc.label === "control" ? "control" : "stream";
      for (const h of this.messageHandlers) h(channel, parsed);
    };
  }

  private handleConnectionStateChange(): void {
    const s = this.pc.connectionState;
    if (s === "failed") {
      // `iceconnectionstatechange` usually beats this and gives a sharper
      // reason; whichever lands first wins, since transition() ignores the second.
      this.fail(this.gatheredTypes.size === 0 ? "no-candidates" : "ice-failed");
    } else if (s === "closed") {
      this.transition("closed");
    }
    // "connected" is intentionally NOT driven from here - see attachChannel:
    // we gate on the control data channel's `open` event instead, since that
    // is what actually matters to callers (able to send/receive messages).
  }

  private fail(reason: PeerFailureReason): void {
    if (this.state === "closed" || this.state === "failed") return;
    const failure = describeFailure(reason, this.relayAvailable);
    console.debug(
      `[peer:${this.logLabel}] failing: ${reason} ` +
        `(candidates: ${[...this.gatheredTypes].join(", ") || "none"}, relay: ${this.relayAvailable})`,
    );
    this.failure = failure;
    this.transition("failed", failure.message);
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) {
      clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.clearAnswerTimer();
  }

  private transition(next: PeerState, message?: string): void {
    if (this.state === next) return;
    // Terminal states don't reopen.
    if (this.state === "closed" || this.state === "failed") return;

    console.debug(`[peer:${this.logLabel}] ${this.state} -> ${next}`);
    this.state = next;
    if (next !== "failed") this.failure = undefined;

    if (next === "connected" || next === "failed" || next === "closed") {
      this.clearTimers();
    }

    for (const h of this.stateHandlers) h(next, message);
  }
}

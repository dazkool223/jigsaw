/**
 * A thin, protocol-agnostic wrapper around one `RTCPeerConnection` and its
 * two data channels (`control`: reliable/ordered, `stream`: unreliable/
 * unordered). This file knows nothing about `protocol.ts` — it moves bytes
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
 * Every transition is logged. `failed` carries a user-facing message
 * suitable for direct display (see CONNECT_TIMEOUT_MS handling below).
 *
 * The Guest is ALWAYS the offerer (role: "offerer") and the Host ALWAYS
 * answers (role: "answerer") — this sidesteps negotiation glare entirely,
 * so there is no glare-handling logic here by design.
 *
 * The `RTCPeerConnection` constructor is injectable via `createPeerConnection`
 * so this class can be driven by a fake in tests, without a real browser.
 */

import { CONNECT_TIMEOUT_MS, STUN_SERVERS } from "../config";
import type { Channel } from "../types";

export type PeerRole = "offerer" | "answerer";

export type PeerState = "new" | "connecting" | "connected" | "failed" | "closed";

const USER_FACING_TIMEOUT_MESSAGE =
  "Couldn't connect — this can happen on some mobile networks";

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

/** The subset of `RTCPeerConnection` this module needs. Real connections satisfy it. */
export interface PeerConnectionLike {
  connectionState: RTCPeerConnectionState;
  onconnectionstatechange: ((this: PeerConnectionLike, ev: Event) => void) | null;
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

const defaultCreatePeerConnection: CreatePeerConnection = () =>
  new RTCPeerConnection({
    iceServers: [{ urls: [...STUN_SERVERS] }],
  }) as unknown as PeerConnectionLike;

export interface PeerOptions {
  readonly role: PeerRole;
  /** Injectable for testing; defaults to the real global RTCPeerConnection. */
  readonly createPeerConnection?: CreatePeerConnection;
  /** Overrides CONNECT_TIMEOUT_MS from config — tests only. */
  readonly connectTimeoutMs?: number;
  /** Optional label for log lines, e.g. a PlayerId. */
  readonly logLabel?: string;
}

type Unsubscribe = () => void;

/**
 * One WebRTC connection to one remote peer, with its `control` and `stream`
 * data channels. The Host owns one `Peer` per connected Guest; a Guest owns
 * exactly one `Peer` (to the Host).
 */
export class Peer {
  readonly role: PeerRole;

  private readonly pc: PeerConnectionLike;
  private readonly connectTimeoutMs: number;
  private readonly logLabel: string;

  private state: PeerState = "new";
  private failureMessage: string | undefined;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  private controlChannel: DataChannelLike | null = null;
  private streamChannel: DataChannelLike | null = null;

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
    this.logLabel = options.logLabel ?? options.role;
    this.pc = (options.createPeerConnection ?? defaultCreatePeerConnection)();

    this.pc.onconnectionstatechange = () => this.handleConnectionStateChange();
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        for (const h of this.iceCandidateHandlers) h(ev.candidate);
      }
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

  /** Set only when state is "failed" — a user-facing explanation. */
  getFailureMessage(): string | undefined {
    return this.failureMessage;
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
  }

  /** Host only. Applies a Guest's offer and returns a local answer. */
  async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (this.role !== "answerer") {
      throw new Error("createAnswer() may only be called by the answerer (Host)");
    }
    this.enterConnecting();
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /** Both roles, as trickle ICE candidates arrive over signaling. */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(candidate);
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  send(channel: Channel, data: unknown): void {
    const dc = channel === "control" ? this.controlChannel : this.streamChannel;
    if (!dc || dc.readyState !== "open") {
      console.warn(
        `[peer:${this.logLabel}] dropped send on "${channel}" — channel not open`,
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
    this.clearTimeout();
    this.controlChannel?.close();
    this.streamChannel?.close();
    try {
      this.pc.close();
    } catch {
      // already closed — fine.
    }
    this.transition("closed");
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private enterConnecting(): void {
    this.transition("connecting");
    this.clearTimeout();
    this.timeoutHandle = setTimeout(() => {
      if (this.state === "connecting") {
        this.transition("failed", USER_FACING_TIMEOUT_MESSAGE);
      }
    }, this.connectTimeoutMs);
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
      // "connected" is gated on the reliable control channel being open —
      // that's the channel JOIN/WELCOME/GRAB/etc. travel on, so it's the
      // meaningful readiness signal. `stream` opening is not separately
      // tracked as a state — it's best-effort by design.
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
        this.transition("failed", USER_FACING_TIMEOUT_MESSAGE);
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
      this.transition("failed", USER_FACING_TIMEOUT_MESSAGE);
    } else if (s === "closed") {
      this.transition("closed");
    }
    // "connected" is intentionally NOT driven from here — see attachChannel:
    // we gate on the control data channel's `open` event instead, since that
    // is what actually matters to callers (able to send/receive messages).
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private transition(next: PeerState, message?: string): void {
    if (this.state === next) return;
    // Terminal states don't reopen.
    if (this.state === "closed" || this.state === "failed") return;

    console.debug(`[peer:${this.logLabel}] ${this.state} -> ${next}`);
    this.state = next;
    this.failureMessage = message;

    if (next === "connected" || next === "failed" || next === "closed") {
      this.clearTimeout();
    }

    for (const h of this.stateHandlers) h(next, message);
  }
}

export { USER_FACING_TIMEOUT_MESSAGE };

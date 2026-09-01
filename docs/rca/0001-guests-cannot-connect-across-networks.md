# RCA: guests can't join across networks ("Couldn't connect - this can happen on some mobile networks")

Reported 2026-08-31. Several people opened a Room link, sat on the connecting
screen for about 15 seconds, and got:

> **Couldn't join this puzzle**
> Couldn't connect - this can happen on some mobile networks
> Switching to Wi-Fi, or trying from a different network, usually gets through.

They switched networks. It kept happening. The hint in that message is wrong,
and it sent everyone chasing the wrong thing.

## What the failure actually is

Only three code paths can produce that string. All of them live in
`src/net/peer.ts` and all of them set the same `USER_FACING_TIMEOUT_MESSAGE`:

| Where | Trigger |
| --- | --- |
| `enterConnecting()` | still in state `connecting` after `CONNECT_TIMEOUT_MS` (15s) |
| `handleConnectionStateChange()` | `pc.connectionState === "failed"` |
| `attachChannel()` `dc.onerror` | the `control` data channel errored |

`GuestNet` maps `failed` to a status, `app.tsx` maps that to
`kind: "connect-failed"`, and `ConnectionOverlay` prints the message verbatim
under a fixed hint about Wi-Fi. So the copy is a guess baked in at build time,
not a diagnosis. A Guest sees the same sentence whether ICE genuinely failed,
the Host never answered, the Host's tab went to sleep, or the data channel died.

## What the symptom rules out

Reaching that screen at all is informative. To get there a Guest must already
have, in order:

1. resolved `get_room` over the Supabase RPC, so the project and the room code are fine;
2. loaded and decoded the image from Storage, so the bucket and the public URL are fine;
3. subscribed to the `room:<code>` Realtime channel;
4. received a **presence sync naming a Host as online**, because
   `beginGuestFlow`'s `decide(online)` only calls `guestNet.connect()` when
   `online === true`. Without it the Guest lands on the Resume screen instead;
5. created an offer and started the 15 second timer.

Everything except WebRTC itself is proven working by the symptom. The fault is
between `createOffer()` and the `control` channel opening.

## Root cause: there is no TURN server

```
src/config.ts:150   export const STUN_SERVERS = ["stun:stun.l.google.com:19302"] as const;
src/net/peer.ts:72    iceServers: [{ urls: [...STUN_SERVERS] }],
```

`grep -rn "turn:" src/` returns nothing. One UDP STUN server is the entire ICE
configuration, so the only candidates either side can offer are host candidates
and server-reflexive ones. Two consequences, and both match the report exactly:

**A symmetric NAT on the Host's side breaks every Guest, from every network.**
STUN tells you the external address the STUN server saw. A symmetric NAT
allocates a *different* external port per destination, so that address is not
the one a Guest must send to. Carrier-grade NAT on mobile data behaves this way,
and so do plenty of ISPs and corporate networks. Since the Host is one fixed
endpoint that every Guest must reach, a Host behind such a NAT fails all of
them. No amount of Guest-side network switching changes the Host's NAT. That is
precisely the "changed networks, still broken" pattern.

**A network that blocks UDP outright breaks everything.** `stun:...:19302` is
UDP. When UDP is filtered there is no STUN response, no reflexive candidate, and
nothing to fall back on. TURN over TCP or TLS on 443 is the usual escape hatch
and it isn't configured.

Roughly 10-20% of consumer WebRTC connections need a relay even on fixed lines.
On mobile it is much higher. A STUN-only build is a coin flip, not a bug that
shows up occasionally.

This was known and written down. `CONTEXT.md`, M3:

> **Not yet live-tested**: LAN/cross-network (only localhost, where ICE always succeeds, has been tried), STUN-only failure UX

Localhost pairs connect on host candidates before STUN is even consulted, so the
live two-browser test that "confirmed WebRTC works" exercised the signaling path
against real Supabase but never exercised NAT traversal at all.

## Contributing cause: ICE candidates are silently thrown away

Independent of TURN, both sides drop trickled candidates that arrive before the
remote description is set. `RTCPeerConnection.addIceCandidate()` rejects with
`InvalidStateError` when `remoteDescription` is null, and every call site
discards the rejection with `void`.

Host side, `src/net/hostNet.ts`:

```ts
onIceCandidateFromGuest: (from, candidate) => {
  void this.guests.get(from)?.peer.addIceCandidate(candidate);   // line 56
},
...
this.guests.set(guestId, connection);        // line 128: registered here
const answer = await peer.createAnswer(sdp); // line 147: remote description set in here
```

The Guest is the offerer. It calls `setLocalDescription(offer)` and starts
trickling immediately, so its candidates chase the offer down the same Realtime
channel and land while the Host is still inside that `await`. Candidates that
arrive even earlier hit `this.guests.get(from)?` before the entry exists and
vanish through the optional chain without so much as a rejection.

Guest side, `src/net/guestNet.ts`:

```ts
onAnswer: (from, sdp) => {
  this.hostId = from;
  void this.peer.acceptAnswer(sdp).then(...)   // async setRemoteDescription
},
onIceCandidateFromHost: (_from, candidate) => {
  void this.peer.addIceCandidate(candidate);   // line 96
},
```

The Host emits its own candidates from inside `createAnswer()`, before
`sendAnswer()` runs, so they arrive right behind the answer while
`acceptAnswer()` is still in flight. Same loss.

I reproduced both against the real `HostNet`/`GuestNet` wiring, swapping in an
`RTCPeerConnection` fake that rejects `addIceCandidate` the way Chrome does:

```
host accepted: []
host REJECTED: [ 'host-type-lan', 'srflx-THE-ONE-THAT-MATTERS' ]

guest accepted: []
guest REJECTED: [ 'host-srflx-THE-ONE-THAT-MATTERS' ]
```

On localhost this costs nothing. Candidates keep coming, and any surviving
loopback pair connects. Across NAT the reflexive candidate is often the only
usable one, and losing it is the whole connection. The `void` means the failure
never reaches a log the app controls, only an unhandled rejection in the console.

## Contributing cause: retrying is a no-op for up to 15 seconds

`src/net/hostNet.ts:114`:

```ts
if (this.guests.has(guestId)) return; // duplicate offer (e.g. retried broadcast) - ignore
```

`guestId` is the persisted per-device `PlayerId` from localStorage
(`identity.ts`), so it survives reloads, retries, and network changes. When a
Guest's first attempt fails, the Host still holds a dead `Peer` under that id
until its own 15 second timer fires. The Host's timer starts later than the
Guest's, because it starts when the offer arrives. Anyone who presses "Try
again" promptly, which is what the button invites, gets their offer dropped on
the floor with no answer, waits another 15 seconds, and sees the identical
error. Reproduced:

```
answers after 1st offer: 1   after retry: 1
```

The retry produced no answer at all. This is what makes the failure feel
permanent rather than intermittent.

## Contributing cause: presence says "Host online" when it isn't

`beginGuestFlow` gates connecting on a Realtime presence sync. Presence lags
reality. A Host that closed a laptop lid, backgrounded a mobile browser, or lost
its network leaves a tracked entry behind until the heartbeat times out. During
that window every Guest is told to connect to nobody, waits 15 seconds, and is
shown a message blaming their mobile network.

Worth checking against the actual incident: if the Host wasn't reliably in the
foreground the whole time, some of these failures may have no network component
at all.

## Why the test suite is green

`src/net/peer.test.ts`'s `FakePeerConnection`:

```ts
async setRemoteDescription(_desc: RTCSessionDescriptionInit): Promise<void> {}

async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
  this.addedIceCandidates.push(candidate);
}
```

It accepts candidates in any order and tracks no remote-description state, so
the ordering bug is structurally invisible to it. All 273 tests pass and always
would have. Nothing here is a testing oversight in the ordinary sense. The fakes
model the API's shape but not its state machine, which is exactly where the
defect lives.

## Fixes, in the order I'd do them

**1. Add TURN.** This one is not optional, and nothing else matters until it
lands. Everything below is a real bug that will also bite, but a STUN-only
deployment stays broken for a large fraction of users no matter how clean the
rest of the code is.

Replace `STUN_SERVERS` with a full `RTCIceServer[]` including UDP TURN, TCP
TURN, and TURNS on 443. Managed options are Cloudflare Realtime TURN, Twilio
Network Traversal, Metered, or Xirsys. Self-hosting coturn on a small VPS also
works.

Credentials need care given ADR-0001's stance on what ships in the bundle. Do
not paste a static TURN username and password into a `VITE_` variable, since
that is a free relay for anyone who views source. Mint short-lived HMAC
credentials (coturn's `use-auth-secret` scheme, or the provider's ephemeral
credential API) from a Supabase Edge Function, and have the client fetch them
just before building the `RTCPeerConnection`.

Budget for it: the star topology already routes every message through the Host,
and a relayed connection puts all of that through TURN too. At `MAX_PLAYERS = 8`
and `STREAM_HZ = 25` that is the O(n²) fan-out `config.ts` already warns about,
now metered.

**2. Buffer ICE candidates in `Peer`.** Hold candidates in an array until the
remote description is applied, then flush. Set the flag inside `acceptAnswer`
and `createAnswer` after their `setRemoteDescription` resolves. This belongs in
`peer.ts`, not in `hostNet`/`guestNet`, so both roles get it once. While there,
replace every `void somePromise` in the ICE paths with a `.catch` that logs, so
the next failure of this kind is visible.

**3. Make a re-offer replace the old connection.** In `handleOffer`, when
`this.guests.has(guestId)`, tear down the existing `Peer` and negotiate fresh
instead of returning. A second offer from a known id means the Guest gave up on
the first one.

**4. Report what actually failed.** Subscribe to `iceconnectionstatechange` and
`icegatheringstatechange`, log the candidate types gathered on each side, and
read the selected pair out of `pc.getStats()` on success. Then split the one
message into distinct states: no answer from the Host (signaling or a stale
presence entry), ICE failed with candidates gathered (needs a relay), and no
candidates gathered at all (UDP blocked or STUN unreachable). The current copy
told five different failures the same story and cost this investigation a round
of network switching that could never have worked.

**5. Revisit `CONNECT_TIMEOUT_MS`.** 15 seconds covers a signaling round trip,
STUN gathering, connectivity checks, and a DTLS handshake over cellular. Once
TURN is in, relay allocation is added to that. It is tight. Consider a longer
budget for reaching `connected` and a separate, shorter timer for "the Host
never answered", which is the case actually worth failing fast on.

## Fix 1 alone is what unblocks the Room

Fixes 2 through 5 are genuine defects and 2 could plausibly be breaking
connections on its own. But the one that explains every friend failing from
every network is the missing relay, and it is the one to ship first.

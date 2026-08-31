# Feasibility of a dedicated server, and whether Supabase Edge Functions can be it

Status: investigation, no decision taken. Written 2026-08-31, after
`docs/rca/0001-guests-cannot-connect-across-networks.md`.

The question behind this: would a real server have avoided the NAT outage, and
what would one actually cost? Short answers: yes it would, the compute needed is
negligible, Edge Functions cannot host it, and Cloudflare Durable Objects fit the
existing design almost exactly.

## What the server would actually have to do

Measured against this codebase, not estimated.

The single most important number is one that is *not* on the server. A 494-piece
puzzle's full geometry, every edge path and tab curve, serialises to **1.82 MB**.
None of it needs to leave the client. Rooms persist only `(image, seed, rows,
cols)` and every peer regenerates identical geometry from the seed, which is
already how the app works. What the server must hold is only the authoritative
`GameState`:

| Per room, 494 pieces (the largest preset) | |
| --- | --- |
| Serialised `GameState` JSON | 40,109 bytes |
| Groups tracked | 494 |
| Puzzle geometry (client-derived, never sent) | 1,821,030 bytes |
| `CURSOR` message | 110 bytes |
| `MOVE` message | 123 bytes |
| `FULL_STATE` resync | 40,147 bytes, every 30s |

In a JS heap those 494 group objects cost roughly 150-250 KB. WebSocket send and
receive buffers for 8 connections cost more than the game state does. Call it
**under 1 MB of RSS per active room**, socket-buffer dominated.

CPU is not a constraint either. Benchmarking the real hot path (parse a 110-byte
inbound message, apply the state mutation, re-serialise, fan out to 7
recipients) on Node 22:

```
inbound messages handled:   820,447 /sec on one core
cpu per inbound message:    1.22 us
```

Divide by 5-10 for real WebSocket framing and syscalls, so call it 80-160k
messages/sec/core. A room where all 8 players drag continuously at
`STREAM_HZ = 25` produces 200 inbound messages/sec. Even at that
never-actually-happens duty cycle, one core carries several hundred rooms.

**Bandwidth is the only real cost.** Star fan-out means 8 players × 25 Hz × 7
recipients = 1,400 outbound messages/sec, about **1.3 Mbit/s per room at full
tilt**. That is not new load; it is exactly what `config.ts` already warns is
going through the host's residential uplink today. A server moves that bill from
a player's home connection to yours. It does not reduce it.

So the sizing answer is boring: **the smallest instance any provider sells is
enough.** 256 MB and a fraction of a core. The interesting constraints are
always-on-ness and per-message billing, not CPU or RAM.

## The 2026 free tier landscape is worse than its reputation

Most of the "just deploy it free" advice still circulating is out of date.

| Provider | Free compute in 2026 | Verdict for this |
| --- | --- | --- |
| Fly.io | None. Replaced with a 2-hour / 7-day trial in 2024 | Not an option |
| Railway | $5 trial credit, then usage-based | Not free |
| Koyeb | Dropped free compute (Postgres only) | Not an option |
| Render | 512 MB, **0.1 CPU**, 750 instance-hours/month | Works, with caveats |
| Oracle Cloud Always Free | ARM VM, never sleeps, 10 TB/mo egress | Most raw compute, most operational burden |
| Cloudflare Workers + Durable Objects | 100k requests/day, 313k GB-s/day | Best architectural fit |

Two things worth knowing before leaning on the first two "still free" entries.

**Render spins down after 15 minutes of no inbound traffic, and that explicitly
includes WebSocket messages from existing connections.** Restart takes 30-60
seconds. For a game server this is the wrong failure mode: a room where everyone
pauses to think dies, and the next person to join stares at a loading page for a
minute. 0.1 CPU is also genuinely tight for 1,400 outbound messages/sec of
fanout, though it would probably hold for one or two rooms.

**Oracle halved the Always Free Ampere allowance from 4 OCPU / 24 GB to 2 OCPU /
12 GB on 15 June 2026**, with over-limit instances terminated from 18 August,
two weeks ago. They did it with no announcement; the docs simply changed and
people found out when instances stopped. 2 OCPU / 12 GB is still far more than
this app needs and it never sleeps, which is the one thing Render's free tier
cannot offer. The costs are real though: ARM capacity in popular regions is
frequently unavailable, there is no SLA, idle accounts get reaped, and you become
the sysadmin for OS patching, TLS renewal, process supervision and monitoring.
And they have now demonstrated they will halve your resources without telling you.

## Cloudflare Durable Objects map onto this design almost exactly

This is worth spelling out because the fit is unusually close, not just adequate.

A Durable Object is a single addressable, single-threaded, stateful actor. One
instance per Room code gives you precisely the model ADR-0001 already describes,
"exactly one authoritative owner per Room", except the owner is a Cloudflare
actor with a public address instead of whichever player happened to click Resume.
Concretely:

- **Single-threaded serialised execution per object.** The `heldBy` grab
  arbitration and atomic merge in `game/state.ts` need no locking, exactly as
  they need none in the host's browser today.
- **CPU time resets to 30 seconds on every incoming WebSocket message.** Durable
  Objects are built for long-lived connections. Contrast with Edge Functions
  below; this single difference is the whole story.
- **WebSocket Hibernation.** An idle room stops accruing duration charges while
  its sockets stay open. No spin-down, no cold start on join. This is the exact
  problem Render's free tier has, solved.
- **10 GB SQLite storage per object**, which could absorb the `SnapshotScheduler`
  debounce-to-Postgres path entirely.
- 128 MB memory per object, against the sub-1 MB a room needs.

### The free-tier math, which is the part that surprised me

Incoming WebSocket messages bill at **20:1** (100 inbound messages count as 5
requests), and **outgoing WebSocket messages are not billed at all**. That
inverts the intuition, because the 1,400 msg/sec fanout is the free half and only
the 200 msg/sec inbound counts.

At 100,000 requests/day on the free plan:

- All 8 players dragging non-stop: 200 inbound/sec ÷ 20 = 10 req/sec, so
  **~2.8 hours/day** of absolute worst case.
- A more honest 3 players moving at once: 75 inbound/sec ÷ 20 = 3.75 req/sec, so
  **~7.4 hours/day** of active play.

Duration is not the binding constraint: 313,000 GB-s/day against 128 MB per
object is roughly 695 object-hours/day, and hibernation means idle rooms cost
nothing. Requests bind first.

For a puzzle you play with friends, several hours a day on the free plan is
fine. Past that, Workers Paid is $5/month including 1M requests, then $0.15 per
additional million. At the 3-player figure sustained, overage lands around
**$0.30/month**. `STREAM_HZ` is also a direct lever here: dropping cursors from
25 Hz to 15 Hz, or batching them into aggregated ticks, extends every number
above proportionally.

## Supabase Edge Functions cannot host this

Not "would be awkward". Three independent hard limits each kill it outright.

1. **Wall clock: 150s on Free, 400s on Pro.** A puzzle session runs 20+ minutes.
   The worker is terminated mid-game, guaranteed, every time. `EdgeRuntime
   .waitUntil()` prevents *early* retirement while a socket is open but explicitly
   does not extend the hard limit. The clock starts at the HTTP upgrade request.
2. **CPU: 2 seconds per request**, and an isolate shuts down once it uses 50% of
   any resource.
3. **No shared state between isolates, and no way to address one.** Eight players
   means eight separate upgrade requests with no guarantee they land on the same
   isolate. There is no actor primitive, no `idFromName(roomCode)`. You would need
   an external store for state plus external pub/sub for fanout, at which point
   you have rebuilt Realtime badly and added a hop.

Point 3 is the architectural one and would matter even if the timeouts vanished.
Edge Functions are request-scoped and stateless by design. Durable Objects exist
precisely because that model cannot express "a room".

Worth being fair to the product: Edge Functions are the *right* tool for the TURN
credential endpoint already shipped in `supabase/functions/turn-credentials/`.
Short, stateless, request/response, secret-holding. Same product, opposite
suitability, and the difference is exactly whether the work is a request or a
session.

## Supabase Realtime Broadcast as transport: the message budget kills it

Tempting, because the project already depends on Realtime for signaling and this
would add zero new infrastructure. The free tier gives 200 concurrent connections
and **2 million messages/month**, where every fan-out counts separately.

One room at full tilt emits 1,400 outbound messages/sec. That exhausts a
2M/month budget in **under 24 minutes**. Even at 5 Hz it is measured in hours per
month. Realtime Broadcast cannot carry cursor streaming at any usable rate on the
free plan.

It could carry the `control` channel alone (GRAB, DROP, SNAP, PLAYER_LIST are
maybe 1-5 msg/sec/room) while cursors and mid-drag MOVE stay peer-to-peer. That
is a real hybrid, but it keeps WebRTC and therefore keeps TURN, so it solves none
of the connectivity problem while adding a second transport to reason about. Not
worth it.

## What moving to a server would delete

Worth weighing against the cost, because it is a lot of the trickiest code here:

- `host_epoch` compare-and-swap, and the `claim_host` RPC
- The claim / resume / deposed flow: `ResumeHostScreen`, `DeposedOverlay`,
  `handleDeposed`, epoch-guarded `save_snapshot`
- Realtime presence as a "is a host online" hint, and the stale-presence failure
  mode that made guests wait 15 seconds for a host that had closed their laptop
- `SnapshotScheduler` debouncing, if DO storage replaces it
- All of `net/` except the protocol itself: `peer.ts`, `hostNet.ts`,
  `guestNet.ts`, `signaling.ts`, `iceServers.ts`, and the TURN dependency

It also removes the failure mode TURN does not fix: **a room currently dies when
its host closes a laptop or a mobile browser backgrounds the tab.** No amount of
NAT traversal helps with that. It is the strongest argument for a server, stronger
than the connectivity bug, which is now fixed.

## Recommendation

Do not do this now. The connectivity bug is fixed, and the right next step is to
provision TURN and confirm it works.

If it does get revisited, Cloudflare Durable Objects is the option to take, and
it is not close. Not because of cost (Render and Oracle are also ~free) but
because one-actor-per-room is the model this codebase already implements by hand,
and hibernation solves the idle-room problem that the always-on-VM and the
spin-down-PaaS options each get wrong in opposite directions. Budget roughly $5
a month and a rewrite of `net/` plus deletion of the host-epoch subsystem.

Supabase Edge Functions are not a candidate for the game loop under any
configuration, and should stay what they are here: the TURN credential minter.

## Sources

- [Supabase Edge Functions limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase: handling WebSockets in Edge Functions](https://supabase.com/docs/guides/functions/websockets)
- [Supabase: worker timeouts and WebSocket drops](https://supabase.com/docs/guides/troubleshooting/edge-functions-worker-timeouts-and-websocket-drops)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Render: deploy for free](https://render.com/docs/free)
- [Oracle quietly halves Free Tier Ampere A1 limits (InfoQ)](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)
- [Fly.io free tier in 2026](https://www.saaspricepulse.com/blog/flyio-free-tier-2026)

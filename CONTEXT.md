# Jigsaw

A browser-first co-op multiplayer jigsaw puzzle. One player's browser is authoritative (no game server); others connect to it peer-to-peer.

## Language

### Puzzle

**Piece**:
One jigsaw tile, fully determined by the puzzle definition `(image, seed, rows, cols)`. Its outline is assembled from four Edges, not owned by it. Always belongs to exactly one Group.

**Edge**:
One cut line between two adjacent Pieces (or the straight outer boundary of a border Piece). Shared: each interior Edge is generated once and referenced by both neighbouring Pieces, one of them traversing it reversed. Edges — not Pieces — are what the seeded PRNG generates.

**Tab / Blank**:
The two sides of an interior Edge's interlocking bulge: the Tab protrudes from one Piece into the neighbouring Blank. A Tab has a pinched neck and a wider bulb, which is what makes Pieces interlock rather than abut.
_Avoid_: knob, hole, bump

**Cell**:
A Piece's nominal slot in the grid. Cell corners are jittered so cut lines look hand-cut, but a Cell's origin is still the Piece's solved position — jitter never moves the Lattice.

**Group**:
A rigid set of one or more correctly-joined Pieces that moves as one unit. Every Piece is in a Group; a lone Piece is a Group of one.
_Avoid_: island, cluster

**Lattice**:
The grid of solved positions on the board. "Lattice snap" is a Group snapping to its correct absolute position.
_Avoid_: board frame, correct position grid

**Merge**:
The host-decided, atomic joining of two Groups whose Pieces land within snap tolerance. A Group currently held by a player is never a merge target; the connection is deferred until it is dropped.

**Completion**:
The state where all Pieces belong to a single Group.

### Session & roles

**Room**:
A puzzle instance addressed by its unguessable code. The code is the credential: presenting it grants access; it is never listable.

**Host**:
The one player whose browser is currently authoritative for a Room: it decides grabs, merges, and writes Snapshots. A role, not a person — claimed explicitly, one holder at a time.

**Guest**:
Any connected player who is not the Host. Guests send intents (grab, move, drop) and receive authoritative state.

**Host Epoch**:
A monotonic counter on the Room row. Claiming Host increments it via compare-and-swap; exactly one claimant wins. Snapshot writes carrying a stale epoch are rejected.

**Snapshot**:
The persisted serialization of a Room's state (noun only — the act is "saving a snapshot"). Written only by the current Host.

**Grab**:
A player's lock request on a Group. The Host grants it to the first requester; a denied grab snaps the Group back for the loser.

**Player**:
A per-device identity (name + cursor color) persisted locally. Cosmetic only — no state of consequence is keyed to it.

# Host epoch as single-writer guard, and RPC-only room access

A Room has no game server: whichever browser holds the Host role is authoritative, and any player may claim that role when no Host is online. Realtime presence alone cannot arbitrate this — two players reloading a link seconds apart both observe "no host" and both start hosting, and a sleeping laptop can wake and flush a stale Snapshot over newer ones. We therefore keep a `host_epoch` counter on the Room row: claiming Host is a compare-and-swap increment, so exactly one claimant wins, and every Snapshot write carries its epoch in the `WHERE` clause so a deposed Host's writes fail instead of clobbering. A Host whose write is epoch-rejected demotes itself rather than continuing to serve.

Separately, the security model is "the unguessable Room code is the credential", which is only true if codes cannot be listed. Permissive RLS over a directly-granted table breaks this: the anon key ships in the JS bundle, so anyone could `SELECT *` and harvest every code, image, and writable Snapshot. We grant no direct table access and expose only `security definer` RPCs that require the code to be *presented* (`get_room`, `save_snapshot`, `claim_host`). The epoch check lives inside `save_snapshot`, so the single-writer guarantee cannot be bypassed by a client.

## Consequences

Both guarantees are enforced in `supabase/schema.sql`, which is applied by hand via the dashboard SQL editor — there is no migration tooling, so changes to these functions must be applied manually and kept in sync with the repo copy.

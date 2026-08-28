# Normalise uploaded images to WebP at upload time, never during play

Every peer slices the same Piece geometry from the same pixels, so an uploaded image must be normalised to one canonical, universally-decodable file before any Room exists. We decode with `createImageBitmap` (which accepts whatever the browser natively supports, including HEIC on Safari), downscale to a longest side of 2048px, and encode to WebP at ~0.8 quality, falling back to JPEG q0.85 if the browser cannot encode WebP. The stored object is served with its real content-type, so nothing downstream — Guests, texture baking, Snapshots — needs to know which encoder won.

We deliberately do not gate uploads on file extension. Format support is a property of the running browser, not of the filename, so we attempt the decode and report a specific, actionable error when it fails (a HEIC photo in Chrome, typically) rather than pre-rejecting files that would have worked.

## Consequences

The whole pipeline runs once, at upload, off the gameplay path — the constraint that image handling must not cost anything during play is met by construction, since by the time a Room is playable the image is already a single decoded, baked atlas. Re-encoding an existing Room's image is not supported: the format is fixed when the Room is created.

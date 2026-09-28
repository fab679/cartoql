# core shard — expected artifacts (snapshot slots)

Per docs/09, the gold shard carries three snapshot families;

- `sdl/`    — the SDL the generator must emit for this module, byte-stable
- `plans/`  — compiled algebra IR (JSON) for the shard's reference documents
- `responses/` — expected GraphQL responses per document

Snapshots land together with the matching implementation PRs (generator first).
Until then this directory documents the contract: snapshots are *reviewed artifacts*,
committed to the repo, diffed in PRs — never regenerated-and-overwritten silently.

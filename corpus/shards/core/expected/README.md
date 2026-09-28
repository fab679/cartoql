# core shard — expected artifacts (snapshot slots)

Per docs/09, the gold shard carries three snapshot families;

- `sdl/`    — the SDL the generator must emit for this module, byte-stable
- `plans/`  — compiled algebra IR (JSON) for the shard's reference documents
- `responses/` — expected GraphQL responses per document

The full trio has landed (M1):
- `sdl/core.graphql` + `sdl/core.map.json` — generator output + semantic map
- `plans/*.json` — compiled ADR-1 IR per reference document
- `responses/*.json` — executed responses (reference adapter), variables recorded

Snapshots are *reviewed artifacts*: committed, diffed in PRs, regenerated only via
`npm run corpus:snapshot:core` — never silently overwritten.

# Corpus Traceability (docs/09 rule)

> Every normative rule maps to at least one fixture. A spec edit (docs/02–08)
> without a new or adjusted fixture is an incomplete PR.

| Spec rule | Shard / fixture | Status |
|---|---|---|
| 06 D1 blank-node skolemization | `shards/typing/` | shard pending |
| 06 D2 default page size (20) | `shards/core/expected/sdl/core.graphql` (`first: Int = 20` on every paginated root) + `shards/pagination/` (cursor stability, pending) | **SDL-backed**; pagination shard pending |
| 06 D3 decimal → string scalar / fail-loud datatypes | generator `SCALAR_MAP` + `gold-shard.test.ts` (unknown datatype → GenerationError); decimal fixture still pending | **map + fail-loud backed**; decimal field fixture pending |
| 06 D4 multi-typed → union fallback | `shards/typing/` | shard pending |
| 06 D5 inverse fields | `shards/core/shapes.ttl` (`sh:path [ sh:inversePath vcore:authored ]`) → `authoredInverse: [Person!]!` in expected SDL + test | **backed** |
| 06 D6 canonical ordering key | `shards/core/data.ttl` (authored list ≥3); canonical IRI ordering + cursor contract implemented and tested in reference adapter (page-through test) | **backed (executor v0)** |
| 06 D7 argument injection (bound vars) | `leakprobes/injection/` | probe pending compiler |
| 06 D8 language-tag negotiation | `shards/multilang/` | shard pending |
| 06 D9 DISTINCT on binding-set | `shards/graphs/` (cross-graph duplicate) | shard pending |
| 06 D10 explicit graph constraint | `documents/*.graphql` → `expected/plans/*.json`: every IR node carries a non-empty `graphs` set (`urn:verax:shard:core`) + compiler test | **plan-backed (compiler v0)** |
| 03 enforcement rules 1–3 | `leakprobes/filtering/`, `leakprobes/probes/` | probes pending M2 |
| 03 `@maxDepth`/`@budget` rejection | `leakprobes/cost/` | probe pending compiler |
| 08 single-plan execution | `documents/*.graphql` → one plan per document (`expected/plans/`, stem-to-root layout); adapter execution pending | **plan snapshots landed**; executor pending |
| 09 L0 adapter parity | reference adapter (`@verax/adapter-reference`) now *defines* L0 semantics over the core shard; response snapshots minted there; SPARQL HTTP adapter must match to claim L0; ×3-store harness pending | **semantics defined; parity harness pending** |

## Shard inventory

- `shards/core/` — Person/Organization/Publication; single-valued types, optional
  properties, empty-list and no-affiliation edge cases. **First gold shard — the full
  snapshot trio landed (M1 slices 1–3): `expected/sdl/` + `core.map.json`,
  `expected/plans/`, `expected/responses/` (variables recorded per snapshot).
  The compile→evaluate→respond path is green end to end over the reference adapter.**
- `shards/typing/` — multi-typed entities, unions, interface hierarchies, blank nodes (pending)
- `shards/multilang/` — rdf:langString coverage (pending)
- `shards/graphs/` — named-graph scoping, cross-graph duplicates (pending)
- `shards/pagination/` — cursor stability, ordering keys (pending)
- `shards/federation/` — SERVICE stub endpoint for CI (pending)
- `shards/perf/` — ~250k-triple scale shard, perf runs only (pending)
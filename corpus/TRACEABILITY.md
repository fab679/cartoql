# Corpus Traceability (docs/09 rule)

> Every normative rule maps to at least one fixture. A spec edit (docs/02–08)
> without a new or adjusted fixture is an incomplete PR.

| Spec rule | Shard / fixture | Status |
|---|---|---|
| 06 D1 blank-node skolemization | `shards/typing/` | shard pending |
| 06 D2 default page size (20) | `shards/pagination/` | shard pending |
| 06 D3 decimal → string scalar | `shards/core/` + typing shard extension | pending (add schema.ttl with a decimal field) |
| 06 D4 multi-typed → union fallback | `shards/typing/` | shard pending |
| 06 D5 inverse fields (off by default) | `shards/core/shapes.ttl` (`sh:inversePath` on PublicationShape.authored) | fixture pending generator |
| 06 D6 canonical ordering key | `shards/core/data.ttl` (authored list ≥3 on person-ada) + `shards/pagination/` | fixture pending generator |
| 06 D7 argument injection (bound vars) | `leakprobes/injection/` | probe pending compiler |
| 06 D8 language-tag negotiation | `shards/multilang/` | shard pending |
| 06 D9 DISTINCT on binding-set | `shards/graphs/` (cross-graph duplicate) | shard pending |
| 06 D10 explicit graph constraint | all shards (module datasetScope) | fixture pending compiler IR |
| 03 enforcement rules 1–3 | `leakprobes/filtering/`, `leakprobes/probes/` | probes pending M2 |
| 03 `@maxDepth`/`@budget` rejection | `leakprobes/cost/` | probe pending compiler |
| 08 single-plan execution | `shards/core` reference documents → `expected/plans/` | snapshot pending compiler IR |
| 09 L0 adapter parity | all shards × ≥3 stores | harness pending adapter |

## Shard inventory

- `shards/core/` — Person/Organization/Publication; single-valued types, optional
  properties, empty-list and no-affiliation edge cases. **The first gold shard; its
  `expected/` snapshots land together with the generator's first output (M1).**
- `shards/typing/` — multi-typed entities, unions, interface hierarchies, blank nodes (pending)
- `shards/multilang/` — rdf:langString coverage (pending)
- `shards/graphs/` — named-graph scoping, cross-graph duplicates (pending)
- `shards/pagination/` — cursor stability, ordering keys (pending)
- `shards/federation/` — SERVICE stub endpoint for CI (pending)
- `shards/perf/` — ~250k-triple scale shard, perf runs only (pending)
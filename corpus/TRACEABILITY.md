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
| 06 D7 argument injection (bound vars) | compiler rejects enum/list/object args; projection + bindings snapshots prove client values never enter SPARQL text (one recorded exception: LIMIT literal, validated integer, docs/07 T1); `leakprobes/injection/` fuzz set still pending | **projection-backed; fuzz probes pending** |
| 06 D8 language-tag negotiation | `shards/multilang/` | shard pending |
| 06 D9 DISTINCT on binding-set | `shards/graphs/` (cross-graph duplicate) | shard pending |
| 06 D10 explicit graph constraint | `documents/*.graphql` → `expected/plans/*.json`: every IR node carries a non-empty `graphs` set (`urn:verax:shard:core`) + compiler test | **plan-backed (compiler v0)** |
| 03 enforcement rule 1 (stamping only) | generator stamps config → SDL `@requireGroup`; client-supplied registry directives reject wholesale (`VX_DIRECTIVE_REJECTED`, graphql `visit()` gate) — core/security.test.ts | **backed (M2 slice 1)** |
| 03 enforcement rule 3 (two-track) | `shards/sec/`: field denial → null + typed error (visible); entity gating → pre-window filtering, invisible≡absent pair assertions, empty-population scans, zero error entries — reference/security.test.ts | **backed (M2 slice 1)**; store-side (slice 2) below |
| Gateway auth wiring (docs/04 Path 2) | `--stamps` + `--auth-file` + `x-verax-principal` header; per-request views resolve fail-closed (resolveView); health declares the auth posture; gateway/security.test.ts over real HTTP — field denial codes, existence-blind entity gating, unknown-principal fail-closed, open-posture-without-authFile | **backed (M2 slice 3)** |
| @traversalScope (edge track, docs/03) | `onTraversal` stamps → @traversalScope on class fields → `traversal:` constraints — denied edges never materialize related entities with ZERO error entries (existence-blind), contrasted in-corpus with @requireGroup's visible denials; carol fixture (hr-comp without legal) demonstrates traversal-vs-entity distinction; v0 note: entity gating is root-level only (documented; nested type-gating = pending) | **backed (M2 slice 4)** |
| Nested entity gating (docs/07 hop parity) | itemTypeConstraints on class-field IR; nested items failing their type's stamps filter blind in BOTH adapters (previously a v0 root-level-only limitation, upgraded); carol fixture: traversal allowed, nested SensitiveNote items filtered; core + sec snapshots reflect the IR field | **backed (M2 slice 5a)** |
| Path-2 providers (docs/04) | jwt-groups (jose, HS256 or JWKS; deterministic claim-hash viewVersion as cache buster) + oidc-introspect (RFC 7662, injectable fetcher); resolveView fail-closed on every failure mode tested; gateway --jwt-secret with Authorization: Bearer passthrough — tampered tokens collapse to deny-all; precedence jwt > static > open | **backed (M2 slice 5b)**; live IdP validation pending |
| M2 constraint pushdown (store-side) | `shards/sec/acl.ttl` (membership facts; kernel-v1 vocabulary) + sparql-http gate injection: field gates wrap OPTIONALS, entity gates live INSIDE window sub-selects; live parity — 3 docs × 3 principals through both enforcement paths, data AND errors — sparql-http/security.test.ts + parity suite in CI | **backed (M2 slice 2)** |
| 03 `@maxDepth`/`@budget` rejection | `leakprobes/cost/` | probe pending compiler |
| 03 `@maxDepth`/`@budget` rejection | `leakprobes/cost/` | probe pending compiler |
| 08 single-plan execution | `documents/*.graphql` → one plan per document (`expected/plans/`, stem-to-root layout); adapter execution pending | **plan snapshots landed**; executor pending |
| 09 L0 adapter parity | reference adapter defines L0 semantics; sparql-http now *executes* end to end with live response-equivalence vs reference over Oxigraph 0.5.10 — deep-equal across all reference docs, page-through cursors, absent-entity shapes; parity suite in CI (services container + shard preloaded to named graph) | **backed, live in CI** |

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
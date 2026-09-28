# 08 — Performance Engineering

Performance is an M1 requirement, not a post-1.0 concern: an overlay that doubles
store latency gets disabled at the first production incident, and security compilation
un-affordable at scale gets ignored. This document defines the join strategy (the one
decision that dominates performance), the caches, the SLO targets, and the
load-testing method that gates each release.

## The one architectural decision: document-level single plan

GraphQL-over-RDF has two possible execution strategies:

| Strategy | What happens | Verdict |
|---|---|---|
| Resolver descent (n+1) | Each field independently fires a SPARQL query to expand its values | **Rejected.** n+1 over network graphs is the classic overlay failure; also *incompatible with plan-level security* — per-field resolvers can't carry document-wide cost or coherent permission views |
| **Document-level single plan** | The whole GraphQL document compiles to **one SPARQL query** (with OPTIONAL/BIND/property-path structured to mirror nesting), executed once, then shaped into the GraphQL response tree | **Chosen.** Enables: single permission view per request, whole-document cost analysis, whole-document caching, store-side joins into a single-round-trip pattern where stores can handle it |

Consequences (normative):
- The compiler emits **one SPARQL SELECT per document** by default. Sub-plans split
  only when the parent plan exceeds store-imposed limits or declares pagination
  boundaries (paginated fields generate a follow-on next-page plan keyed on its cursor —
  still single-plan per page slice).
- Response shaping happens **in the gateway** (JSON-LD shaping of the solutions set),
  never by re-querying per node.
- Where a backend can't express a document's full algebra in one query (adapter tier
  limitations), the **adapter, not the compiler, splits** — and adapter splitting rules
  are part of each adapter's conformance contract ([09](09-testing-conformance.md)).

(Where nested pagination within a single document would produce a cartesian-product
plan — e.g. two independent paginated lists under one parent — the compiler
automatically hoists each into its own plan split bound by the shared parent
identifier; the split rule ("pagination-splits") is itself spec'd as a cost-model
option, not an escape hatch: the permission view and cost check are re-applied per
split before execution of any of them.)

## Join strategy per requirement

- **Per-hop structure**: compile node-expansion as nested `OPTIONAL` patterns with
  explicit graph constraints (06/D10) to permit shape-compatible placement in a
  single-SELECT plan.
- **Fan-out batching**: selections at the same level over the *same parent binding*
  share pattern groups; SPARQL-level index hints are adapter-tier, never semantically
  mandated.
- **Aggregation** (grouped counts, cross-domain summaries): compiled to SPARQL
  aggregate functions; aggregation fields are cost-band-3+ and require explicit
  shape annotation (checked by cost linting).
- **Adaptive hints**: tier-2 adapters may supply store-specific execution hints (e.g.
  pre-materialized orderings, `GROUP BY ?parent` streaming shapes); hints are optional,
  off by default, and never semantically load-bearing.

## Cost model (the `@budget` formula)

Document cost = sum over field occurrences of `fieldCost(field)`, where:

```
fieldCost = fieldWeight                        # module-configurable, default 1
           × (1 + 0.3 × hopsBelow)              # per-level compounding, bounded by @maxDepth
           × listFactor                         # 2 for list-typed/paginated fields, else 1
           × filterFactor                       # 1 + 0.25 × argumentCount (argCount capped at 8)
           × strategyCost                       # per @redactWith strategy (e.g. COUNT_ONLY = 1.5)
           + serviceWeight                      # × declared SERVICE endpoints (federated subplans)
           + probePenalty                       # +4 per generic graph-probe field (uncertain shape)
```

Constants are **configurable and versioned as the cost-model schema** — not magic
numbers — and the formula, defaults, and version are printed in `explain` output so
clients can understand a rejection and self-fix (better tickets by far). Cost budgets
are an upper-bound control, not a data contract: cost is always re-derived at
execution time so a budget mismatch can never corrupt results, only reject them.

Caches (all measured, all alerting-observable):

| Cache | Key | Invalidation mechanism |
|---|---|---|
| SDL module set | module content hash + generation options | publish-time — new version swap |
| Plan cache | `(schemaVersion, documentShape, permissionViewVersion)` | schema bump or permission view bump |
| Shape-validation cache | SDL schema hash | schema swap only |
| Result cache (optional, embedder-enabled) | plan cache key + page boundary | see below |

**A result cache, if enabled by the embedder, keys additionally on the resolved
permission view.** Result caching is **off by default**: for write-heavy or
privacy-sensitive deployment defaults it's both wrong-dangerous and a value
additive only in anchored-use read-only scenarios. The config for it exists so
adopters can make the call, not because Verax defaults to it.

## SLO targets (reference hardware: 8 vCPU/16 GB gateway, tier-L1 co-located store)

| Workload | p50 | p99 |
|---|---|---|
| Single-entity + 2-level expansion, ≤ 12 fields | < 150 ms | < 600 ms |
| Paginated list (default 20) with ordering | < 200 ms | < 800 ms |
| 3-level nested document, 60 fields, ≤ 30 entities | < 500 ms | < 2 s |
| `SERVICE` federation (each additional endpoint adds latency) | (< peripheral store p50) + 50ms | — |

These targets inform, not define: adopters deploy on varied infrastructure. CI
performance regression tests **run per release** against the fixture corpus
on reference-configured test stores (low noise, high signal — see [09](09-testing-conformance.md)),
recording numbers into the release log; drop > 15% in any band = investigation
required before tagging.

## Resource protection defaults (per configured gateway)

- In-flight request cap per store adapter type (default 64); requests beyond the cap
  are queued with `Retry-After` metadata surfaced through a typed error — never silently dropped
- Algebra node cap (dynamically expands with maxDepth but bounded hard at 2,500 nodes
  — beyond: `VX_QUERY_TOO_COMPLEX`)
- Execution timeout scales with plan complexity, not one blunt number: default
  budget `min(30 s, cost × 10 ms)` — a documented constant, not an incidental value
- Cancellation: when a client aborts, the gateway cancels the in-flight SPARQL request
  (adapter contract requirement — tier-2 adapters support native cancel; the default
  adapter falls back to connection close)

## What Verax does *not* promise (documented limits)

- No latency guarantee across `SERVICE` federation boundaries — the SLO table is
  explicitly single-store; federated deployments schedule face their own store owners
- No result freshness guarantees — the store is the truth; Verax adds zero freshness
  commitments beyond stale-view errors as spec'd
- No back-pressure scaling promises between the gateway and non-cooperating stores
  (adapter tier-2 can add store-side improvements but the baseline is honest networking)
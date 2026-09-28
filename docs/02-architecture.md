# 02 — Architecture

## Topology

```
┌─────────────────────────────────────── Verax Gateway ──────────────────────────────────┐
│                                                                                          │
│  SHACL shapes + ontology IRIs ──► [SDL GENERATOR] ──► versioned SDL sets                 │
│                                        │  (module composition, deprecation scaffold)     │
│  client GraphQL document ──► [GATEWAY]                                                  │
│       1 parse & document validation                                                      │
│       2 directive expansion (registry contract)                                         │
│       3 principal + permission resolution        ◄── SPI: PermissionResolver             │
│       4 algebra generation: constraint joins injected into EVERY field                  │
│       5 plan cost check (@budget/@maxDepth)          ── reject > threshold, typed error   │
│       6 [EXECUTOR] via SPI: StoreAdapter (SPARQL 1.1 default)                            │
│       7 response shaping (JSON-LD → GraphQL); error codes; audit hook SPI               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. SDL Generator

Input: one or more *ontology modules* (an RDF graph of classes/properties) plus a
set of **SHACL node shapes** describing the API-facing entity types.

Output: versioned SDL **module set** that mirrors ontology modularity:

- node shape → type; `sh:targetClass` → `implements` edge into a base `Entity`
  interface where applicable
- shape property constraints → fields: `sh:datatype` → scalar mapping,
  `sh:class`/`sh:node` → nested type (object property → a join hop in algebra),
  `sh:in` → enum
- `sh:minCount`/`sh:maxCount` → list-ness and nullability
- generator-provided annotations → directives (see 03) — *the only source* of
  security directives is this stamping step
- renamed/retired terms (from the changelog graph) → `@deprecated` + migration note

Versioning: an SDL set version is bound to the ontology/graph versions that produced
it (`schema v(n) ← ontology v(n)`); regeneration is pure function; a divergence between
served SDL and source graphs is a build failure, not a support ticket.

### 2. Compiler (the security-critical core)

Pipeline stage 4 is where constraints enter. Concretely, for each selection field
whose definition carries directives, the compiler appends the translated constraint
into the field's algebra subtree:

```
@scope(FIELD)                   →  permission-join on the field triple pattern
@traversalScope(on: p)          →  edge-visibility join on the hop triple
@tenantScoped/graphSet(...)     →  GRAPH constraint on allowed named graphs
@requireGroup(g) / @role(r)     →  principal-claim join via PermissionResolver result
@redactWith(strategy)           →  chooses aggregate/curated variant of the subtree
@minConfidence(v)                →  path-filter against statement metadata (if present)
@provenance                       →  attaches run/grounding bindings to the output shape
@budget(c)/@maxDepth(n)          →  plan-cost metadata, checked stage 5
```

Invariants enforced by construction in the compiler:

- **monotonic constraint set** — no code path removes a constraint added by a directive
- **no direct resolver execution** — a compiled plan is the only artifact executed;
  the executor runs plans and never receives ASTs
- **existence-blind errors on join/probe paths** vs. visible denial on explicit
  selections — two distinct code paths, tested separately
- caching must key on `(schemaVersion, documentShape, permissionViewVersion)`, never
  on principal identity alone; plan reuse across different principals is only legal
  keyed by the *resolved permission view version*

### 3. Directive registry

A declarative contract (03) + implementation table in the compiler. Extensions
(third-party directives) are possible only via the *compiler-plugin interface*, which
must emit algebra constraints — plugins cannot inject resolvers or arbitrary code
into execution (no plugin is trusted with data access).

### 4. SPI surface (the OSS-ification seam)

Verax core owns the *mechanics*; each embedder owns the *policy*:

| SPI | Cb/shape | Default (standalone mode) |
|---|---|---|
| `PermissionResolver` | `resolve(principal, request, schemaVersion) -> {permissionView(semantics: per-claim), viewVersion, staleACL: boolean}` | a permissive/resolved-immediately view (plain-store mode, no ACLs) |
| `StoreAdapter` | `execute(sparql, plan, namedContext) -> solutions` | SPARQL 1.1 HTTP (works against Jena/Fuseki, GraphDB, Virtuoso, Oxigraph, etc., out of the box) |
| `DocumentSourceResolver` | `getDocument(documentContext)` — for persisted-query or schema-slicing mode | local persisted-query table |
| `ProvenanceModel` | `bindingFor(solution) -> {runId, grounding[], confidence?}` or `null` (no provenance information) | `null` — entire provenance feature disabled cleanly |

A single *embedder pipeline* might implement all four SPIs (KMap does — see
[04-integration.md](04-integration.md)); a standalone user implements none and gets
the plain mode: types, queries, federation, no security semantics.

### 5. Executor & backend adapters

SPARQL 1.1 is the minimum baseline; adapters add capability tiers:

| Adapter tier | Capability | Notes |
|---|---|---|
| 0 — SPARQL HTTP | SELECT/CONSTRUCT, SERVICE federation, basic perf | *the baseline — compatible with every store* |
| 1 — planning metadata | EXPLAIN / cost introspection | enables finer `@budget` calibration |
| 2 — native | store-specific fast paths (SPARQL-star, named-graph catalogs) | optional, never semantically distinct |

Anchor rule: the default adapter's semantics is *the* semantics; native adapters must
match output behavior exactly (contract tests run the same fixture set cross-adapter).

### 6. Federation interface

Apollo subgraph-compatible shape with caveats from the spec (03): `@key` on IRI
(per-hub), representative requests must arrive with forwarded auth context (else
fail-closed), and *entity join/probe* responses use existence-blind hiding, not
visible errors — by federation-gateway nature these requests are programmatic and
spec'd to hide invisible entities. Composite graph boundaries (never across
distinct security domains — an embedder-level constraint the docs call out) are
expressed as `graphSet` named-graph unions within one served schema.

## Repository layout (target code shape)

```
verax/
  packages/
    core/            compiler, algebra, directive registry, cost models, error codes
    generator/       SHACL/ontology → SDL, deprecation scaffolding
    adapters/
      sparql-http/   default SPARQL 1.1 StoreAdapter
      (future native adapters)
    gateway/         HTTP service, introspection scoping, persisted queries, weaving executor
    plugins/         directive plugin surface (third-party directives via algebra-only contract)
    testkit/         fixture contract-test harness; permission GraphQL fixture arm (NST harness)
  docs/              this spec
```

TypeScript / Node LTS is the implementation language: `graphql-js` parse/validate
primitives, mature federation compatibility tooling, and the widest OSS-API-adoption
reach for a service meant to be embedded behind other stacks (embedder language
doesn't matter for a gate-way sidecar — KMap, Python-based, consumes the service).

No globals/ambient dependencies; `verax` error prefix and IRI namespace live behind
a single exported constant, honoring the rename policy (01).
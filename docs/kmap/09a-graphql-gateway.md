# 09a — GraphQL Gateway (KMap's own GraphQL-over-RDF)

> **Extraction note (2026-09):** the gateway's *mechanics* are being extracted into a
> standalone open-source project (**Verax**, Apache-2.0 — repo sibling to this one:
> `../cartoql/`). Verax owns the generator, compiler, directive registry, and the four
> SPIs ([PermissionResolver / StoreAdapter / DocumentSourceResolver / ProvenanceModel]);
> KMap becomes its first **platform embedder** (Verax integration guide (`../04-integration.md#path-3--platform-embedder-the-kmap-case`)),
> implementing the SPIs against its own permission kernel, stores, and provenance model.
> **This document remains KMap's integration spec** — which directives get stamped,
> which policies drive them, versioning windows, and KMap-specific invariants
> (e.g., the cross-tenant prohibition). Where the two differ, Verax's spec is the
> generic contract and this doc is the deployment. Error codes map: Verax `VX_*` →
> KMap plans surface them namespaced as `KM_*` with KMap extensions.

KMap ships its **own GraphQL-over-RDF gateway**: a schema generator, a compiler, and a
directive registry that together turn the tenant's active ontology into a typed,
versioned, **security-compiling** API surface. We own it because the two things that
matter most to us — permission parity ([07](07-security-tenancy-privacy.md#the-permission-model))
and ontology-versioned contracts ([04](04-ontology-strategy.md)) — have no off-the-shelf
equivalent; bolting them onto a third-party translator (GraphQL-LD, HyperGraphQL,
vendor endpoints) means fighting their pipeline at every security-critical seam.

Sizing: roughly 2–3 months of one senior pair to v1 (see [build plan](#build-plan)).
Strategic note recorded in [10](10-roadmap.md): a candidate for open-sourcing as an
independent component post-v1 — generally useful to the RDF community, exposes none
of our client ontology work, and pulls mindshare to the layer where our moat lives
(the security compilation step).

## Positioning across the API plane

The gateway is one of four read surfaces sharing **one permission-aware query planner**:

```
agent tools (08) ──┐
REST /v1 (09)    ──┼──►  permission-aware planner  ──►  graph store / vector index / BM25
MCP server (09)  ──┤          (single security kernel)
GraphQL gateway ──┘   ◄── this document
```

Rule of planes: **the compiled output is the thing that runs.** Per-field resolver
functions with their own ad-hoc query logic are forbidden; every GraphQL field
resolves through compiled, ACL-joined query plans produced by this gateway and executed
by the planner. One kernel, four transports.

## Lifecycle: generation, not mapping

No hand-written GraphQL schemas, no hand-maintained JSON-LD context files — those are
the rotting artifacts that motivated owning this layer. The SDL is a **build artifact
of ontology publication**:

```
ontology draft → review gate → TBox v(n) published   (04)
        └─ SHACL shapes published
             └─ SDL schema REGENERATED from shapes      (this doc)
                  ├─ types from node shapes (minCount/maxCount → nullability/lists)
                  ├─ directives STAMPED by the generator from ACL metadata
                  ├─ deprecated fields for renamed/removed terms (migration notes)
                  └─ SDL version registered, change event emitted via webhooks (09)
```

Consequences worth stating once, explicitly:

- The GraphQL contract is **exactly as current and as reviewed as the ontology** —
  same provenance chain, same human gates, same version numbers.
- Additive ontology changes → additive SDL fields (non-breaking). Breaking changes
  ride the ontology review gate and the API overlap policy (12-month support, [09](09-api-plane.md#cross-cutting-api-standards)).
- Regeneration is mechanical; if the generated artifact diverges from the TBox, that is
  a build failure, not a support ticket.

## Architecture

```
                    ┌──────────────────────────────────────────────┐
 active TBox v(n) ─►│ SDL GENERATOR                                │
 + SHACL shapes     │  shapes → types; SHACL counts → nullability;  │
                    │  property ranges → field types; ACL stamps → │
                    │  directives; renamed terms → @deprecated      │
                    └───────────────────┬──────────────────────────┘
                                        │ versioned SDL set
                                        ▼
 client ── GraphQL query ──► GATEWAY
                    ┌──────────────────────────────────────────────┐
                    │ 1 parse + document validation                 │
                    │ 2 DIRECTIVE EXPANSION (registry, below)       │
                    │ 3 effective-permission resolution (user ctx) │
                    │ 4 algebra: ACL joins injected into EVERY field │
                    │ 5 plan cost check (@budget/@maxDepth; reject  │
                    │   > threshold with typed error)               │
                    │ 6 execute via the permission-aware planner     │
                    │ 7 shape JSON-LD → GraphQL response;           │
                    │   errors carry stable codes, never messages   │
                    └──────────────────────────────────────────────┘
```

## The directive registry (v1)

Directives are **stamped by the generator** onto the SDL from governance metadata.
They are *enforcement points, never grants* (see [rules](#the-three-enforcement-rules)).

### Schema-shaping directives (generator-stamped, per-field)

| Directive | SDL | Meaning in the compiled plan |
|---|---|---|
| `@tenantScoped` | `on OBJECT \| FIELD_DEFINITION` | binds every algebra node in the document to the caller's tenant graphs (`<tenant>/abox/…` only); no cross-tenant IRIs resolve at all |
| `@scope(level)` | `on FIELD_DEFINITION`, `level ∈ {CLASS, FIELD, EDGE, SCHEMA}` | joins the principal's effective permissions at the declared granularity; CLASS = entity visibility, FIELD = property-level (row-level security analog), EDGE = relationship-level |
| `@traversalScope(on)` | `on FIELD_DEFINITION` | hop-level ACL: an edge expands only if *the edge itself* is visible — entities reachable only through hidden edges stay hidden ([07](07-security-tenancy-privacy.md#the-permission-model) rule 3, compiled) |
| `@hiddenUnless(scope)` | `on FIELD_DEFINITION` | field renders (non-null) only within the scope; outside it, resolves to `null` + an error-code **only** when the field was explicitly selected-and-denied (see [fail-closed](#the-three-enforcement-rules)) |
| `@requireGroup(group)` | `on FIELD_DEFINITION` | **business-role gate**: concrete client group (e.g., `hr-comp` for compensation facts); groups are synced from the client IdP/source ACLs ([07](07-security-tenancy-privacy.md#identity)) — consumed, never authored by us |
| `@requireRole(role)` | `on FIELD_DEFINITION` | **platform-role gate** (`tenant-admin`, `reviewer`, `member`, `api-app`, `auditor`): console/admin semantics only. Platform roles can never grant business visibility (admin ≠ reader) |
| `@minConfidence(v)` | `on FIELD_DEFINITION` | facts below the extraction-confidence threshold render as review-pending placeholders, not as asserted values ([06](06-semantic-infrastructure.md#what-every-published-triple-carries)) |
| `@redactWith(strategy)` | `on FIELD_DEFINITION` | partial-visibility strategies (aggregate-count only, date-rounded, nullify-with-count) for fields where full reveal fails the ACL join but aggregate visibility passes |
| `@provenance` | `on FIELD_DEFINITION` | output struct includes `prov:wasGeneratedBy` (run IRI) and `kmap:sourceAt` grounding for the selected fact(s) — payload form guarantees citation-ability for any client ([08](08-retrieval-and-agents.md#citations--highlights)) |
| `@maxDepth(n)` | `on FIELD_DEFINITION` | nesting cap on this field's subtree, checked post-parse before execution |
| `@budget(cost)` | `on FIELD_DEFINITION` | per-field complexity weight; the request gets a compiled **plan-cost budget** and is rejected with a typed error if exceeded |

### Client-usable directives

Clients may use **only** the GraphQL spec directives (`@include`, `@skip`) and any
future KMap *ergonomic* directives that carry zero security semantics (e.g., a future
`@totalCount` on list fields — explicitly computed over the visible set only).
Security-set directives **may not be sent meaningfully in documents**: any client-supplied
instance of a registry directive on a query/fragment is **rejected with a typed error**,
not ignored — silently ignoring them invites "why is my @scope not working" tickets
and worse, false confidence.

## The three enforcement rules

1. **Directives are enforcement points, not grants.** All security directives are
   stamped by the generator from ontology ACL metadata at publish time; clients cannot
   add, remove, or satisfy them from the query side. The compile step only ever *adds*
   constraints to the algebra — there is no code path that relaxes one. Policy is
   declared by governance artifacts ([04](04-ontology-strategy.md), [07](07-security-tenancy-privacy.md)),
   never requested by the caller.
2. **Everything compiles through the single permission-aware planner.** Compiled
   SPARQL algebra with ACL joins in the plan is the only execution route (the same
   kernel REST/agents/MCP use). No side resolvers, no BFF shortcuts, no "just this
   once" read paths — a per-field exception would be the hole the audit finds next quarter.
3. **Fail closed, visibly:** unknown directive, unresolvable scope, ACL version older
   than SLA, planner error → the affected field resolves to `null` **plus a stable
   error code** in `errors[]` when the field was explicitly selected by the caller.
   Silently omitting deny-by-failure is forbidden (indistinguishable from non-existence
   is *correct* for filtering, but never for degraded-ACL failure); the codes are
   contract (below).

## Error codes (contract, branch on these, never on messages)

| Code | Meaning | Client action |
|---|---|---|
| `KM_PERMISSION_DENIED` | field/edge selected, visible-class check failed | none expected; UI hides gracefully |
| `KM_PERMISSION_STALE` | ACL sync older than SLA for the deciding source | retry after sync; surface "partial stale data" posture |
| `KM_SCOPE_UNRESOLVED` | principal/scope resolution failed | reauth; contact admin if persistent |
| `KM_QUERY_TOO_COMPLEX` | plan cost over budget / depth over cap | narrow the selection or paginate |
| `KM_DIRECTIVE_REJECTED` | client supplied a registry directive | remove it; it's server-side |
| `KM_ONTOLOGY_STALE` | schema version no longer served (beyond overlap window) | migrate; changelog link in the error extensions |
| `KM_PARTIAL_STALE_SOURCE` | answer depends on a source beyond its freshness SLA | flag the data age in UI |

Every error carries `extensions.tenant`, `extensions.schemaVersion`, and where useful
`extensions.source`/`extensions.ontologyDiff` pointers — clients can *prove* what
they saw, same posture as agent citations.

## Roles & access levels

Roles enter the compile through **one channel**: effective-permission resolution
([07](07-security-tenancy-privacy.md#the-permission-model) step 1) — directives are
inputs to that resolution, never a parallel security mechanism.

| | Platform roles (KMap-owned, fixed set) | Business roles (client-owned) |
|---|---|---|
| Examples | `tenant-admin`, `reviewer`, `member`, `api-app`, `auditor` | "sales-manager", "hr-comp", "legal" |
| Source | product definition | client IdP groups + source ACL roles, synced (SCIM/ACL extraction) |
| Governs | console powers: review queues, budgets, audit access, source registry | fact visibility: entities, fields, hops |
| Directive | `@requireRole` | `@requireGroup` |

Invariants:
1. Business roles are **consumed, never authored** by the platform — the client IdP is
   source of truth; a group rename there syncs through, no mapping file to maintain
   (same anti-rot principle as the SDL generator).
2. Platform roles never grant business visibility — `tenant-admin` outside `hr-comp`
   gets `null` + `KM_PERMISSION_DENIED` on compensation fields, same as anyone
   ([07](07-security-tenancy-privacy.md#the-permission-model) rule 5).
3. Role hierarchies (manager ⊒ member) are the client's structure — synced as group
   relations, resolved per request, cache-versioned by ACL version. **No role rule is
   ever evaluated at compile time** where it could go stale.
4. Agents inherit the acting user's business roles; their platform role is fixed
   (`member`-class) — an agent never holds `reviewer` or `tenant-admin`.

## Namespaces & composition

GraphQL has no native namespace construct; KMap gets namespaces through composition,
which mirrors the ontology's modularity ([04](04-ontology-strategy.md#two-layer-strategy-fixed-core-per-client-domain-extensions)):

- **SDL sets are composed from modules**: `core module (product-owned) + one module
  per client domain extension`, each versioned exactly like its TBox counterpart
  (core version, domain version — independently). Type names are prefixed per
  module (`FreightcoShipment`); the boring collision answer is standard practice and
  harmless since clients consume via SDKs/persisted queries.
- **The semantic namespace never disappears**: every field maps to a full IRI;
  introspection and deprecation messages carry it, so the RDF namespace survives even
  where GraphQL display names flatten.
- **Principal-scoped virtual namespaces**: composed schema sets are sliced per
  consumer — an app registered (via persisted queries) against only the freight
  domain is served exactly `core + freightco` modules. Enforced by introspection
  scoping (below), not cosmetic naming. A(slice) ≠ B(slice) is a *feature*: it makes
  blast radius of an ontology change analyzable per consumer.

## Federation

The word means two different things here; both have a place, with one hard rule.

**SPARQL federation (RDF-native) — supported from v1.** The `SERVICE` clause lets
compiled plans join across graph sets *within a tenant* (e.g., current ABox vs.
archived partitions; the control store vs. the TBox registry). This is a query-planner
feature ([06](06-semantic-infrastructure.md#core-query-surfaces)), not a new API surface.

**GraphQL federation (subgraphs) — Mode A (v2 candidate): KMap as a subgraph in the
client's supergraph.** Their gateway composes their internal APIs with us.

- Keying is natural because federation joins entities by globally-unique key and our
  entity IRIs already are that: `@key(fields: "iri")` maps 1:1.
- Security conditions (all mandatory, none optional):
  1. **Auth forwarding**: federation representative requests carry no user context by
     default; the composing gateway must forward the acting identity on every
     representative, or the subgraph answers fail-closed (`KM_PERMISSION_DENIED`).
  2. **Join probing hides, never errors**: a foreign gateway probing by key receives
     indistinguishable nulls for invisible entities — joins are explicitly *exempt*
     from the "explicitly-selected denial" error semantics ([rules](#the-three-enforcement-rules)
     rule 3): hidden entities hide; they don't announce themselves in `errors[]`.
  3. Plan-cost budgets (`@budget`, `@maxDepth`) apply per representative request.
  4. Version coupling: the client's supergraph pins one of our schema versions for
     its lifetime; overlap policy ([09](09-api-plane.md#cross-cutting-api-standards))
     governs migrations.

**Mode B (permitted): composing multiple KMap graph sets within one tenant.**

**Hard rule / architectural invariant: no document, composition, or plan ever spans
two tenants' graphs.** The gateway composes by `{tenant, partition}`; no code path
expresses a cross-tenant document. Recorded here explicitly because this is exactly
the kind of constraint a future enterprise feature request ("just this one joint
query across our subsidiaries' tenants") will pressure an engineer to soften — the
answer is separate tenants with client-approved ontology sharing, or nothing.

## Versioning & deprecation

- SDL sets are versioned identically to the TBox that generated them (`schema v(n) ← ontology v(n)`).
- Deprecations are generated: renamed domain property → old field marked `@deprecated`
  (with migration note = ontology changelog entry), served through the full 12-month
  overlap window ([09](09-api-plane.md#cross-cutting-api-standards)) then removed with
  `KM_ONTOLOGY_STALE`.
- Introspection is **principal-class scoped**: client apps see their served schema;
  admin/monitoring principals see deprecation and directive metadata; anonymous
  introspection is off. No schema detail is exposed that a principal couldn't query anyway.

## Security testing for this layer

- The tenant permission test suite ([07](07-security-tenancy-privacy.md#verification))
  gains a **GraphQL arm**: every must/must-not-see fixture runs as a GraphQL document
  and as a REST call (same fixtures, two transports — drift between surfaces is a bug).
- Directive registry changes require: negative probes (attempted client-supplied
  directives, denied), replay of all prior compiler versions on captured query sets
  (compile-output must not silently change semantics), and a review by whoever owns
  the security kernel.
- Fuzzing: malformed/algebra-warping documents (deep nesting, duplicate field names in
  different fragments, alias storms) against the cost checker.

## Operational notes

- **Persisted queries supported from v1** (client registers a document hash; production
  execution only accepts registered IDs): DoS surface reduction, plan-cache friendly,
  and clean audit story ("tenant X ran registered query Q-17 for user Y").
- Query logging: document shape (not raw arg values for sensitive fields), plan cost,
  execution time, permission version used — feeds the tenant audit log ([07](07-security-tenancy-privacy.md#audit--monitoring)).
- Plan cache: keyed `(schemaVersion, documentShape, effectiveACLVersion)` — cache hits
  never span ACL versions, so an access change invalidates instantly and correctly.

## Build plan

| Stage | Scope | Est. | owner pairing |
|---|---|---|---|
| G1 | SHACL → SDL generator + deprecation scaffolding + CI contract tests | 2–3 w | graph engineer + full-stack |
| C1 | Parser/validator → algebra with injected ACL joins; run through planner | 4–6 w | graph engineer + agent/infra engineer (security-critical work) |
| D1 | Directive registry v1 (table above) + expansion pass + error codes | 1–2 w | with C1 |
| V1 | Versioning machinery, introspection scoping, persisted queries | 1–2 w | infra |
| H1 | Complexity fuzz, permission GraphQL-arm fixtures, negative probes | continuous from C1 | security ritual ([07](07-security-tenancy-privacy.md)) |

Sequencing note: G1 can start as soon as core-ontology SHACL shapes exist (Phase 0,
[10](10-roadmap.md#phase-0--foundations-weeks-04-overlaps-with-pilot-prep)); the gateway
first serves clients in **Phase 2** — the pilot (Phase 1) needs agents + REST only, so
the gateway build happens alongside production hardening without blocking the design
partner.

## Out of scope for gateway v1 (tracked, deliberately deferred)

- Subscriptions / live views (webhooks already cover change events, [09](09-api-plane.md#webhook-events-v1-schema)).
- GraphQL federation **Mode A** (KMap-as-subgraph): conditions spec'd above; build only
  when a design partner's supergraph use case justifies it. SPARQL federation is *not*
  deferred — it's a planner capability from v1.
- Client-defined custom directives (would require a full policy-review pipeline to be safe).
- Mutation surface (the graph is ingestion-writable only, by platform invariant,
  [06](06-semantic-infrastructure.md#what-this-layer-refuses-to-be)) — requests for
  write-shaped GraphQL features route to the client-journey review-gate pattern instead.
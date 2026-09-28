# 05 — Roadmap

Milestones ordered so that **each one is independently shippable and useful**, and the
first one requires no security story at all — a GraphQL endpoint anybody can run against
their SPARQL store today.

## M0 — Spec complete + skeleton (now)

- [x] Directive & error contract ([03](03-directive-spec.md))
- [x] Architecture & SPI definitions ([02](02-architecture.md))
- [x] Integration paths ([04](04-integration.md))
- [ ] Repo skeleton: `packages/` layout, CI, Apache-2.0 headers
- [ ] Fixture corpus: a small reference ontology + SHACLE shapes + expected SDL
      (the "gold shard" tests validate against; serves as the spec's executable twin)

## M1 — Universal GraphQL endpoint (the "anybody can use it" release)

**Goal:** `npx verax-gateway serve --sparql … --shapes …` works against any SPARQL
1.1 endpoint, zero security config.

- SHACL → SDL generator (module composition, prefix handling, enum/list mapping,
  `@deprecated` scaffolding given a changelog graph)
- Parse → validate → algebra → SPARQL compile (no security directives yet; the
  *compiler slot* for them is in place and lints against the contract)
- SPARQL 1.1 HTTP `StoreAdapter` (tested across Fuseki, GraphDB, Virtuoso, Oxigraph
  via the fixture corpus)
- `@maxDepth`, document-level budget linting
- SPARQL `SERVICE` federation from declared endpoints
- Playground, `/schema/sdl`, schema-hash-pinned versioning
- **Shipped artifact**: npm package + Docker image + 5-minute quickstart tutorial

**Done when:** three external testers each stand up the gateway over a public
endpoint (e.g., DBpedia, Wikidata) with different shapes and get typed, versioned
GraphQL working without filing issues. Non-functional gates: single-plan execution
demonstrated ([08](08-performance-engineering.md)); SLO bands recorded; injection
fuzz suite seeding from [06](06-semantic-mapping.md) D7 rules.

## M2 — Security compilation kernel

**Goal:** directives become real constraints; permission providers plug in.

- Directive registry v1 implementation (`@scope`, `@traversalScope`, `@requireGroup`,
  `@requireRole`, `@graphSet`, `@redactWith`, `@maxDepth`, `@budget`)
- Security stamping pipeline (generator-time, from stamping config), rejection of
  client-supplied registry directives (`VX_DIRECTIVE_REJECTED`)
- Monotonic-constraint compiler invariants + two-track failure semantics
  (visible denial vs. existence-blind hiding) — the security-critical work; heavy
  contract-test emphasis (negative probes, probe-blindness fixtures, cost attacks)
- Built-in resolvers: `open`, `jwt-groups`, `oidc-introspect`, `file`
- Plan cache keyed `(schemaVersion, documentShape, permissionViewVersion)`
- Permission-fixture generator (`verax testkit --emit-fixtures`) — embedded
  platforms start their security tests from generated fixtures

**Done when:** the enforced-fixture suite passes against a reference "leaky" store
(the fixture corpus includes traps: existence-revealing counts, hidden-edge-only
paths, cross-graph traversal attempts), and an external security review of the
compiler lands without findings above medium.

## M3 — Provenance & confidence payload modes

- `@provenance`, `@minConfidence` with `ProvenanceModel` SPI; payload compile binding
- Provenance-mode feature flag: deployments without provenance metadata see the
  directives simply absent from generated SDL

## M4 — Federation & platform polish

- Apollo-federation Mode A (`@key` on IRI, auth-forwarding requirements,
  existence-blind joins, representative budgets)
- Principal-scoped schema slicing, persisted queries, introspection scoping classes
- Native adapter tier 2 (store-specific fast paths; adapter behavioral parity
  guaranteed by the corpus)
- The parking-lot directives (`@argSafe`, `@totalCount`, …) — each needs its
  leak-analysis design doc before entering the registry

## Standing engineering rules (all milestones)

- Spec-first development: any behavior change to 03 tables requires the doc PR merged
  before the implementation PR.
- Registration of new directives enforces the parking-lot review (leak analysis,
  cost semantics, deprecation path from birth).
- No resolver-mode escape hatch ever ships "temporarily" — the one-execution-artifact
  rule has survived every deadline pressure so far and stays that way.
- The KMap embedder is a *consumer*, not a spec driver: its needs inform proposals,
  but every KMap-motivated feature enters the spec only in deployment-neutral form.

## Success signals (checked quarterly)

- M1: npm installs by non-contributors; issues filed by people who found the gateway
  without knowing us
- M2: at least one external deployment powering ACL-sensitive data
- Either: someone contributes a `StoreAdapter` for a store we didn't test — the
  adapter tier contract is doing its job
- KMap integration upgrade cost per Verax minor release ≈ an afternoon (the
  SPI discipline is working)
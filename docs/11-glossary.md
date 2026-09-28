# 11 — Glossary

| Term | Meaning |
|---|---|
| **Module** | one ontology + SHACL bundle passed to the generator; composes into a served SDL set |
| **SDL set** | the generated GraphQL schema, versioned as a unit; mirrors the input graphs' version |
| **Stamping** | the generator-time act of writing security directives onto SDL from governance/ACL metadata — the only place security directives ever originate |
| **Algebra / IR** | the compiler's portable JSON intermediate (ADR-1): nodes carrying triple patterns, graph constraints, and injected security constraints; SPARQL is a projection of it |
| **Plan** | the executable artifact produced by compiling a document + resolved permission view; the only thing that runs (one-execution-artifact rule) |
| **Permission view** | the principal's resolved claim/scope set returned by the `PermissionResolver` SPI, versioned so caches key correctly |
| **Permission view version** | the cache-buster for plans and cursors: an ACL/group change bumps it, invalidating cached plans and stale cursors |
| **Existence-blind hiding** | probe/join/federation paths return results indistinguishable from empty — no error, no partial shape hint |
| **Visible denial** | explicitly-selected fields that resolve denied return `null` + a typed error — the *other* failure track (they are two separate mechanisms on purpose) |
| **Directive registry** | the normative table in [03](03-directive-spec.md); the project's "constitution" |
| **Gold shard** | a small, snapshot-tested corpus unit (ontology + shapes + data + expected SDL/plan/response) |
| **Leak probe** | a fixture *pair* (probe principal vs. control principal, same document) asserting no existence/channel leak |
| **Conformance level (L0/L1/L2)** | adapter certification: compatible / plan-introspecting / native-optimized — from [09](09-testing-conformance.md) |
| **Cost model** | the versioned formula + constants behind `@budget` and `@maxDepth` ([08](08-performance-engineering.md)) |
| **`SERVICE` federation** | SPARQL-endpoint federation via the `SERVICE` clause, from a static config allowlist (never client-supplied) |
| **Federation representative** | a subgraph request carrying entity representations (Apollo-federation Mode A); cartoql requires forwarded auth and gets existence-blind semantics |
| **Persisted query** | a client-registered document, hashed and pinned to a schema version; the production execution path |
| **Generic graph probe** | the shape-independent fallback field (root `entity`) for entities lacking covering shapes — scope- and cost-checked like any root |
| **Skolem IRIs** | deterministic IRIs minted for blank nodes so cursors and caching stay stable |
| **SPI** | the four embedder interfaces: `PermissionResolver`, `StoreAdapter`, `DocumentSourceResolver`, `ProvenanceModel` |
| **Standing graph constraint** | every algebra node carries an explicit named-graph constraint (D10) — there is no implicit "whatever graph" |
| **Parking lot** | the [03](03-directive-spec.md) table where proposed directives wait for leak analysis, cost semantics, and a deprecation path before entering the registry |
| **`CQL_*`** | the error-code prefix (remappable by embedders, e.g. `KM_*`); codes are the contract, messages are logs |
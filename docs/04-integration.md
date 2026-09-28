# 04 — Integration Guide

Three adoption paths, in increasing commitment order.

---

## Path 1 — Standalone: a GraphQL API over a SPARQL endpoint (zero config)

The M1 target: *useful to everyone, security optional.*

```
$ npx cartoql-gateway serve \
    --sparql https://your-store.example/sparql \
    --shapes https://your-site.example/shapes.ttl \
    --ontology https://your-site.example/ontology.ttl
# → http://localhost:4000/graphql (playground served at /playground)
```

What you get:
- Generated SDL (`/schema/sdl`, versioned against shape/ontology file checksums: sums
  of your `--shapes`/`--ontology` files pinned in runtime; simple thin mode: options in
  a single `cartoql.json`)
- The full compile+execute path minus security directives (`@scope` etc. are absent —
  the generator skipped them because no security stamping config was provided)
- `@maxDepth`, `@budget`, `@redactWith` are *available* but not stamped; operators
  can pass `--lint-budget-limit N` to hard-cap any document
- Multi-module: pass additional `--shapes-file … --ontology-file …` bundles; modules
  compose with type-name prefixes (you declare them in SDL generation configs)
- Service federation via SPARQL `SERVICE` — config-driven endpoints (`--federated-query`
  list) allowed only when the target endpoint is declared in `cartoql.json` (no
  wildcard fan-out)

What you don't get in this mode (by design, not limitation): multi-principal
permissions, provenance payload fields, principal-sliced introspection. The tenant /
`@graphSet` mechanics require an embedder (Path 3) since they need graph naming and
policy sources.

---

## Path 2 — Services mode: security profiles + permission sources

For teams who *do* need permissions served over one store without embedding CartoQL in
a larger platform. You provide a **JSON permission-source config** and CartoQL handles
the rest:

```jsonc
// cartoql.json
{
  "modules": [
    { "prefix": "Person",   "shapes": "./person.shacl.ttl", "ontology": "./person-onto.ttl" },
    { "prefix": "Publication", "shapes": "./pub.shacl.ttl", "ontology": "./pub-onto.ttl" }
  ],
  "security": {
    "stamping": "./stamping.json",     // which fields/directives get stamped (generated or hand-authored)
    "resolver": {
      "type": "jwt-groups",             // built-in provider: JWT + a groups-claim
      "claims": { "principalField": "sub", "groupsField": "groups", "roleField": "role" }
    }
  },
  "protocol-overrides": { "overlapWindowMonths": 6 }
}
```

Built-in `PermissionResolver` providers at launch: `open` (standalone default),
`jwt-groups`, `oidc-introspect` (runtime token introspection against issuer),
`file` (static claims fixture — dev only). Anything richer (sync-from-IdPACL
federation like SCIM, database-driven claims) is a plugin or an embedder concern —
CartoQL's SPI is the extension point; the built-ins never pretend to replace company
directory systems.

*Operationally important:* standalone mode with `open`/`file` resolvers is a **dev /
public-open-graph posture**. The README quickstart says so, loudly: the gateway's
security value begins when a real resolver is configured, never by default declare.

---

## Path 3 — Platform embedder (the KMap case)

Embed CartoQL as the query plane of a larger system. CartoQL ships as a service
(sidecar / same-VPC deployment) or embedded in-process (TypeScript):

```
platform (any language)
  ├── ingestion pipeline          (platform-owned)
  ├── auth / directory / ACL sync (platform-owned — source of claims)
  ├── ontology publishing         (platform-owned review gates)
  └── CartoQL gateway sidecar ───── implements all four SPIs:
        PermissionResolver    → platform permission kernel (per-principal view versioning)
        StoreAdapter          → platform's graph store + vector index hybrid (still plan-first)
        DocumentSourceResolver → persisted-query registry (platform-managed)
        ProvenanceModel       → platform's statement metadata (run IDs, grounding)
```

Embedding contract (extracted from the KMap integration, [kmap docs 09a] for the
concrete instance):

1. The platform authors ontology modules + SHACL and publishes versions; CartoQL
   generates matching SDL and serves the composed slices per principal class.
2. The platform stamps security directives — from its own governance metadata — as
   part of the same publish pipeline. `@graphSet` is the isolation primitive: the
   platform binds each served schema to its tenant graph sets; cross-domain graph
   documents are unexpressible in the compiled algebra (repository-level invariant).
3. The platform's permission kernel returns a **versioned permission view** per
   request; CartoQL feeds `viewVersion` into every plan-cache key so an ACL change
   invalidates cleanly.
4. Provenance payloads are compiled, not fetched: integrators' claimed-vsproved
   data marks (`runId`, groundings) come from the samples' own bindings.
5. Federation Mode A (subgraph in the platform's customer-supergateway) follows the
   spec'd conditions in [03-directive-spec.md](03-directive-spec.md) — embedding
   platforms get auth-forwarding requirements, existence-blind joins, representative
   budgets enforcement for free.

This is the separation of duties' whole point: **mechanics here, policy at home.**
CartoQL core contains zero deployment-specific concepts — no "tenant," no "client,"
no "review queue." Matching error-code extensions (`CQL_*` + embedder extras
namespaced like `KM_*`...) do the crossing.

---

## Migrating from GraphQL-LD / hand-mapped layers

1. Keep your JSON-LD contexts: CartoQL can ingest them as *collateral*
   (`--context-map`) to auto-generate equivalent entity-compaction for JSON-LD
   response shaping — the context becomes an output artifact, not an input fixture.
   Check the generated SDL against your existing field names; prefix choices may
   need attention.
2. Port field-shaped queries 1:1 — GraphQL documents that worked against your old
   mapping still parse against the generated SDL where fields exist; missing fields
   usually indicate SHACL shape coverage gaps, which is the map-rot GraphQL-LD layers
   accumulate being *made visible*. Fill the shapes, not the mapping.
3. Add security after the port: stamping config marks groups onto fields; then
   re-run the permission-fixture suite that the testkit generates (`cartoql testkit
   shape-coverage … --emit-fixtures`) — an embedder's security tests start as
   generated fixtures, not blank-page rewrite.

---

## Deployment notes

- Single container, stateless (all state external: SPARQL endpoint, SDL module set,
  persisted-query registry) — one horizontalScaling knob; plan cache in-process.
- Set `CARTOQL_ERROR_PREFIX` if rebranding the `CQL_*` codes as part of a platform
  embed (embedder codes stay stable across CartoQL minor versions).
- Health endpoints report: SDL module versions served, resolver provider, adapter
  tier, and whether provenance mode is on — ops should never discover policy posture
  by accident.
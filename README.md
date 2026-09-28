# Verax

**GraphQL over RDF, compiled with a plan-level security kernel and
provenance-first semantics.**

> 📛 Verax is a working name (Latin: *truthful*). All identifiers keep the project
> renameable — see [docs/01-vision.md](docs/01-vision.md#name).

Verax turns any RDF graph — an ontology, a triple store, a SPARQL endpoint — into a
**versioned GraphQL API**, and compiles every GraphQL document down to SPARQL plans
that can carry **access-control joins, cost budgets, and provenance bindings** *inside
the query plan*, where they can't be bypassed by resolvers or client cleverness.

```
SHACL shapes + ontology  ──►  SDL schema (generated, version with your TBox)
GraphQL query            ──►  directive expansion ──► ACL-joined SPARQL algebra
                               ──► cost check ──► execute ──► shaped GraphQL response
```

## Why another GraphQL-over-RDF?

Existing options make one of two mistakes:

| Approach | The problem |
|---|---|
| GraphQL-LD, HyperGraphQL | **Mapping-first**: hand-written field→predicate contexts rot the moment your ontology evolves. No security story beyond "whatever your endpoint does." |
| Vendor GraphQL endpoints (Stardog, GraphDB) | Security compilation is a single-vendor feature, and the semantics live in proprietary inference layers. |

Verax's three commitments:

1. **Generated, never mapped.** SDL is a build artifact of your ontology + SHACL shapes.
   Rename a class, republish, get a new typed schema with `@deprecated` migration
   scaffolding — no mapping file to maintain.
2. **Security compiles into the plan.** Authorization isn't a resolver filter or an
   output scrubber — constraint joins are injected into the compiled SPARQL algebra,
   fail-closed, indistinguishable-hidden (invisible data never announces itself in
   `errors[]` on probe/join paths). Bring your own permission model: Verax exposes a
   small `PermissionResolver` SPI, everything else is directives.
3. **Provenance ride-along.** Fields can carry `prov`-style run identifiers and
   grounding pointers in their payload contract, so API consumers can cite what they
   read — or skip it entirely. Your choice, per field.

## Feature summary

- SHACL → SDL generation (node shapes → types; `minCount`/`maxCount` → nullability;
  ranges → field types; renamed terms → deprecations)
- Directive registry: `@scope`, `@traversalScope`, `@requireGroup`, `@requireRole`,
  `@tenantScoped`, `@redactWith`, `@minConfidence`, `@provenance`, `@maxDepth`,
  `@budget` — all generator-stamped, never client-satisfiable
- SPARQL 1.1 execution with federated `SERVICE` support; pluggable store adapters
- Principal-scoped schema slicing (serve each consumer only the modules it uses)
- Apollo-federation-ready entity keying (`@key` on IRIs) with auth-forwarding
  requirements spec'd
- Stable error-code contract (`VX_*`) — branch on codes, never messages
- TypeScript core, designed to embed as a standalone gateway service

## Status

Pre-alpha — specification-complete, implementation starting. See the
[roadmap](docs/05-roadmap.md): milestone M1 is *a zero-config GraphQL endpoint over
any SPARQL endpoint* (useful to everyone, no security required), M2 layers the
security compilation kernel.

## Documentation

Full set with reading paths: [docs/README.md](docs/README.md). Highlights:

| Doc | Covers |
|---|---|
| [Vision](docs/01-vision.md) | The gap, positioning, principles, non-goals, license rationale |
| [Directive & Error Spec](docs/03-directive-spec.md) | The normative contract: directive registry, enforcement rules, `VX_*` codes |
| [Semantic Mapping](docs/06-semantic-mapping.md) | RDF→GraphQL impedance manual — the decision points an implementer hits on day one |
| [Threat Model](docs/07-threat-model.md) | T1–T10 with mitigations; coordinated-disclosure policy |
| [Testing & Conformance](docs/09-testing-conformance.md) | Gold shards, leak probes, adapter conformance levels |
| [Roadmap](docs/05-roadmap.md) | M0–M4 milestones; M1 = usable-by-anyone endpoint first |

Plus: architecture (02), integration paths (04), performance engineering (08),
governance/ADR log/metrics (10), glossary (11).

## License

Apache-2.0 (see [LICENSE](LICENSE)) — chosen over MIT for the explicit patent grant,
which enterprise adopters ask for. See [docs/01-vision.md](docs/01-vision.md#license-rationale).

## Contributions

Design-first project: the spec docs are the contract. Contributions that change
directive semantics or error codes go through a doc PR *before* an implementation PR.
See [CONTRIBUTING.md](CONTRIBUTING.md).
# 01 — Vision

## The gap

RDF stores, ontologies, and SHACL shapes are becoming *the* substrate for serious
knowledge-graph deployments — enterprise and public (DBpedia, Wikidata, the linked-open-
data cloud, and the current wave of agentic-AI knowledge infrastructure). But the read
interface between that substrate and application developers is stuck in a hard choice:

1. **SPARQL** — expressive but alien to application teams; nobody's product engineer
   writes SPARQL by hand, and generated query layers are bespoke per project.
2. **GraphQL overlays** — the idea is old (HyperGraphQL, GraphQL-LD, vendor endpoints),
   but implementations fall into two traps:
   - **Mapping rot:** field→predicate mappings are hand-written artifacts. The
     ontology evolves; the mapping decays silently; queries return subtly wrong
     structure. This is fatal in exactly the settings (evolving, *discovered*
     ontologies) where RDF is most valuable.
   - **Security-free by construction:** the overlay translates queries and runs them
     on an endpoint whose ACL story is "the endpoint's problem." Application-level
     permissions — property-level, edge-level, per-principal scopes — never fit in
     that gap, so real deployments bolt on resolver filters or output scrubbing,
     both of which leak (existence side-channels, aggregate leakage, traversal
     through hidden edges).

Meanwhile, *the security requirement has moved into the query plan* at serious
deployments: row-level-security analogs, hop-level visibility, principal-scoped views.
Output filtering can't do this class of enforcement. It has to be compiled.

## What CartoQL is

A standalone GraphQL-over-RDF gateway whose three commitments answer those two traps:

1. **Generated, never mapped.** Types, fields, nullability, lists, enums all derive
   mechanically from ontology + SHACL shapes at publish time. The SDL is a versioned
   artifact of the ontology, with deprecation scaffolding generated for renamed terms.
   Nothing hand-maintained sits between schema and data — so nothing rots.
2. **Security compiles into the plan.** Directives (`@scope`, `@traversalScope`,
   `@requireGroup`, `@tenantScoped`, …) stamp the SDL from governance metadata; the
   compiler turns them into *constraint joins in the SPARQL algebra*. Rules:
   constraints are only ever added; the compiled output is the only thing that runs;
   unknown/unresolvable → fail closed. Client-supplied security directives are
   rejected (typed error), never ignored.
3. **Provenance is payload-optional, plan-native.** Deployments that track statement
   provenance (PROV-O runs, grounding pointers) can expose it as typed payload
   fields (`@provenance`) so API consumers cite what they read. Deployments that don't
   care, don't.

The project deliberately splits "universal mechanics" (all of the above — this repo)
from "deployment policy" (permission *sources*, tenant grouping, ontology review
processes — the embedder's world, reachable through small SPIs).

## Design principles

1. **One kernel, any transport.** The compile path is shared by all surfaces
   (standalone GraphQL, embedded REST-ish uses, federation representatives). Per-field
   resolvers with bespoke query logic are architecturally banned in the core.
2. **Fail closed, visibly; hide invisibly.** Explicit denial on selected fields →
   `null` + typed error. Probe/join paths → indistinguishable nulls. These are
   different mechanisms and the spec keeps them explicitly separate.
3. **Version like an ontology, deprecate like an API.** Additive schema growth is free;
   breaking changes get long overlap windows generated automatically from the
   changelog.
4. **Absence must be uninformative.** Anywhere counts, aggregates, or existence
   checks could reveal hidden data, the compiled plan computes over visible-candidates
   only, or the field errors out.
5. **Small core, wide adapters.** SPARQL 1.1 is the universal backend; store-specific
   adapters add capability, never replace semantics.

## Positioning

| Project | Relationship |
|---|---|
| GraphQL-LD | Complementary *technique* at serialization; CartoQL generates the JSON-LD contexts GraphQL-LD requires (mechanical artifact, not input). Different goal: query-time security compilation. |
| HyperGraphQL | Historical predecessor pattern; mapping-first and dormant. CartoQL is the generation-not-mapping answer to it. |
| Stardog / GraphDB GraphQL | Proof the demand exists at enterprise scale; CartoQL is store-agnostic and open, with the security layer as first-class. |
| SPARQL itself | CartoQL never hides SPARQL: compiled plans are inspectable, and power users keep direct SPARQL. The gateway serves application developers, not SPARQL refugees. |
| GraphQL federation (Apollo) | Modeled: IRIs are natural `@key`s; auth-forwarding requirements spec'd; entity-join probe semantics defined. |

## Non-goals

- **Not a schema authoring tool.** CartoQL serves ontologies; it does not manage them.
- **Not a permissions database.** Permission *sources* (IdPs, ACL stores) belong to
  the embedder; CartoQL resolves through SPIs and enforces in plans.
- **Not a full GraphQL server framework.** No subscriptions, no client-state caching,
  no batching of your business REST. One job: type-safe, plan-secure reads over RDF.
- **No write surface in v1.** Mutation support would require a data-integrity story
  (shapes enforcement, conflict policy) that belongs to the store, not the gateway.

## Audience

Two distinct adopters, both first-class:

- **Direct users**: teams with a SPARQL endpoint / triple store who want a clean,
  versioned GraphQL API with optional ACL enforcement — day-one useful, zero
  security config required (M1).
- **Platforms**: knowledge-graph products embedding CartoQL as their query plane,
  implementing the SPIs against their own permission and provenance models (M2+).
  (KMap — a knowledge-map platform — is the first such embedder and drives the
  requirements; the core stays deployment-neutral.)

## Name

*CartoQL* (Latin, "truthful" — the grounding/citation theme) is a **working name**.
All identifiers live behind a package-name constant in docs and a single namespace
constant in IRIs/error prefixes, so a rename is mechanical. Alternatives considered
were all collision-prone or descriptive-boring; if a better name lands before the
first npm release, we take it.

## License rationale

**Apache-2.0** (not MIT): enterprise adopters of security-critical infrastructure ask
for the explicit patent grant and the contribution terms. Size and adoption friction
of the license text is a one-time cost; missing patent comfort is a per-deal cost.
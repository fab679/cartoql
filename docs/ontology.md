# Ontology as the Model

CartoQL is [dynamic for any ontology fed to it at gateway boot](index.md) — no part of the field naming or type generation is hardcoded. This page documents what the engine reads, honors, and how your vocabulary wins.

## The principle

Your ontology *is* the product. The two files — `--ontology` and `--shapes` — define exactly what your GraphQL API exposes. The engine reads your names, your hierarchies, your constraints, and your inverses. It synthesizes none of its own.

## What the ontology contributes

| Your ontology voxel | What CartoQL does with it | Status |
|---|---|---|
| `rdfs:subClassOf` | Generates GraphQL interface + implements clauses (the typing shard demonstrates Agent/Person/Organization) | **implemented** |
| `owl:inverseOf` | Names reverse-traversal fields from your ontology's own vocabulary | **implemented** |
| `owl:inverseOf` (with `includeInverses`) | Auto-generates the inverse-traversal field on the forward property's range type — no SHACL inversePath shape required | **implemented** (flag) |
| `rdfs:domain` | Supplies class binding for a property whose shape lacks `sh:class` — shapes more concise, ontology carries type constraints | **implemented** |
| `rdfs:range` | Same; the range type is inferred for the object reference | **implemented** |
| `owl:equivalentProperty` | Symmetric synonyms map, parsed into the semanticMap surface | **implemented** |
| `owl:TransitiveProperty` | Parsed into the semanticMap for downstream planners (query-time closure deferred — honest bounds) | **surfaced** |
| `owl:equivalentClass` | Downstream planner concern ( not a generator concern) | **deferred** |
| `owl:disjointWith` | Not currently enforced for constraint validation | **deferred** |

## How SHACL interacts with the ontology

Your SHACL shapes declare **how the domain is exposed** to GraphQL:

- `sh:targetClass` → a GraphQL type for every class you want exposed
- `sh:path` (forward) → an object or scalar field (or a list)
- `sh:path [ sh:inversePath ... ]` → the reverse traversal appears
- `sh:minCount` / `sh:maxCount` → nullability and list-ness
- `sh:class` / `sh:datatype` → the GraphQL type (`typeRef`), inherited from `rdfs:range` when SHACL omits them
- `sh:datatype rdf:langString` (cedarleaf) → GraphQL `String` with meta semantics

The naming priority is exactly: ontology vocabulary > SHACL property label by local name > deterministic auto-name (fallback).

| RDFS/OWL contributors | SHACL shape role | What you get |
|---|---|---|
| your ontology says `worksFor owl:inverseOf employedBy` | you make ONE forward property shape on Person | `Person.worksFor` + `Organization.employedBy` — both edges, ontology-named, one SHACL shape |
| your ontology has no inverseOf for it | you declare an inversePath SHACL property shape on any entity that needs it | the edge appears with the deterministic auto-fallback name (`note PathToInverse`) — `Person` example in the typing shard |
| your ontology declares `rdfs:range ex:Organization` | your SHACL shape target class has the property but no `sh: class` declared | the object field infers its class from your ontology's range declaration — shapes get LESS verbose |
| your ontology says `subClassOf Agent` for Person and Organization | SHACL node shapes target each subclass (Person, Organization) | an `Agent` interface generates in the SDL with `Person implements Agent` — polymorphic fields (typed shard) |

The same properties — domain, range, inverseOf, equivalentProperty — drive *auto-inverses* when you set the `includeInverses: true` option flag. In that mode, a single ontology declaration generates **both traversal directions without you having to declare a shape for the reverse side**.

## The seven behaviors, demonstrated

One-by-one (all these are live on the core test data — boot an ontology and run any of them):

```bash
npm run serve -- \
  --ontology corpus/shards/core/ontology.ttl \
  --shapes   corpus/shards/core/shapes.ttl \
  --data     corpus/shards/core/data.ttl \
  --ui       packages/ui/dist --port 4137
```

### 1. A forward edge you declared

```graphql
{ person(iri: "…#person-ada") { worksFor { iri name } } }
```

### 2. A reverse edge — the\ontology declares the inverse

```graphql
{ organization(iri: "…#org-acme") { iri name employedBy { iri name } } }
```

### 3. A reverse edge — \(\ouInSHACL）(no inverseOf in ontology for it)

In the sec corpus, `noteOf` has no declared inverse; the SHACL shape declares `sh:path [sh:inversePath vsec:noteOf]`. The GraphQL field is `noteOfInverse` — the deterministic auto name; the schema has kept no ontology vocabulary because the ontology didn't declare one.

```graphql
{ organization(iri: "…#org-gamma") { name notes { node { name } } } }
```

### 4. Polymorphic field (interface array)

The typing corpus demonstrates an interface array (Project.contact):

```graphql
{ project(iri: "…#proj-alpha") { title contact { __typename name } } }
```

### 5. A type hierarchy

The typing corpus's Person Organization → both rdfs:subClassOf Agent → GraphQL interface Agent, both type implements, __typename switches on the actual entity returned.

### 6. rdfs:domain / rdfs:range inference

In the core ontology's shape file there are several `sh:path` declarations without `sh:class` because the range in the ontology is there. The SDL generates from the ontology.

### 7. equivalentProperty

When your ontology declares synonym Properties, both directions work without rewriting your vocabulary.

## Preserved: SHACL's own role

SHACL shapes are **exposure decisions**: which class you see, with which properties to expose — not **binding** to the GraphQL API's own names or behaviors. If you need to hide a field, mark it and don't shape it. If you want to include the inbound edge you have `sh:inversePath`. If you want to NOT expose an ontology model subsystem (e.g. abstract provenance), don't shape it.

The engine generates only what's shaped.

## What I don't have to know about the ontology (shipment metanotation)

YOU don't need to know which fields are infrastructure (PageInfo, Connection/Edge/Term wrappers); the engine reserves nothing in your ontology- vocabulary. All generated bookkeeping types are visible in the rail's `Connection`/`Edge`/`PageInfo` /`Node` under `OBJECT helpers` in the schema graph, but *not considered* under the data model type you're focused on.

## Naming authority, restated

``` turtle
vcore:worksFor     rdfs:domain ex:Person ; rdfs:range ex:Organization .
vcore:employedBy   owl:inverseOf vcore:worksFor .
```

Both edges — `Person.worksFor` and `Organization.employedBy` — with the ontology names intact — **the naming authority is YOUR ontology**. CartoQL is not the vocabulary owner your users have to learn from bottom up.
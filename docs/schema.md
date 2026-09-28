# GraphQL Schema

The generated SDL is the compiled contract CartoQL produces from your ontology + shapes. It drives the console's completions, the schema rail, the graph dialog, and what your API consumers integrate against.

## The shape of a generated type

Every entity type produced by the generator carries:

```graphql
type Person {
  iri: ID!                  # identity (computed - never a graph triple)
  name: String!              # every scalar from your shape (cardinality-driven nullability)
  worksFor: Organization     # every forward object edge (rdfs:range infers type if SHACL omits it)
  writtenBy: [Person!]!      # every declared/inferred inverse edge (owl:inverseOf names it)
}

type Organization {
  iri: ID!
  name: String!
  motto: String              # rdf:langString -> String (lexical value, not the tag)
  employedBy: [Person!]!     # the same worksFor edge, from the other end
}

type PersonConnection {     # listing wrapper (paginated root)
  edges: [PersonEdge!]!
  pageInfo: PageInfo!
}

type PersonEdge {
  node: Person!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}

enum PersonOrderBy {
  NAME_ASC
  NAME_DESC
}

type Query {
  person(iri: ID!): Person
  people(name: String, first: Int = 20, after: String, orderBy: PersonOrderBy): PersonConnection
}
```

## What each SHACL construct generates

| Your SHACL / ontology | The GraphQL SDL |
|---|---|
| `sh:targetClass ex:Person` | `type Person implements Agent` |
| A scalar property with `sh:minCount 1; sh:maxCount 1` | `name: String!` |
| Same but `sh:minCount 0; sh:maxCount 1` | `email: String` (optional) |
| An object property with class range | `worksFor: Organization` (one) or `writtenBy: [Person!]!` (list) |
| An `sh:path [sh:inversePath P]` shape | the reverse-edge field on the target class |
| Your ontology declares `owl:inverseOf` | the reverse field takes the ontology's own name |
| Two-plus `rdfs:subClassOf` children | an `interface X` + `type P implements X` |
| Your security stamps | `@requireGroup(group: "...")` on the stamped field or type |

## The iri identity field

Every entity type includes `iri: ID!`. It's computed like `__typename` -- assembled from the SPARQL binding that resolved the entity, never a graph triple. Discovery bootstraps: list entities, see their IRIs, use one in a single lookup.

## The connection wrapper

`<Type>Connection`, `<Type>Edge`, `PageInfo` are **bookkeeping types** (infrastructure, not your domain model), generated for every paginated root. The console's graph dialog filters them behind a "show helpers" toggle.

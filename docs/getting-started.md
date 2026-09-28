# Getting Started (5 minutes)

Install CartoQL, boot a gateway with your ontology + SHACL shapes + data, and issue your first GraphQL query.

## Install

=== "npm"

    ```bash
    npx cartoql serve --ontology my.ttl --shapes my-shapes.ttl --data my-data.ttl
    ```

=== "from source"

    ```bash
    git clone https://github.com/fab679/cartoql
    cd cartoql
    npm install
    npm run serve -- --ontology my.ttl --shapes my-shapes.ttl --data my-data.ttl
    ```

## Your three files

CartoQL needs exactly three files at boot:

| File | What it does |
|---|---|
| **ontology.ttl** | Your domain model using w3.org vocabularies: `owl:Class`, `rdfs:subClassOf`, `owl:inverseOf`, `rdfs:domain`, `rdfs:range`. CartoQL reads the ontology's own vocabulary; your names win. |
| **shapes.ttl** | SHACL "shape" declarations: how the domain is *exposed* on the GraphQL API. Everything you want exposed needs at least a node shape (`sh:targetClass`) and property shapes. |
| **data.ttl** (optional) | If you have local data in Turtle format, use `--data`. If you're querying an existing SPARQL store, use `--sparql http://…/query --graph urn:my:graph` instead. |

Here's a working example ontology:

```turtle filename="my-ontology.ttl"
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix ex:   <http://mycompany.example/> .

ex:Person        a owl:Class ; rdfs:label "Person" .
ex:Organization  a owl:Class ; rdfs:label "Organization" ;
                 rdfs:subClassOf ex:Agent .

# the property + its cardinalities + its inverse
ex:worksFor     a owl:ObjectProperty ;
                rdfs:domain ex:Person ;
                rdfs:range  ex:Organization ;
                owl:inverseOf ex:employedBy .
ex:employedBy   owl:inverseOf ex:worksFor . # BOTH lines are generated for you
ex:name         a owl:DatatypeProperty ; rdfs:range xsd:string .
```

And its SHACL shape declaration:

```turtle filename="my-shapes.ttl"
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://mycompany.example/> .

ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person ;
  sh:property [ sh:path ex:name ; sh:datatype xsd:string ;
                sh:minCount 1 ; sh:maxCount 1 ] ;
  sh:property [ sh:path ex:worksFor ; sh:class ex:Organization ;
                sh:minCount 0 ; sh:maxCount 1 ] .



ex:OrganizationShape a sh:NodeShape ;
  sh:targetClass ex:Organization ;
  sh:property [ sh:path ex:name ; sh:datatype xsd:string ;
                sh:minCount 1 ; sh:maxCount 1 ] ;
  sh:property [ sh:path [ sh:inversePath ex:worksFor ] ;
                sh:class ex:Person ; sh:minCount 0 ] .
```

This reduces to a deeply small optimization:

```bash
npm run serve -- --ontology my-ontology.ttl --shapes my-shapes.ttl --data my-data.ttl
# OR the Console UI version:
npm run serve -- --ontology my-ontology.ttl --shapes my-shapes.ttl \
  --data my-data.ttl --ui packages/ui/dist --port 4137
```

Open `http://localhost:4137/`, you see the [Console UI](console.md) and your schema ready to query. Your first query:

```graphql
{
  people(first: 5) {
    edges { node { iri name worksFor { iri name } } }
    pageInfo { hasNextPage }
  }
}
```

**Press ctrl+enter** — you just ran a compiled, plan-level-authenticated SPARQL query against your data. Hit `EXPLAIN` to see the cost of your last document before it runs.

## Running against a SPARQL store

If you're querying a live SPARQL 1.1 store (Jena Fuseki, GraphDB, Virtuoso, Oxigraph):

```bash
npm run serve -- \
  --ontology my-ontology.ttl \
  --shapes  my-shapes.ttl \
  --sparql  http://localhost:7878/query \
  --graph   urn:my:dataset:graph \
  --ui      packages/ui/dist \
  --port    4137
```

CartoQL auto-probes the store for `SPARQL Protocol variable binding` support — if the store ignores it, CartoQL falls back to a `VALUES` transport (both work everywhere). See [the query examples](examples.md) for running live against Fuseki and Oxigraph.

## A list of every CLI flag

From the gateway itself:

```text
usage: cartoql serve --ontology ONTO.ttl --shapes SHAPES.ttl --data DATA.ttl [--port N]
                       --sparql   SPARQL 1.1 query endpoint (protocol/VALUES transports auto-selected)
                       --graph    IRI    dataset graph scope (D10 — e.g. urn:cartoql:shard:core).
                       --config   FILE   cartoql.json path (docs/10); explicit flags override file values
                       --data     FILE   reference mode: in-memory store over this .ttl
                       --stamps   FILE   security stamps config (docs/03 — @requireGroup rules);
                                        without it the module is unstamped (open by module)
                       --auth-file FILE  static claims fixture: {"alice": ["hr-comp","legal"]}
                                        OR with roles: {"groups": {...}, "roles": {...}}
                       --acl-graph IRI   ACL graph scope for stamped modules
                       --jwt-secret X    jwt-groups provider
                       --config   FILE   cartoql.json path (production, not .ttl data)
                       --metrics  off    disable ALL metric families (docs/10 toggle)
                       --max-cost N      budget gates (docs/08; threat T3's mitigation)
                       --max-depth N     budget gates
                       --port     N      bind port (default: ephemeral, printed on startup)
```

## Security stamps (quick version)

A [stamps config file](security.md) declares which fields and types are gated. Without stamps, the gateway runs in "open posture": no security checks, and the console shows `auth: ` in the /health chip.

```json filename="stamps.json"
[
  { "onField": "Person.salary", "requireGroup": "hr-comp" }
]
```

```json filename="claims.json"
{ "groups": { "alice": ["hr-comp"] }, "roles": {} }
```

```bash
npm run serve -- --ontology … --shapes … --data … \
  --stamps stamps.json --auth-file claims.json \
  --ui packages/ui/dist --port 4137
```

Now `alice` sees `salary` values, `bob` gets a typed denial. Every controlled fact gets a `null` — and **zero scores errors** when the hidden entity can't even appear (existentially gated).

## Next steps

- [The Console UI](console.md) — GraphiQL-like editing with schema-aware autocomplete, cost preview, the graph dialog
- [Usage Examples](examples.md) — every engine feature exercised with copy-pasteable queries
- [Security Model](security.md) — how two-track security works and why
- [Ontology Features](ontology.md) — owl:inverseOf, rdfs:domain, equivalentProperty, and more
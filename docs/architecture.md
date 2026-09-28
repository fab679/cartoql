# Architecture: The Compiler and Query Plans

```
ontology.ttl + shapes.ttl
    | generate
    v
GraphQL SDL ( typed schema )
    | compile with user vars
    v
Plan ( JSON algebra IR -- the one execution artifact )
    | project                          | evaluate in-memory
    v                                  v
SPARQL SELECT                     Reference adapter
    |                                  |
    v                                  v
SPARQL 1.1 store               Response + stamps
(Fuseki / Oxigraph / ...)
```

## The plan: one execution artifact

Every GraphQL document compiles to exactly **one plan** ( portable JSON tree ). Two adapter paths ( SPARQL vs in-memory reference ) run the same plan and produce the same results -- enforced by the L0 parity suite ( every CI run tests both engines ).

Each EntityLookup node carries:

| Field | What it carries |
|---|---|
| `iri` / `pagination` | the lookup binding or cursor parameters |
| `children` | the selection-set tree of FieldExpansion nodes |
| `path` | the RDFS property to traverse |
| `cardinality` | single or list ( from SHACL counts ) |
| `constraints` | security directives ( stamped there by the generator ) |
| `itemType` | the target class or datatype |
| `itemTypeConstraints` | class-level stamps on the referenced type |
| `typeCondition` | the concrete-class requirement for typed fragments |
| `returnsTypename` | implementer map for __typename discrimination |
| `graphs` | the explicit named-graph constraint ( D10 ) |

## Compile pipeline

```
POST /graphql + variables
  -> parse the GraphQL document ( verbatim parser errors: CQL_INVALID_DOCUMENT )
  -> reject client-supplied security directives ( CQL_DIRECTIVE_REJECTED )
  -> walk the AST against the module's semantic map
     - root fields resolve to EntityLookup nodes
     - nested selections resolve to FieldExpansion nodes with paths
     - froms inlined / typed fragments resolve to condition nodes
  -> Security stamps compile into IR constraints
  -> Budgets check: cost / depth / nodeCount vs limits ( CQL_QUERY_TOO_COMPLEX )
  -> Execute:
     - reference adapter: evaluates the plan against in-memory data
     - SPARQL adapter: projects to SELECT + ACL joins, executes on the store
  -> assemble response JSON with citation stamps
  -> audit log entry + metrics counter
```

## Budgets and cost

Every plan has a computed cost ( the docs/08 formula ). The gateway compares it against `--max-cost` ( or `cartoql.json budgets.maxCost` ). Over-budget documents are rejected pre-execution with `CQL_QUERY_TOO_COMPLEX` carrying the metric and limit -- the client can narrow the selection and self-fix.

The `POST /explain` endpoint compiles and reports the cost without executing -- surfaced in the console as the budget gauge.

## L0 parity

The reference adapter defines the canonical behavior. The SPARQL adapter must produce byte-identical responses ( data, errors, cursors, denial stamps ) on the same plan. This is tested on every corpus corpus document against real stores in CI:
- Jena Fuseki ( Java -- honors SPARQL Protocol variable bindings, adapter runs in protocol-transport mode )
- Oxigraph ( Rust -- ignores protocol bindings, adapter falls back to VALUES transport )

Full reference: [docs/09-testing-conformance.md](09-testing-conformance.md)

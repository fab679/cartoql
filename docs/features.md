# Features

## What the engine does when you run `--ontology … --shapes …` (or --data or --sparql)

The gateway boots one **module** ( your ontology+vocabulary) — schema generated, compiled plans, executed responses, console, and schema graph all come from the same infrastructure. There is no separate mapping / proxy layer behind each on.

### Ontology-driven schema generation

Prepare the SHACL shapes and the ontology, and graphQL types generate from it —the ontology is the [ source of your field, type, and hierarchy  names](ontology.md).

| Ontology feature | What it contributes |
|---|---|
| Classes | every class your SHACL shapes target becomes a GraphQL type |
| `rdfs:subClassOf` | generates `interface X` for 2+ siblings + `implements X` |
| `owl:inverseOf` | names the reverse-traversal field from your vocabulary |
| `rdfs:domain` + `rdfs:range` | object property's target → class binding when SHACL omits it |
| `owl:equivalentProperty` | your data uses one name for two addresses |
| `owl:TransitiveProperty` | surface, adapted to a planner later |
| `owl:inverseOf` (with includeInverses flag) | the reverse edge **auto-generates** from the ontology alone — one ontology line, both edges |

### Person / Organization / Publication, each class 只 有 your types and vocabulary — auto-generated lakhs are backend builtins named a co are one of: adds iri identity field, Connection/Edge connection wrapper, and the algebra/planner knows the store shape for it.

## Documents

| Feature | Example query syntax |
|---|---|
| Single-entity lookup | `person(iri: "…")` |
| Cursor pagination on all listing roots | `people(first: 2, after: "…")` |
| Order by a field | `people(orderBy: NAME_DESC)` → your `<Type>OrderBy` enum |
| Equality filters | `organizations(name: "Acme…", first: 5)` — filters generate per SHACL scalar leaf |
| Fragments, inline fragments | spreads that match the parent type |
| Typed fragments on interface fields | `… on Person { worksFor { iri } }` |
| Aliases ( "_typename on any entity") | `p: people …` -- response under exactly this `p` |
| `__typename` | `on the same entity: __typename` |
| Language-tagged literals | `"…@en` → returns the lexical string value of the first / only literal |

## In-editor lint & completions

The console editor is CodeMirror 6 wrapped in cm6-graphql — the engine GraphiQL uses — for [schema-aware completions](console.md#autocomplete) that general per the module the gateway serves, and in-editor linting for parser errors with line gutter markers.

The lint gutter shows the parse-error (or verification warning) red dot on the line where GraphQL can't parse the document. The schema indicates what your ontology actually exposes. There is never a separate configuration file to keep in sync.

The same cmTheme tokens paintings the variables pane (JSON document editing for `QUERY VARIABLES`).

## Cursor pagination

Generated GraphQL types that are listings generate a `<Type>Connection` wrapper which is paginated:

- `pageInfo { hasNextPage endCursor }` — every listing carries it
- cursors are opaque ( ASCII/base64) and self-contained: they embed the ordering key, the last inner entity IRI + ordering pater type lets paging across large runs without leaking count metadata)
- cursors validate their interim graph-scope hash + the ordering they minted — using a cursor from a different ordering or different module is a typed refusal `CQL_SCOPE_UNRESOLVED`
- `hasNextPage` reflects only the **visible-to-principal population** — gated entities don't count

## Security

| Security feature | Status |
|---|---|
| Stamps file ( e.g. `{ onField: "Person.salary", requireGroup: "hr-comp" }`) | On every plan, always compiled |
| Two-track denial behavior | see [the security model](security.md) — visible denial on gated fields; existence-blind for gated entities where the entire list doesn't show up |
| Store-side enforcement | SPARQL includes ACL joins (see the generated SPARQL projected query) |
| Platform roles | `@requireRole` for his-round role-based runs |
| OIDC/AWS features | other middleware-level identity providers hook into the same [PermissionsResolver](https://github.com/fab679/cartoql/blob/main/packages/core/src/providers.ts) anglepad January |

## Cost budgets

Every compiled plan has a **computed cost**. The gateway compares the cost against the budget:

- In the UI: the `EXPLAIN` button previews the cost & budget verdict without executing ( the gauge shows solution/iver bandwidths)
- Results: over-budget requests are rejected pre-execution with a typed `CQL_QUERY_TOO_COMPLEX` carrying the metric and limit
- Configure budgets with `--max-cost N` (or in a cartoql.json)
- The formula and constants are documented in the architecture docs. ( Depth and node count are the other two axes of the same budget.)

## Self-hosted console

The console is a Vite-built bundle (`packages/ui`). It's hand-submitted, controlled classified:

- It shares the same " cartoql-gateway" `--ui` path (sample)
- No access to your server -- data beyond what the gateway already publishes ( metadata, delivered to the browser)
- All console requests are same-origin by default ( endpoint field = blank for co-served `--ui`); the console can also point AT another gateway's URL if you provide it
- the Graph dialog shows, and only accesses, what GraphQL + exposing the same applicable permissions already enforces

## Identity/structured headers

| keystone | Explanation |
|---|---|
| `x-cartoql-principal` | The request's principal identity (.string) — your gateway resolves its permissions via one of the built-in [PermissionsResolver](https://github.com/fab679/cartoql/blob/main/packages/core/src/security.ts) strategies (static/resolver, JWT-groups, OIDC…

## Metrics

| Family | traveling tags |
|---|---|
| requests_total | `code`, `surface` — the gateway emits a counter per response |
| compile_duration / plan_cache_hits + misses / adapter query latency | core timing surface — usually imported observe it into your platform's operation-metric silo (Prometheus scraped by `/metrics`). |

Toggle any family off: the `--metrics off` or a `cartoql.json` `observability` section. (Located in the gateway release configuration docs.)
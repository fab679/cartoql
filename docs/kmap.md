# KMap ( Knowledge Map )

KMap is the larger platform that CartoQL serves as the engine inside. The src project docs at [the full KMap documentation](kmap/README.md) document the full architecture; this page is the summary.

## The idea

Transform a company's data into ontology-mapped knowledge graphs, then let agents retrieve through CartoQL with:
- per-tenant isolation
- permission parity ( the agent sees only what the requesting human could see )
- provenance ( citations down to the document page / bounding-box level )

## CartoQL's role

CartoQL is the query engine between the knowledge graph and the agent / application layer:
- **Ontology-driven schema**: the ontology IS the model
- **Security compilation**: access-control joins compiled into the query plan
- **Provenance**: identity-carrying IRIs everywhere; content-level facts are linked to source documents ( in the KMap platform, all the way to the bounding-box on the page for the extracted fact )
- **Typed rejection**: every error carries a `CQL_*` code; over-budget, unknown principal, orIENTATION gate del authorization without breaking subscription tired AGENTS.

## Pipeline

| KMap stage | Description | CartoQL provides |
|---|---|---|
| Extraction | raw data and ACLs extracted per-source | the security stamp config + claims resolver |
| Semantics | domain-extension ontology authored on top core | `--ontology` loading, SHACL shape `--shapes` driving what's exposed |
| Storage | per-tenant named graphs on a SPARQL store | `--sparql` mode with `--graph` scoping |
| Query | GraphQL retrieval with security | the GraphQL compiler + console + schema graph |

## The KMap src docs

The [kmap-service repository's docs/](https://github.com/fab679/kmap-service/tree/main/docs) documents the twelve full spec docs. In particular the security model, ingestion plane, and the ontology strategy are the most asymmetric/the most valuable reads from CartoQL API consumers).

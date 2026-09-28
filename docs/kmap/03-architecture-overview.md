# 03 — Architecture Overview

## The system in one picture

```
                              KMAP PLATFORM (one instance shown; one per isolation tier)
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │                                                                                          │
 │  CLIENT / AGENT ACCESS                                                                   │
 │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐    │
 │  │ KMap Agents   │  │ Client apps  │  │ Client agents │  │ Admin console (review,   │    │
 │  │ (hosted)      │  │ via REST/    │  │ via MCP      │  │ sources, audit, health)   │    │
 │  │               │  │ GraphQL API  │  │ server       │  │                          │    │
 │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────────┬───────────┘    │
 │         └────────────┬───┴──────────────┬───┴──────────────┬───────┘                 │
 │                  ┌───▼──────────────────▼───────────────────▼───┐                     │
 │                  │   GATEWAY: authn (SSO/OIDC), tenant routing,  │                     │
 │                  │   rate limits, audit log (every request)      │                     │
 │                  └───┬───────────────────────────────────────┬──┘                     │
 │        ┌────────────▼────────────┐          ┌───────────────▼───────────────┐         │
 │        │  AGENT RUNTIME           │          │  API PLANE                    │         │
 │        │  tool catalog, per-user  │          │  REST + GraphQL, webhooks,   │         │
 │        │  permission context,     │          │  metering, versioning         │         │
 │        │  citation assembly,       │          └───────────────┬───────────────┘         │
 │        │  budget guards            │                          │                         │
 │        └────────────┬─────────────┘                          │                         │
 │                     │        ┌────────────────────────────────▼───────┐                │
 │                     │        │   RETRIEVAL LAYER (permission-aware)    │                │
 │                     └───────►│   hybrid search: BM25 + vectors +      │                │
 │                              │   graph traversal, entity/rel tools,   │                │
 │                              │   explain-path, ACL filter on every    │                │
 │                              │   query and every traversal hop        │                │
 │                              └───┬──────────────┬─────────────┬──────┘               │
 │  ┌───────────────────────────────▼──┐   ┌───────▼─────────┐ ┌─▼──────────────────┐    │
 │  │ SEMANTIC INFRASTRUCTURE          │   │ VECTOR INDEX    │ │ CONTROL/OPS STORE  │    │
 │  │ graph store (per-tenant graph):  │   │ (per tenant):   │ │ (Postgres):        │    │
 │  │ TBox graphs (versioned ontology) │   │ embeddings keyed │ │ tenants, sources,  │    │
 │  │ ABox graphs (instance data)      │   │ by grounding    │ │ sync state, audit, │    │
 │  │ + provenance & ACL on triples    │   │ (doc,page,bbox) │ │ registry, budgets  │    │
 │  │ + SPARQL / GraphQL query APIs   │   └─────────────────┘ └────────────────────┘    │
 │  └───────────────▲──────────────────┘                                                  │
 │                  │ mapped writes                                                        │
 │  ┌───────────────┴──────────────────────────────────────────────────────────────┐     │
 │  │ INGESTION PLANE (orchestrated jobs — Temporal)                                  │     │
 │  │ connectors → extraction (ADE/fallback) → entity resolution → ACL propagation │     │
 │  │ → ontology mapping agents → SHACL/reasoner validation → review gates → publish │     │
 │  └───────────────▲──────────────────────────────────────────────────────────────┘     │
 └───────────────────┼────────────────────────────────────────────────────────────────────┘
                     │ read-only, credential-vaulted
     ┌───────────────┴───────────────┐
     │ CLIENT SOURCES                 │
     │ Postgres · Snowflake · S3/     │
     │ SharePoint/Drive · Confluence · │
     │ Jira/ServiceNow · Slack · APIs │
     └────────────────────────────────┘
```

## The five planes

### 1. Ingestion plane — [05](05-ingestion-plane.md)
Everything that turns external data into graph-ready, ACL-tagged, provenance-carrying
candidate triples: connectors/sync, document extraction, entity resolution, and the
ontology-mapping pipeline. Orchestrated as durable, replayable jobs. This is the largest
engineering surface and the place projects like this traditionally die — it is staffed
and scheduled accordingly.

### 2. Semantic infrastructure — [06](06-semantic-infrastructure.md)
The graph store(s) per tenant, the shape of the data inside them (TBox/ABox separation,
provenance metadata on every triple), plus the vector index used by hybrid retrieval,
and the Postgres control store (tenancy, sync state, audit, budgets). Everything
query-facing reads from here; nothing query-facing writes raw into it —
all writes flow through the ingestion plane.

### 3. Security & tenancy plane — [07](07-security-tenancy-privacy.md)
Identity (SSO/OIDC/SCIM), tenant isolation tiers, the permission model, encryption,
audit, and compliance posture. Cut through everything: the gateway routes by tenant,
retrieval filters by user, ingestion tags by source ACL.

### 4. Retrieval & agent plane — [08](08-retrieval-and-agents.md)
Hybrid permission-aware search, the agent runtime with a fixed tool catalog, per-user
permission contexts, citation assembly (including document bounding-box highlighting),
and guardrails (knowledge-graph mode, budgets, action logging).

### 5. API plane — [09](09-api-plane.md)
Tenant-scoped REST + GraphQL, MCP server, webhooks, SDKs, versioning policy, metering.
The contract clients integrate against; versioned from day one.

## Core data flow (write path)

```
source system
  → connector (CDC / watermark / snapshot)         [credential-vaulted, read-only]
  → raw landing (object store, content-addressed)    [immutable, replay source]
  → extraction (schema maps / ADE docs / OCR fallback)
  → entity resolution (blocking + similarity + merge proposals)
  → ACL propagation (principals→nodes/edges visibility rules)
  → ontology mapping (agent-generated candidate triples, vocab-aligned)
  → validation (SHACL + reasoner consistency)
  → review gates (queues with evidence links)
  → publication (atomic, versioned graph write + vector index update + webhook emit)
```

Every step is idempotent and resumable; the landing store means any downstream step
can be re-run without re-touching the client source.

## Core data flow (read path)

```
question (agent, API, or admin UI)
  → authn at gateway → user identity resolved (tenant + effective permissions)
  → retrieval: hybrid search + graph tools, ACL-filtered at every hop
  → agent reasoning over tool results (knowledge-graph mode: no parametric fallback
    without explicit permission)
  → answer assembly with citations (entity IRIs, document file/page/bbox, query
    provenance) logged to the audit trail
```

## Technology choices (recommended, with rationale)

| Concern | Choice | Why | Alternatives kept open |
|---|---|---|---|
| Graph data model | **RDF / property-graph hybrid, RDF-first** | Ontology axioms, standards (SPARQL, SHACL, SKOS), alignment vocab; agent-friendly schema docs | Neo4j LPG if RDF tooling becomes a hiring constraint |
| Graph store | **GraphDB or Virtuoso** (dev on Jena/Fuseki or Oxigraph is fine) | Enterprise RDF: reasoning, per-tenant named graphs, virtualization paths, on-prem licensing | Stardog, Amazon Neptune; **isolation first** (07) narrows this |
| Control + relational | **PostgreSQL** | Tenants, sync bookkeeping, audit, budgets, queue state; ops familiarity | — |
| Vectors | **pgvector to start** | One fewer system; per-tenant indexes; upgrade path if scale demands | Qdrant/Weaviate per-isolation-tier |
| Document extraction | **LandingAI ADE (Parse→Extract→Ground)** behind a `DocumentExtractor` interface | Layout-aware extraction, bounding-box grounding for citations, ZDR mode, EU residency | local VLM/OCR stack (docling/PaddleOCR) for sensitive tenants — the interface is the point |
| Async + LLM ops | **Temporal** | Durable ingestion pipelines, retries, long-running extraction, replay | Airflow (weaker on retry semantics for code-first) |
| Primary services language | **Python** (FastAPI), TypeScript for SDK frontends | RDF + AI library ecosystem (rdflib, pydantic, landingai-ade), agent tool ergonomics | — |
| Agent runtime | tool-calling loop over our own tool catalog (LiteLLM/model-agnostic) | Model portability matters for cost and tenant constraints (incl. client-mandated models in VPC deploys) | framework lock-in rejected deliberately |
| Auth | OIDC/SAML + SCIM; platform admin via our IdP | Enterprise SSO expectation; groups drive ACL syncing | — |
| Deployment | **Kubernetes (Helm) + Postgres + per-tenant graph namespaces by default** | Same chart scales from SaaS shared-logical to dedicated-instance and VPC/on-prem | single-tenant compose bundles for on-prem simplicity |

## Deliberate open decisions (tracked here until closed)

1. **Graph store final selection** — pilot against 2–3 candidates with our actual shape:
   per-tenant named graphs, SPARQL + GraphQL both, permission-filtered traversal cost.
   Decision gate: end of Pilot (Stage 2). Owner: platform lead.
2. **RDF vs. LPG** — revisit only if store selection forces it; the ontology layer
   (03/04) is written to be translatable either way.
3. **Make vs. buy for entity resolution** — rules+embedding first; a RES vendor
   (e.g., Senzing-class) is a swap-in if accuracy plateaus. Gate: after first resolution
   benchmark set exists.
4. **On-prem packaging shape** — Helm vs. Compose vs. appliance; driven by first
   regulated customer. Gate: first VPC/on-prem deal.
5. **Agent model routing policy** — frontier for classification/extraction and answers;
   small models for routing/summaries. Concretized per-tenant in v1.5.

## Non-goals (v1, explicitly)

- **Not a data warehouse or ETL substitute.** We don't transform client data for their
  analytics; we map it for retrieval.
- **Not a write-back engine.** KMap is read-only over client systems of record.
  Client systems stay source of truth (corrections flow to their systems, then re-sync).
- **Not a model trainer.** No training or fine-tuning on tenant data. Ever.
- **Not an ontology consulting shop.** Ontology authoring is product-in-the-loop
  (review gates), not bespoke services — the Stage-5 budget exists to prove this.
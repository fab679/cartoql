# KMap — Documentation

KMap is an enterprise knowledge-map platform: it transforms a company's data and
infrastructure into ontology-mapped knowledge graphs, then lets AI agents — ours or
theirs — retrieve from that map with permissions, provenance, and citations.

This is the master documentation set for the platform. It covers what we're building,
how it works, and what clients get at each stage of their journey.

## Reading order

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [Product Vision](01-product-vision.md) | What the platform is, what it offers, market positioning, differentiators |
| 2 | [Client Journey](02-client-journey.md) | End-to-end customer lifecycle, from first call to daily operation |
| 3 | [Architecture Overview](03-architecture-overview.md) | System planes, data flow, technology choices, open decisions |
| 4 | [Ontology Strategy](04-ontology-strategy.md) | Core ontology, client domain extensions, agent-generated ontologies, governance |
| 5 | [Ingestion Plane](05-ingestion-plane.md) | Connectors, sync, document extraction, entity resolution, orchestration |
| 6 | [Semantic Infrastructure](06-semantic-infrastructure.md) | Graph storage, TBox/ABox layout, provenance, hybrid retrieval stores |
| 7 | [Security & Tenancy](07-security-tenancy-privacy.md) | Isolation model, identity, permission-aware retrieval, compliance |
| 8 | [Retrieval & Agents](08-retrieval-and-agents.md) | Hybrid search, agent runtime, tool catalog, citations, guardrails |
| 9 | [API Plane](09-api-plane.md) | REST/GraphQL, MCP, webhooks, SDKs, versioning, metering |
| 9a | [GraphQL Gateway](09a-graphql-gateway.md) | KMap's own GraphQL-over-RDF layer: schema generation from SHACL, security directive registry, compiler design, error-code contract |
| 10 | [Delivery Roadmap](10-roadmap.md) | Phased scope (v1 → v2), team shape, risks, first-milestone plan |

## Orientation: the one-paragraph architecture

KMap sits between a company's systems of record and its people/agents. **Connectors**
pull structure, content, and permissions from databases, file stores, wikis, and SaaS
tools. An **ontology pipeline** maps everything onto a shared semantic model — a fixed
core ontology plus agent-drafted, human-approved domain extensions. The result is a
per-isolated-tenant **knowledge graph** that stores not just facts but *where each
fact came from* and *who is allowed to see it*. **Retrieval** is hybrid (vector +
keyword + graph traversal) but always permission-filtered; **agents** access it through
a controlled tool catalog and answer with **citations pointing at the original source
— down to the page and bounding box for documents**. An **API plane** (REST, GraphQL,
MCP, webhooks) lets clients integrate the map into their own systems and agents.

## Terminology shortcuts

- **Ontology** — the schema of types and relationships (the "map legend").
- **Knowledge graph** — the actual mapped data (the "map").
- **TBox / ABox** — ontology terms vs. instance data, stored as separate graphs.
- **Grounding** — exact source location (document, page, bounding box) for an extracted fact.
- **Permission-aware retrieval** — every query and answer is filtered by the requesting user's effective access rights in the source systems.
- **Connector** — a sync component for one source type (Postgres, SharePoint, Jira…).

A full glossary lives in [04-ontology-strategy.md](04-ontology-strategy.md#conventions)
and inline throughout each document.
# 01 — Product Vision

## What KMap is

KMap turns a company's scattered data and infrastructure into a **single, semantic map**
— an ontology-mapped knowledge graph — and makes that map queryable by **AI agents**,
**APIs**, and **people**, with data isolation, permissions, and provenance enforced
end to end.

The problem it solves: enterprises want agents that actually *know the business*, not
 retrieval-augmented snippets of text. But agents can't reason over what they can't see
 as structure: forty years of databases, file shares, wikis, tickets, and contracts,
 each describing the same customers, projects, and vendors in different words, with
 access rules baked into systems agents can't read.

KMap is the missing layer:

> **Connect your sources → KMap maps them in place → your people and agents get a
> single, permission-aware, provably-sourced view of everything.**

## What the platform offers clients

### 1. The Map (semantic infrastructure)
- A unified knowledge graph over all connected sources — files, databases, SaaS tools,
  APIs, wikis — with one shared vocabulary per client.
- An **ontology** tailored to their business: what *they* mean by "customer," "project,"
  "incident," "agreement."
- Identity resolution: the same real-world entity is one node, whether it arrives from
  the CRM, an invoice PDF, or a Slack thread.

### 2. The Agents (retrieval interface)
- Agents that answer business questions across *all* sources at once, in natural
  language, with **citations pointing to the exact source** — down to the page and
  highlighted region for documents.
- Connecting-factor discovery: non-obvious links between projects, people, documents,
  and systems (shared vendors, duplicate efforts, single points of failure), each with
  an explainable path.
- No hallucinated answers from stale model memory: agents operate in
  **knowledge-graph mode** — grounded in the client's graph, or they say they don't know.

### 3. The APIs (integration)
- Tenant-scoped REST/GraphQL APIs so clients build the map into their own products and
  workflows.
- An **MCP server** exposing the same tool catalog to *their* agents and AI tools.
- Webhooks for graph-change events (new entities, changed relationships, drift alerts).

### 4. The Trust story (isolation & permissions)
- Per-tenant isolation — logically separated by default, deployable inside the client's
  VPC or on-prem estate for regulated industries.
- **Permission-aware retrieval**: employee A's agent doesn't see HR salary data; the
  answer set matches what A could see in the source systems. Access decisions stay
  with source-of-truth systems; KMap enforces, never overrides.
- Append-only audit of every retrieval, agent action, and ontology change.

## How clients experience the value (summary)

| Before KMap | With KMap |
|---|---|
| "Ask IT which systems hold vendor data" | One query: all vendor facts, all sources, cited |
| RAG over a pile of exports, no structure | Graph-grounded answers with provenance paths |
| Two teams build the same feature unknowingly | Duplicate-effort and dependency alerts surface automatically |
| Agent rollouts stalled on security review | Agents inherit human permissions; every call audited |
| New SaaS tool = new silo | Ontology absorbs it; the map stays one map |

## Market positioning

Adjacent players and how KMap differs:

- **Neo4j/GraphRAG stacks** — build throwaway graphs per query or per project; no
  durable ontology, no permission propagation, no client-facing agents.
- **Enterprise RAG vendors** — retrieve text chunks; no entity/model semantics, and
  citations at best point at documents, not facts.
- **Consultancy-built knowledge graphs** (Ontotext, Semantic Arts style) — bespoke,
  ~$500k+, six-month engagements, no productized ops. KMap *is* this outcome, productized.
- **Data catalogs** (Collibra, Alation) — describe tables for humans; don't map content
  semantics or serve agents.

**The defensible asset** is the client-specific ontology + graph under management and
the permission layer; agents are the interface; APIs make it infrastructure.

## Product principles

1. **The map is built once, queried a million times.** Extraction is an ingestion-time,
   scheduled, budgeted job — never a per-question scramble. Agents spend their budget
   on reasoning, not on re-reading the corpus.
2. **Isolation and permissions are load-bearing.** They are designed first, changed last.
3. **Provenance on every fact.** If we can't say where a fact came from and who may see
   it, it doesn't go in the graph.
4. **Agents are curated.** A fixed tool catalog over a governed graph — not an agent
   with a raw database connection.
5. **Client data is the client's.** Deletion propagates through the graph; export is
   always available; no training on tenant data, ever.
6. **Reuse over invention.** Align to schema.org, Dublin Core, SKOS, PROV before
   minting new terms. Standards keep the map integratable.

## Working name

**KMap** (repository: `kmap-service`). A final product name is deliberately not chosen
yet; all identifiers, IRIs, and docs use `kmap` so a rename is a find-replace, not a
re-architecture.

## Related reading

- The customer-facing lifecycle: [02-client-journey.md](02-client-journey.md)
- What sits under the hood: [03-architecture-overview.md](03-architecture-overview.md)
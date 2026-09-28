# 08 — Retrieval & Agents

How the map gets read: hybrid permission-aware search for recall, the agent runtime
as the primary interface, a fixed tool catalog as the *only* way anything touches the
graph, and citations — including document page/bounding-box highlights — as the
output standard. This plane is why the client journey's pilot demo works: ask a
question, get an answer, click the citation, *see the source sentence on the page*.

## Why a tool catalog (and not text-to-query)

Direct nl→SPARQL generation is brittle and leaks hallucinated structure; the literature
and our priors agree. The KMap approach is a **curated, typed, versioned set of
tools** whose schemas are **generated from the active ontology** ([04](04-ontology-strategy.md))
— so when the ontology changes, tool descriptions regenerate and agent behavior
follows the map, never a stale hand-written prompt.

## The retrieval layer (under everything)

Hybrid search + graph services, all ACL-joined at query time ([07](07-security-tenancy-privacy.md#the-permission-model)):

| Engine | Role |
|---|---|
| BM25 (Postgres FTS) | exact/stale-resistant lexical recall |
| Vector search | latent similarity ("these two documents discuss the same revenue-share model in different words") |
| Graph traversal | typed expansion, paths, subgraph extraction, aggregates |

**Every** engine's result is permission-filtered in the query plan; hybrid merge scores
are computed only over permission-valid candidates, so the merge itself can't amplify
hidden content into ranking signals.

## Agent tool catalog (v1)

Version-tagged per-tenant (generated from ontology v(n)):

| Tool | Typed schema highlights |
|---|---|
| `search` | `{query, kinds?, filters?, top_k}` → hit list `{iri, label, score, snippet, grounding}` |
| `get_entity` | `{iri}` → entity record: type, properties, provenance-summarized, `sourceAt` links |
| `expand_relationships` | `{iri, predicates?, direction?, depth, per-hop-permission}` → typed edges |
| `get_document` | `{doc_iri}` → rendition/derived markdown (+ page list) |
| `search_documents` | `{query, doctype?}` → grounded blocks (semantic search over docs) |
| `run_query` | `{sparql/GQL, enforced-shape}` — restricted SELECT surface, injected permission joins |
| `explain_connection` | `{a, b, path_types?, max_hops}` → min-weight meaningful path (typed, with edge provenance) |
| `compare_entities` | `{a, b}` → shared properties, shared contexts, aligned differences |
| `find_similar` | `{iri}` → embed-similar entities, with similarity type |

Notably absent on purpose: `write_*` (nothing in the graph supports agent writes,
[06](06-semantic-infrastructure.md#what-this-layer-refuses-to-be)); raw database
strings; cross-tenant anything.

**Tools run with the requesting user's permissions** — not the agent's, not the
platform's. A single human's session is the security context for all tool calls.

## Agent runtime

```
question
  → intent routing ("metadata question" vs "needs document body" vs "needs graph") 
  → tool calls (budgeted, logged, ACL-context-every-call)
  → answer synthesis with citation assembly + provenance-substantiated claims
  → post-checks (claims without citations get demoted/flagged)
```

- **providers**: model-agnostic (model-router + LiteLLM-style abstraction) so tenants
  can mandate models at T3 — same prompts, same tool schemas, pluggable model.
- **knowledge-graph mode (the Idehen discipline)**: agents must answer from tool
  results. If the map can't answer, they say so, or *explicitly request* permission
  to use the model's general knowledge — never silently blend parametric memory with
  tenant facts. Every answer carries a `grounded: true/false` marker the client UI shows.
- **budgets**: per-persona per-tenant token and tool-call budgets with soft (warn the
  operator) and hard (degrade gracefully to search-only) caps. No runaway agent spend.
- **logging**: every tool call + args + result summary lands in the tenant audit log
  ([07](07-security-tenancy-privacy.md#audit--monitoring)) — both compliance and
  product telemetry (which tools actual questions need is roadmap gold).

## Citations & highlights

The output standard for agents — the thing pure-RAG competitors don't have:

1. **Entity citations** — IRIs with type badge and provenance summary ("from the CRM,
   synced 4 min ago", "from contract.pdf p.7, highlighted region").
2. **Document citations with grounding** — because extraction kept
   `(doc, page, bbox, range)` ([05](05-ingestion-plane.md#documents--landingai-ade-behind-documentextractor),
   [06](06-semantic-infrastructure.md#what-every-published-triple-carries)),
   the answer can render the *exact highlighted region* on the exact page in a doc
   viewer. (Note the engineering invariant: an extraction only grounds against its
   own parse run — enforced at extraction time, verified in CI.)
3. **Claim-level citation binding** — synthesis maps claims → supporting tool results
   → source triple → grounding. An answer is "well-cited" only when each substantive
   claim traces to at least one visible-to-user grounding.
4. **Provenance posture label** — answer level: `tenancy-fresh` (all sources synced
   within SLA) vs `partial-stale` (flags which source's data is older than SLA).

## Connecting factors (the client-journey "wow" assembled from the catalog)

How non-obvious connections materialize for clients without any extra machinery:

- **Shared-entity bridges**: `expand` + `search` — the spec and the procurement
  decision that both reference Acme; type-labeled link rendered as one relationship,
  not a coincidence.
- **Inference-derived risk edges**: property chains in the ontology (e.g.,
  `dependsOn ∘ deprecatedBy → riskExposureTo`) evaluated as query-time rules —
  service-deprecation in project B becomes visible risk for project A.
- **Pathfinding questions**: `explain_connection` — e.g. surfacing that one departed
  employee is the only person linking two critical systems, or that two projects
  pull on the one shared expiring vendor license. Traversal enforces edge-level
  ACLs so hidden-hop paths never render.
- **Latent similarity suggestions**: `find_similar` — surfaced as *suggestions for
  human confirmation* (fuzzy, lower trust tier), confirmed pairs promote into first-
  class edges via the review queue.

All four are explainable by construction (`claim → tool call → triple → grounding`),
which GraphRAG-style systems structurally cannot do — and that difference *is a
slide in the sales deck*.

## Admin/review console surfaces (the plane's UI, client-facing)

- ontology review queue, entity-merge queue, conflict queue (client Stage 5)
- source registry + sync health + drift events ([05](05-ingestion-plane.md#connectors-and-sync))
- audit search, usage/budget dashboards, persona admin
- answer spot-check tool: sample real logged Q/A with their citation paths for
  client QA signoff — "the answer looks right *and the source region verifies*" is
  the demo's non-negotiable end state.

## Performance & cost posture (v1 targets)

- p50 < 2 s / p95 < 8 s for catalog-based answers on a warmed tenant; hybrid search
  p95 < 300 ms.
- Cache layers: permission-scoped entity/search caches keyed by
  `(user-effective-ACL-version, query)`; ontology→tool-schema cache (regenerated
  on ontology version bump); high-frequency entity summaries prepared at write time.
- Cost guardrail: extraction and re-embedding at ingestion-time only ([05](05-ingestion-plane.md#orchestration--scale));
  query-time spend is dominated by cheap small-model routing, so answer cost stays
  proportional to question difficulty, not corpus size.
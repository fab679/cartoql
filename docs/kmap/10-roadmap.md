# 10 — Delivery Roadmap

Phased scope, team shape, and risk register. The governing principle: **walk the
client journey with one design partner before building the fifteenth connector.**
The platform is an operations company as much as a software company; the roadmap
front-loads the pieces that make the pilot demo *true* (permission parity, citations,
provenance) and defers everything that can be layered later.

## Phase 0 — Foundations (weeks 0–4, overlaps with pilot prep)

Goals: the skeletons everything hangs on.
- Repo scaffolding, CI/CD, environments (dev/staging), IaC baseline (Helm chart shape
  from day one — the T3 path depends on it, [07](07-security-tenancy-privacy.md#isolation-tiers)).
- Control store schema (tenants/sources/sync/review/audit/budgets), gateway skeleton
  with tenant routing + audit middleware.
- Core ontology v0.5: the infrastructure classes needed by the three v1 connectors,
  written by hand, SHACL shapes included ([04](04-ontology-strategy.md#layer-1--core-ontology-kmap-owned-hand-curated-versioned-shipped-with-the-product)).
- Security baseline: vault, mTLS mesh skeleton, threat model for ingestion + retrieval.
- The **permission model spec** — written and reviewed before any retrieval code
  (it's the one thing that can't be refactored mid-flight). Deliberate close-out of
  the open decisions in [03](03-architecture-overview.md#deliberate-open-decisions-tracked-here-until-closed)
  that block code: graph store selection via a 1-week bake-off (per-tenant named
  graphs + permission-filtered traversal benchmark).

**Deliverable that proves Phase 0:** an end-to-end "hello map" pipeline — one Postgres
table → connector → ontology mapping → published graph → one permission-filtered
agent/search call with audit entries, running in CI as a smoke test.

## Phase 1 — Pilot with one design partner (weeks 4–12)

The [client journey](02-client-journey.md) stages 1–5, executed once, for real.
- v1 connector set: Postgres CDC, file storage (S3/Drive), Jira ([05](05-ingestion-plane.md#the-v1-connector-set-three-deliberately)).
- Extraction: `DocumentExtractor` interface with the LandingAI ADE implementation
  (Parse→Extract→Ground, ZDR posture, pinned model snapshots) + a minimal local
  fallback good enough for one tenant's scanned docs.
- Ontology pipeline v1: draft→align→validate→review-gate→version (the human review
  UI can be ugly; it cannot be skippable).
- Retrieval: hybrid search + first five agent tools
  ([08](08-retrieval-and-agents.md#agent-tool-catalog-v1)); citations with
  document page/bbox rendering.
- The **permission test suite** for this tenant, and the GDPR synthetic-person
  deletion probe in staging ([07](07-security-tenancy-privacy.md#verification)).
- Admin console minimums: source registry, review queues, audit search — the client
  must be able to *see* the machine behaving ([02](02-client-journey.md#stage-4--map-graph-construction-ongoing-but-heaviest-at-first)).

**Deliverable that proves Phase 1:** the 20-question demo: ≥16 answered with
domain-expert-approved citations, including permission-refusal cases, in front of the design
partner's domain expert — with their ontology review session history attached.

**Deliberately not in Phase 1:** billing, SCIM, webhooks, MCP, SDKs, multi-source
tuning at scale, a second connector's polish. The pilot's job is to prove the trust
story and the extraction reality, not to be a product day-one.

## Phase 2 — Production v1 (months 3–6)

The pilot partner + 1–2 more clients run in production (client journey stages 6–7).
- Production hardening of sync (freshness SLOs, drift alerting, dead-letter triage),
  entity resolution steady-state, budget guards on agents.
- API plane v1: REST + GraphQL + webhooks + SDKs, metering, versioning machinery
  ([09](09-api-plane.md)).
- SSO/SCIM, tenant onboarding automation, sandbox tenants.
- SOC 2 Type I evidence collection begins now (it cannot be backfilled cheaply);
  first external pen test scheduled.
- Ops: 24/7 monitoring, incident process, quarterly access-review ritual — the
  process, not just the tooling.

**Deliverable that proves Phase 2:** client team members get cited answers
day-to-day without our help; at least one client-built integration live against API v1.

## Phase 3 — v1.5 (months 6–10, iterate with 3–5 tenants)

- MCP server + client-agent parity testing.
- Connector expansions (set chosen by client demand signal from Phase 2 sales
  conversations — include at least one of Snowflake/BigQuery and
  Confluence/SharePoint-wikis).
- Ontology auto-approval "shadow mode" graduating to promote-after-observation
  ([04](04-ontology-strategy.md#the-ontology-lifecycle-agent-generated-human-governed)) — measured by the
  approval-rate health metric.
- Webhook consumer tooling, usage dashboards for clients, embeddable citation
  components (if design-partner asked).
- Vector/Cost trimming: aggressive grounding-keyed caches, small-model routing as
  default for boring legs.

## Phase 4 — v2 (months 10–16+)

- **T3 deployments** (VPC/on-prem packaging: local-extractor-only mode, client-hosted
  models, BYOK) — reasons it's here and not earlier: without Phase 2's ops maturity
  it would be a promise we can't staff.
- **T2 dedicated instances** as a self-serve tier if demand justifies.
- SOC 2 Type II report period completes; ISO 27001 initiation; HIPAA BAA path if a
  healthcare partner exists.
- Horizontal *depth*: more agents/personas, deeper ontology libraries per vertical
  (started from repeated client patterns — first vertical chosen by Phase 2 pull),
  cross-project connecting-factor packages
  ([08](08-retrieval-and-agents.md#connecting-factors-the-client-journey-wow-assembled-from-the-catalog))
  turned into a named product surface (dup-effort alerts, concentration-risk views).

## Ongoing/always

- Extraction reproducibility: pinned model snapshots; no silently-changing defaults.
- Security ritual cadence (permission suite every deploy; negative probes quarterly).
- Documentation-of-record: these docs, versioned with the code, updated in the same
  PR as the changes they describe.

## Team shape (first year, realistic)

| Role | Count | Notes |
|---|---|---|
| Platform/data engineers | 2 | connectors, sync, landing store — the relentless tier of the work |
| Graph/semantics engineer | 1–2 | ontology tooling, SHACL, SPARQL/graph modeling, permission-layer queries |
| Agent/LLM engineer | 1 | agent runtime, tool catalogs, extraction schemas, model routing |
| Infra/security engineer | 1 | isolation tiers, vault, audit, compliance interfaces |
| Full-stack | 1 | admin console, review queues, citation viewer |
| Product/founder (that's us) | 1 | pilot delivery, ontology review facilitation, sales narrative |

The ontology theory is learnable; the connector/CDC grind is where projects in this
class die — hire for the grind, learn the theory, and use the review gates to
compensate for theory gaps (the domain expert's knowledge enters the system
through those sessions — that's what they're *for*).

## Risk register (top risks, ranked by expected pain)

| # | Risk | Mitigation |
|---|---|---|
| 1 | Connector/CDC grind consumes the roadmap | 3 connectors max in v1; strict connector contract ([05](05-ingestion-plane.md#connector-contract-every-connector-implements)); say no to exotic sources until v2 |
| 2 | Permission parity gaps erode the core promise | permission suite gates every deploy; fail-closed defaults; the refusal is part of every demo |
| 3 | Infosec fatigue stalls enterprise sales (client security reviews are slow) | tier answers pre-written ([07](07-security-tenancy-privacy.md#isolation-tiers)); DPA/SOC2/subprocessor pack from Phase 0; design partners get the security narrative early |
| 4 | Ontology quality at scale (agent drafts drift or hallucinate schemas) | reuse-over-mint rules; approval-rate metric; drafts never merge silently |
| 5 | Unit economics (LLM/context cost per answer) | ingestion-time-only extraction, cache layers, small-model routing; budgets per persona and app; margin reviewed per tenant monthly |
| 6 | Extraction vendor concentration (LandingAI dependency) | `DocumentExtractor` abstraction + working local fallback from Phase 1, not Phase 3; ZDR + EU endpoints for trust posture |
| 7 | Isolation layers diverge from SaaS reality (T3 claims outpace actual packaging) | T3 scope deferred until ops mature (above); CI promotion test T1→T2 keeps the deployment story honest |
| 8 | Client review queues get neglected (graph drifts between "real" and "what humans approved") | steady-state review budget agreed at kickoff ([02](02-client-journey.md#stage-5--review--approve-the-trust-gate-continuous-with-sharp-first-pass)); health dashboards surface queue neglect |

## First milestone, restated for team alignment

One tenant, deployed per their isolation requirement: one Postgres + one file share
connected, core ontology + one domain extension mapped, agent answering 20 real
business questions with citations, permission parity demonstrated by working refusals,
audit log exporting everything. If that closes a design partner, everything in this
document set earns its keep. If it doesn't, we learned the exact sentence that failed —
and the docs are the first thing we revise.
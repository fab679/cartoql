# 02 — Client Journey

The lifecycle of a customer relationship with KMap, from first conversation to steady-state
operation and expansion. Each stage lists what the client does, what we do, what they receive,
and the exit criteria that make the next stage worthwhile.

```
Discovery → Pilot → Connect → Map → Review & Approve → Launch → Operate → Expand
 (sale)    (design  (sources  (graph    (trust gate)      (agents  (SLA +   (more sources,
            partner)  live)     builds)                   + APIs)   support)  deeper domain)
```

---

## Stage 1 — Discovery (week 0–1)

**Client does:** describes the business questions agents should answer and where the
relevant data lives. We inventory candidate sources and access realities.

**We do:** a structured intake — data sources, volumes, access models, security
constraints, 20 target questions. Score sources by (a) value to those questions,
(b) extraction difficulty, (c) permission clarity.

**Client receives:** a written *Feasibility & Value Brief* — which 3–5 sources go first,
which questions become demo-able, known risks (scanned docs, messy schemas), and an
isolation tier recommendation (see [07](07-security-tenancy-privacy.md#isolation-tiers)).

**Exit criteria:** client agrees on a pilot scope and the 20 questions; security/procurement
path is visible (SOC 2 report, DPA, subprocessor list including the document-extraction
vendor).

## Stage 2 — Pilot / Design Partner (weeks 1–6)

A bounded engagement: one deployment, 2–3 sources, the core ontology plus a first domain
extension, one agent.

**Client does:** provides read-only credentials to pilot sources, a domain expert for
2–3 ontology review sessions (2 hours each), and clears any VPC/network prerequisites.

**We do:**
- Stand up the tenant (isolation tier as recommended).
- Build and run the first connector set end to end.
- Draft the client domain ontology with the ontology pipeline; run the human-review
  gates; publish ontology v1 (see [04](04-ontology-strategy.md#the-ontology-lifecycle-agent-generated-human-governed)).
- Demo: the pilot agent answering the agreed 20 questions with citations, including 2–3
  permission-audited answers (an HR-sensitive question answered correctly for an
  authorized user and *refused* for an unauthorized one — the refusal is part of the demo).

**Client receives:** the working proof, a gap report (questions the graph couldn't yet
answer and why), and a production proposal.

**Exit criteria:** ≥16 of 20 questions answered with approved citations; permission-layer
test suite passes 100% (this suite is written during the pilot and kept forever).

## Stage 3 — Connect (production onboarding, weeks 6–10)

**Client does:** provisions production read-only credentials (or an ingestion role with
minimal privileges); nominates a data owner per source; signs off the deployment target
(SaaS tenant / VPC / on-prem).

**We do per source:**
- Connector configuration: sync mode (CDC vs. watermark vs. full snapshot), schedule,
  ACL extraction options.
- Credential handoff into the secrets manager — never in config files, never in tickets.
- An *ingestion profile*: what object types are mapped to which ontology classes, which
  fields become properties, which become relationship targets.

**Client receives:** a live **Data Source Registry** in their admin console — every
connected source, its sync state, record counts, last drift detection, failure queue.

**Exit criteria:** all production sources syncing on schedule with zero unexplained
discrepancies over two consecutive weeks.

## Stage 4 — Map (graph construction, ongoing but heaviest at first)

Runs continuously after connection, but the first full pass is a project:

**What happens:** extraction, entity resolution, ACL propagation, ontology mapping,
validation, publication — the full pipeline in [05](05-ingestion-plane.md) and
[06](06-semantic-infrastructure.md). Documents pass through the document extractor
(LandingAI ADE or the local fallback) and emerge as *grounded* facts: text, plus page
and bounding-box provenance.

**Client receives:**
- A **Map Health Dashboard**: entity counts, resolution confidence distribution,
  unmapped objects (things in sources the ontology doesn't yet describe), conflict
  queue (contradictory facts across sources).
- The **review queues** (read on in Stage 5).

**Exit criteria:** resolution confidence ≥ agreed threshold (default 0.85) on core
entity types; unmapped objects < 5% of inventory; conflicts triaged.

## Stage 5 — Review & Approve (the trust gate, continuous with sharp first pass)

Human review is where the machine-built map becomes *credible*, and it's budgeted, not
open-ended:

| Queue | What's reviewed | Who reviews | Effort shape |
|---|---|---|---|
| Ontology proposals | new classes, properties, relationships drafted by the ontology agent | client domain expert + us | 2–3 sessions during first pass; then ≤1 h/week |
| Entity resolution merges | "Acme Corp / ACME Inc. / cust#17" merge decisions above an ambiguity threshold | client data owner | first pass bulk; then ≤30 min/week |
| Low-confidence extractions | document fields below confidence threshold (Verity word-level or equivalent) | client ops or us by arrangement | exception-driven |
| Conflicts | contradictory facts (pricing terms that disagree between contract and spec) | domain expert | exception-driven |

The workflow is designed to shrink: proposals come pre-drafted with evidence links, and
approval rates are tracked so the *pattern-matched-approve* set grows over time.

**Client receives:** an **Audit & Approval log** — who approved what, when, on what
evidence — which becomes their internal governance artifact.

**Exit criteria:** domain ontology v1 signed off; review queue steady-state < 2 h/week total.

## Stage 6 — Launch (weeks 10–14)

**Client does:** picks the interface rollout order: agent(s) → API integration → MCP.

**We do:**
- Configure the agent personas (e.g., "Research Analyst," "Ops Copilot") against the
  tool catalog; set per-persona spending and rate limits; enable agent action logging.
- Issue API credentials; walk their engineers through the OpenAPI spec, webhooks, and
  MCP endpoint against a sandbox tenant.
- Run the acceptance test: the 20 pilot questions, re-run in production mode, plus
  permission suite, plus a load/shaping test on the API.

**Client receives:**
- **Agent access** for their users (SSO-gated, per-user permissions inherited).
- **API v1 keys** and SDKs; webhooks wired to their systems.
- **Runbooks:** what to do when a sync fails, when sources drift, when to escalate.

**Exit criteria:** their teams are getting cited answers day-to-day without our help;
at least one internal integration live against the API.

## Stage 7 — Operate (steady state)

**We do (product obligations):**
- 24/7 sync monitoring, alerting, and remediation; monthly map-health reports.
- Ontology maintenance: drift proposals surfaced as diffs awaiting review, never silent.
- Security operations: quarterly access reviews, audit log retention, incident response
  with defined SLAs.
- Cost governance: token/credit budgets per tenant with soft and hard caps.

**Client receives:** SLA coverage (sync freshness, API availability, agent answer
latency p50/p95), a quarterly "What the map knows now" report (new entity classes,
new connections discovered, review-queue stats), and support channels.

## Stage 8 — Expand

The expansion motions, in the order they usually happen:
1. **More sources** — each new connector rides the existing pipeline; the ontology grows
   by alignment, not redesign.
2. **More agents / more personas** — new tool bundles or client-built agents via MCP.
3. **Deeper automation** — webhooks plus their workflow systems (e.g., auto-flag
   cross-project dependency risks into Jira).
4. **New departments / subsidiaries** — same tenant, new ACL domains; or new tenants
   with shared ontology profiles if isolation demands it.

## Commercial shape (v1 assumptions, revisited quarterly)

- Setup + design-partner pilot: fixed fee, heavily discounted for the first cohort.
- Production: platform subscription scaled by (sources, graph size, agent usage tiers,
  isolation tier) — the isolation tier is the clearest price differentiator
  (SaaS < VPC < on-prem).
- Optional: ontology authoring services for the first pass (the human-review sessions),
  priced as professional services; over time this should collapse into the product.

## Journey-level guarantees

Whatever the stage, three things never change — they're in the contract, not the roadmap:
1. **Per-tenant data isolation** at the promised tier.
2. **Permission parity** — no KMap answer reveals anything the requester couldn't see in
   the source system.
3. **Provenance** — every fact in every answer links back to source, page, and
   extraction run.
# 05 — Ingestion Plane

The ingestion plane turns client systems of record into graph-ready, ACL-tagged,
provenance-carrying triples. It is the largest engineering surface in the platform
and is treated as the product's primary risk area: connectors, not LLMs, are where
projects like this traditionally die.

```
connector → landing → extraction → resolution → ACL propagation
        → ontology mapping → validation → review gates → publication
```

Every stage is a durable, idempotent Temporal workflow. Every stage writes progress
to the control store (Postgres). Nothing downstream ever re-reads the client source
to reprocess — the landing store is the replay source of truth.

## Connectors and sync

### The v1 connector set (three, deliberately)

| Connector | Modes | Notes |
|---|---|---|
| PostgreSQL (and any wire-compatible warehouse) | CDC via logical replication; watermark; full snapshot | The reference connector; most warehouses and BI databases reduce to it |
| Object/file storage (S3, SharePoint, Google Drive) | Poll + event notifications (S3) | Files, documents, spreadsheets; drives extraction + grounding |
| Jira (or one ticketing system) | REST polling watermark | Exercises the SaaS pattern: rate limits, page cursors, webhook options |

The pattern target is: *a new source type is ~2 weeks of work*, built from these
shared abstractions. The anti-goal is 20 half-maintained connectors.

### Connector contract (every connector implements)

1. **Inventory** — enumerate objects visible to the service account (tables, buckets,
   projects) with row/object counts; feeds the client's Data Source Registry.
2. **Auth** — credentials only via the vault (per-tenant secrets, never config files);
   documented required privilege is **read-only** for data **+ read for
   access-control tables** (ACL extraction requires it; connectors are provisioned with
   the minimum that satisfies both).
3. **Sync** — mode chosen per source:
   - **CDC / logical replication** where available (databases): the gold standard;
     change events feed downstream stages incrementally.
   - **Watermark** (SaaS APIs, file stores): poll deltas by updated-at et al., with
     checksums for detection of silent edits.
   - **Full snapshot** (small or uncooperative sources): reconcile-by-diff so the
     graph reflects deletions, not just additions. **Deletion matters**: GDPR erasure
     obligations propagate through the graph; tombstones are emitted to the mapping
     stage.
4. **Schema drift detection** — new/dropped columns, type changes, renamed objects
   surface as drift events; the ontology pipeline turns them into proposals
   ([04](04-ontology-strategy.md#the-ontology-lifecycle-agent-generated-human-governed)); sync never silently
   drops or guesses.
5. **ACL extraction** — per object/row/node: owning identity (user/group/role),
   effective read ACL as the source exposes it (e.g., Postgres RLS policies,
   SharePoint item-level permissions, Jira issue-level visibility). This is not a
   nice-to-have stage: retrieval without it violates platform guarantees ([07](07-security-tenancy-privacy.md#the-permission-model)).
6. **Failure semantics** — dead-letter queues, exponential backoff, per-source circuit
   breakers, sync-freshness SLOs with alert thresholds; every connector failure ends
   in a triageable state in the admin console, never a silent gap in the map.
7. **Watermark contract** — a connector can be asked "what changed since X" exactly
   once per downstream consumer, and answers are monotonic and replayable.

### Landing store

Raw captures (rows, files, API pages) land content-addressed (checksum-keyed) in
object storage, partitioned `tenant/source/capture-date`. Immutable; retention
policy per client contract tier (default: retained while the client is active, it is
the replay source). This is what makes every downstream stage safely re-runnable.

## Extraction: structured sources vs. documents

### Structured (databases, SaaS APIs)
Schema-mapping driven: the source's ingestion profile (written during client Stage 3)
maps tables to classes, columns to properties, foreign keys to object properties.
Profiles are expressed *in* the ingestion profile, never as code forks per client.

### Documents — LandingAI ADE behind `DocumentExtractor`

Documents (PDFs, scans, Office files) go through the platform's document-extraction
service, currently LandingAI Agentic Document Extraction in Parse → Extract → Ground
form, abstracted behind a `DocumentExtractor` interface:

```
DocumentExtractor.extract(file, targets) →
   ExtractedBlock {
       text, kind (text|table|figure|card|marginalia),
       confidence,                      # word-level where available
       grounding: {doc, page, bbox, range}
   }
```

Why the abstraction exists: tenants whose documents can't leave their boundary use
the **local fallback** (open-source OCR + layout + vision models); tenants with
EU-residency needs use ADE's EU endpoints; tenants on the strictiest tiers run the
fallback in their VPC. Same interface, three trust postures. Also a hedge: extraction
vendors churn over the platform's lifetime.

**Operational rules (from the field):**
- **Route by file type:** digital PDFs with text layers skip VLM extraction entirely
  (near-free); spreadsheets and legacy Office formats route to the v1 / fallback path
  (v2 ADE does not accept them); scanned/complex-layout content gets full
  Parse with DPT-3 Pro; digital text documents may use the fast model with
  word-level confidence.
- **Schema-driven extraction:** extraction schemas are *generated from ontology
  classes* — a document-type family (e.g., `freightco:BillOfLading`) yields one schema
  with field descriptions as prompts. Constraints (patterns, maxima) are **not**
  trusted to extraction — v2 silently drops unsupported JSON Schema keywords, so
  validation lives in SHACL downstream.
- **Grounding is mandatory:** every extracted fact used to mint a triple carries
  `(document, page, bbox)` provenance (`kmap-core:sourceAt`). This is the raw
  material of highlighted citations ([08](08-retrieval-and-agents.md#citations--highlights)).
  Pair each extraction with its own parse (Ground requires the same-run structure) —
  enforced in code, since a mismatched pair returns wrong boxes *without erroring*.
- **Confidence routing:** word-level confidences below threshold route the doc to the
  review queue.
- **Ingestion-time only:** extraction happens in scheduled jobs, never at question
  time. A document is parsed once, referred to a million times.
- **ZDR posture:** default to Zero Data Retention so nothing lingers vendor-side;
  persist the first completed job response immediately (ZDR revokes fetched results).
  Model snapshots are *pinned* (dated), never floating defaults — reproducibility of
  extraction is an audit requirement.

### Chunking and embedding
Blocks/pages/sections (by document shape) are embedded with grounding metadata carried
into the vector index — every retrieval hit knows the document, page, and region it
came from. Marginalia (headers/footers) excluded. Detail in [06](06-semantic-infrastructure.md#vector-index).

## Entity resolution

The same real-world thing arrives with different names everywhere; resolution makes it
one node:

```
input mentions ── block (cheap keys: normalized name, ids, email domain, ids from
   crosswalks) ── score (string/embedding similarity, key matches, attribute
   compatibility) ──> decide:
     auto-merge   (high confidence)
     propose      (ambiguous → review queue, never silently merged)
     suppress     (explicitly rejected pairs remembered tenant-wide)
```

- Identity by **primary key where it exists** (databases are easy); by
  **attribute clusters** where it doesn't (documents, chat).
- Human decisions are feedback: an approved merge trains the tenant's threshold
  calibrations; a rejection is a permanent suppression.
- Every merge records an equivalence edge with provenance — merges are answers,
  not data loss.

## Ontology mapping pipeline

The agent-driven stage that drafts triples (lifecycle and governance in
[04](04-ontology-strategy.md#the-ontology-lifecycle-agent-generated-human-governed)):

- **Alignment before minting:** link to core classes and external vocab first;
  justify new domain terms to the review queue.
- **Mapping generators:** per-source mapping specs (R2RML-flavored) for databases;
  extraction-schema-shaped extraction for documents; the mapping agents maintain
  both.
- **Validation gates:** SHACL conformance + reasoner consistency, then evidence
  packaged for the human reviewer.

## Publication

The only writer to tenant graphs:
1. All gates passed (validation hard-fails are never published; review-queue items
   publish as drafts visible only to reviewers).
2. Writes are atomic batches: new named-graph partitions or graph diffs, tagged with
   the ontology version and ingestion-run IRI.
3. Vector index updated in the same transaction boundary as graph write.
4. Webhooks emitted for change events; retrieval caches invalidate by partition.
5. The audit log records the run: source, counts, ontology version, approvers.

## Orchestration & scale

- **Temporal** workflows per stage, per source, per tenant. Retries with backoff
  everywhere; poison messages dead-letter, alert, and never block a partition.
- **Fan-out pattern:** create all extraction jobs first, record IDs, then await —
  never serialize a batch behind its slowest document. Batch results persisted on
  arrival: re-runs skip succeeded items.
- **Backpressure:** tenant ingestion concurrency caps; connectors yield to source
  systems (rate-limit aware); the pipeline must never be the load a client notices.
- **Freshness tiers:** sources declare freshness SLAs (e.g., databases 5 min via CDC,
  file stores 1 h, Jira 15 min) and the schedule shapes itself to them.
- **Cost discipline:** transcript/extraction caches keyed by content checksum — a
  re-sync of unchanged content costs nothing; only changed pages re-extract.
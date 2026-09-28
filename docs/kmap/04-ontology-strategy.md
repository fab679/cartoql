# 04 — Ontology Strategy

The ontology is the map's legend: the fixed vocabulary of classes, properties, and
rules that every connected source is expressed through, and the reason an agent can
join an invoice to a CRM record to a project funder without anyone hand-wiring them.

## Two-layer strategy: fixed core, per-client domain extensions

Trying to build one universal business ontology is a swamp; hand-authoring a fresh
ontology per client doesn't scale. KMap commits to the middle path:

### Layer 1 — Core ontology (KMap-owned, hand-curated, versioned, shipped with the product)

Covers the *infrastructure of a company*, which is common across all clients. Agents
draft nothing here; it changes only through our release process.

```
Core classes (indicative v1 set)
─────────────────────────────────────────────────────────────────────
DataSource, Database, Table, Column, ForeignKey
FileContainer, File, Document, Spreadsheet, Image
Person, Group, Team, Department, Organization, Project
Permission, Principal, Role, AccessGrant
Event, Ticket, Contract, Meeting
Concept, Topic                        (SKOS-backed, for tagging/alignment)
…
```

Core properties (indicative): `hasPath`, `hasFormat`, `createdAt`, `modifiedAt`,
`hasChecksum`, `authoredBy`, `partOf`, `belongs`, `derivedFrom`, `references`,
`approvedBy`, `governs`, `covers`, `mentions`, `occurredAt`, `sourceAt` (grounding),
`extractionOf` (provenance run), plus ACL fields (`readableBy`, `visibilityPolicy`).

**Rules for the core:**
- Aligns to public vocabularies wherever exact: `schema.org` (Person, Organization,
  Project, media), Dublin Core (`dc:creator`, `dc:created`…), SKOS (Concept/topics),
  PROV-O (provenance: entity/activity/agent), `dcterms:isPartOf` for hierarchy.
- IRIs use one stable namespace: `https://kmap.example/core#` (final domain chosen at
  branding; the namespace is kept syntactically swappable).
- Every term has `rdfs:label`, `rdfs:comment`, provenance of the term itself
  (`dcterms:issued`, `prov:wasRevisionOf`), and SHACL shapes defining use.

### Layer 2 — Client domain ontologies (per-tenant, agent-drafted, human-approved)

Each client's business semantics: what *they* mean by "customer," "shipment,"
"claim," "policy period." Same mechanics, different change control: drafts come from
the ontology pipeline, merges happen through the review gates.

```
e.g. tenant freightco (illustrative)
─────────────────────────────────────
freightco:Shipment      ⊑ core:Event        ; hasManifest → core:Document ;
                         carrier → Organization ; route → freightco:Route
freightco:BillOfLading  ⊑ core:Document     ; covers → freightco:Shipment
freightco:Customer       ⊑ core:Organization ; shipperOf → freightco:Shipment
```

Domain terms must link upward to a core class (every client thing is *also* an
infrastructure thing) — this is what lets platform features (search, provenance,
permissions, citations) work uniformly across all tenants.

## The ontology lifecycle: agent-generated, human-governed

This is the machine half of the pipeline (engineering detail in
[05](05-ingestion-plane.md#ontology-mapping-pipeline)); the lifecycle and its gates:

```
1 SOURCE SIGNAL      a new tenant source, schema drift, or recurring unstructured
                     content that the current ontology doesn't describe
2 DRAFT              ontology-mapping agent proposes: new classes/properties,
                     hierarchy placement, vocabulary alignment, evidence links
3 ALIGN              map to core + external vocab; reuse > mint (the agent must
                     justify every newly-minted term vs an existing one)
4 VALIDATE           automated: SHACL shape conformance, reasoner consistency
                     (no unsatisfiable classes, no property-domain clashes),
                     naming-convention lint
5 REVIEW             human gate (Stage 5 of the client journey): the queue
                     presents each proposal with evidence, diffs, and blast
                     radius (how many existing triples would relabel)
6 VERSION & PUBLISH  approved changes commit to the tenant's TBox graph as a new
                     ontology version; instance (re)mapping jobs are derived
                     automatically where affected
7 NOTIFY             change events via webhooks; agent tool schemas are regenerated
                     so agent behavior follows the map, never a stale prompt
```

**Invariants of the lifecycle:**
- **Proposals are never applied silently.** The graph is only mutated through
  reviewed commits — same discipline as `main` branch protection.
- **Identifiers are stable.** Term IRIs are never renamed or regenerated; edits are
  edits (`prov:wasRevisionOf` chains), so API consumers never break.
- **Everything carries provenance.** Each axiom records: which source evidence, which
  model run, which confidence, who approved, when.
- **Confidence-gated review.** Only the uncertain tail reaches a human. High-confidence
  pattern-matched proposals (same shape as previously approved ones) auto-approve into a
  "shadow" state that promotes silently after an observation window without incident.

## Storage in one paragraph (detail in [06](06-semantic-infrastructure.md))

Ontologies (TBox) and instance data (ABox) live in **separate named graphs** in each
tenant's graph store: `<tenant>/tbox/v{n}` and `<tenant>/abox/{source}/{yyyymm}`. The
active ontology version is a pointer, so a rollback is a pointer flip, and mapping
re-runs are expressed as "re-map abox partition X against tbox v(n+1)."

## Conventions

**Namespaces**
- `kmap-core:` — the product's core ontology (versioned per release)
- `kmap:` — platform system terms (sync runs, budgets, gates) — not client-visible business terms
- `<tenant>:` — one namespace per client domain ontology, vendored under their control contractually
- `ext:` — direct alignments to schema.org / dcterms / skos / prov (always preferred over minting)

**Naming rules** — CamelCase classes (`freightco:BillOfLading`), lowerCamelCase
properties (`shipperOf`), past-tense Boolean-esque events read as facts
(`approvedBy`), never abbreviations, no client jargon that the client didn't
explicitly confirm. Named things (`Acme Corp`) are *instances*, never classes —
class/instance confusion is the #1 agent-drafting failure mode and the primary thing
the validation step is tuned to catch.

**Iteration discipline** — agents may *propose*; only the review gate *merges*. The
first client pass is ontology v1 and produces real work (2–3 expert sessions);
after that, steady-state churn should be diffs small enough to review in minutes.
The ontology health metric reviewed quarterly: fraction of newly proposed terms that
get approved unmodified (high is good — it means the agent has learned the client's
world; low means re-tune the drafting prompts or the alignment library).

## What the ontology buys at query time (why this whole document exists)

Shared-entity joins, inference-derived risk edges (property chains), cross-source
contradiction detection, connection discovery (“explain how these two projects are
linked”), typed citation, permission labels uniform enough to enforce — none of which
work with per-source ad-hoc schemas. Concrete recipes live in
[08](08-retrieval-and-agents.md#connecting-factors-the-client-journey-wow-assembled-from-the-catalog).
# 10 — Project Governance, Operations & Decisions

How the project runs: decision records, release discipline, observability contract,
config reference, community rules. Read together with [CONTRIBUTING.md](../CONTRIBUTING.md)
(contribution mechanics) and [05-roadmap.md](05-roadmap.md) (what's being built).

## ADRs (architecture decision records)

Every load-bearing decision gets a numbered record in `docs/adr/` — statused
(`proposed` → `accepted` → `superseded-by`), never deleted. The IR/SPI/adapter
decisions that shape everything:

| # | Decision | Status |
|---|---|---|
| ADR-1 | Compiler intermediate representation: **portable JSON algebra IR** (inspectable, snapshot-testable, cacheable) — SPARQL serialization is a projection of the IR, never the source of truth | accepted — rationale: security property tests (constraint monotonicity, [09](09-testing-conformance.md)) require inspectable structure; string-based plans are untestable |
| ADR-2 | Document-level single plan (not resolver descent) | accepted — [08](08-performance-engineering.md) |
| ADR-3 | TypeScript/Node LTS for all packages | accepted — graphql-js primitives, federation tooling, OSS reach; embedder language irrelevant (sidecar) |
| ADR-4 | SHACL as the SDL-generation contract (not OWL alone) | accepted — shapes carry cardinality/typing API metadata that OWL doesn't |
| ADR-5 | Security directives are generator-stamped only; client-supplied = rejected | accepted — [03](03-directive-spec.md) |
| ADR-6 | Apache-2.0 | accepted — patent grant for enterprise adoption |
| ADR-7 | No platform concepts in core ("tenant", "client", "review") — all deployment meaning enters through the four SPIs | accepted — [02](02-architecture.md) |
| ADR-8 | Result cache off by default | accepted — [08](08-performance-engineering.md) |

New ADRs required for: any new SPI surface change, cost-model schema major version,
a directive semantic *loosening* (per the security carve-out in [03](03-directive-spec.md#versioning)),
and any deviation from "single execution artifact."

## Governance model

- **Benevolent-dictator + spec-council** while pre-1.0: the founder holds tie-break;
  a small council (aim: 3 core maintainers by M2) owns the spec tables in 03/06.
- **Spec changes** (directive registry, error codes, enforcement rules, semantic
  mapping) go through a lightweight **RFC**: doc PR labeled `rfc`, minimum 7-day
  comment window pre-M2, 14 days for breaking changes; silence by named reviewers
  counts as consent recorded in the PR.
- **Directives are the constitution**: registry changes carry a mandatory leak-analysis
  note (parking-lot gate, [03](03-directive-spec.md)), regardless of how obvious
  the addition seems.
- KMap (the reference embedder) holds **one council voice, not two** — the
  "deployment-neutral or it doesn't ship in the core" rule (05) protects the
  project from becoming a private SDK.

## Release discipline

- Semver; pre-1.0 minors carry the usual caveat ("may shift; pin your versions"), but
  the directive table and error-code contract keep semver-ish additive discipline
  from M1 to keep the M1 API from being a bait-and-switch.
- Release cadence: M1+ — monthly minors, patch windows as needed; every release
  publishes: changelog (spec-table diffs called out separately from code fixes),
  perf band report ([09](09-testing-conformance.md)), and conformance doctor output.
- Security releases follow the [threat-model disclosure policy](07-threat-model.md#reporting--disclosure-securitymd-content):
  coordinated disclosure, patch backports to last two minors.

## Observability contract

Instrumented in core, exposed at `/metrics` (Prometheus naming) + structured logs:

| Metric family | Names (prefix `cartoql_`) | Notes |
|---|---|---|
| Request | `gateway_requests_total{surface,code}`, `gateway_request_duration_seconds{surface}` | surface ∈ {graphql, persisted, federation-rep} |
| Compile | `compile_duration_seconds`, `compile_cost_total`, `compile_rejected_total{reason}` | cost distribution = budget tuning data |
| Plan cache | `plan_cache_hits_total`, `plan_cache_misses_total`, `plan_cache_evictions_total` | hit rate drops = view-version churn signal |
| Store | `adapter_query_duration_seconds{adapter,tier}`, `adapter_inflight`, `adapter_timeouts_total` | |
| SPI timing | `spi_permission_resolution_duration_seconds`, `spi_provenance_binding_duration_seconds` | embedder-owned latency stays visible to them |

Structured logs carry: request-id, SDL version, permission-view version, plan-cost —
**never** result data or principal identifiers beyond what the embedder's audit
contract passes through (their choice, their compliance boundary — core stays out of it).

Metrics can be toggled per family by config; if any metric's runtime cost proves
non-negligible, it ships with an off switch (zero-by-default cost, not zero-by-default
visibility).

## Config reference (`cartoql.json`) — schema-owned

The config file is versioned JSON-Schema (`packages/gateway/config.schema.json`);
docs list it as examples. Config sections:

```
modules[]            shapes, ontology, prefix, datasetScope
security             stamping source, resolver provider + claims mapping, role set
federation           endpoint allowlist, timeouts, retry policy
budgets              defaultPageSize, per-field arg cap, cost-model schema version+constants,
                     algebra node cap, timeout formula constants
caching              plan cache on/off + size, result cache (off) + policy
observability        metrics toggles, log verbosity
protocol-overrides   overlapWindowMonths, code prefix (CQL_* → embedder prefix)
```

Rule: **no behavior that isn't in config or SDL** — no hidden env-var semantics
beyond `CARTOQL_*` connection basics (endpoint, port, log level), which are themselves
documented. Operator surprises are support debt.

## Documentation discipline

- Docs are versioned with the code; every PR that changes behavior updates the doc in
  the same PR (CI lints: doc cross-links resolve, spec tables referenced in tests exist).
- Public docs are the `docs/` set; internal engineering notes live in `docs/adr/` and
  code comments.
- A changelog-level "spec-diff" section is mandatory in release notes — adopters
  integrating against the contract should never need to diff the docs themselves.

## Community

- Code of conduct: standard [Contributor Covenant v2.1](../CODE_OF_CONDUCT.md), enforced by the council.
- Issue triage labels: `spec` (routes to RFC), `adapter:<store>`, `security` (routes
  to private channels — publicly visible security issues get moved to the disclosure
  process, not discussed in-thread).
- "Good first issues" exist from M1 — fixture contributions (new shards, new leak
  probes) are the ideal entry ramp: concrete, spec-adjacent, reviewable.
# 03 — Directive & Error Specification

The **directive registry** and the **error-code contract** are Verax's public interface
surface: everything else (parsers, planner internals, adapters) is replaceable detail.
Stability promises below apply to these tables across minor versions; breaking changes
follow the [standard-versioning](#versioning) window.

---

## Part I — Directive registry (v1)

### Roles of directives

| Who can write them | Where they live | What they do |
|---|---|---|
| **The generator only** (all security semantics) | SDL type/field definitions (`FIELD_DEFINITION`, `OBJECT`) | become algebra constraints; adding constraints — never removing |
| **Any module author** (non-security, ergonomics only) | SDL, or document-level metadata | shaping, formatting, contract carriers |
| **Clients** | only GraphQL-spec directives (`@skip`, `@include`) filed/extension-scoped | never anything else — a client supplying a registry directive on any query/fragment/marsh: **rejected with a typed error code**, not silently ignored |

### Envelope type — most important, and commonly confused

`@scope` governs *how fine-grained* enforcement on a field is; the principal's
*claim set* is provided by the [`PermissionResolver` SPI](02-architecture.md#4-spi-surface-the-oss-ification-seam) and
joined at that granularity. It is *not* a role-assignment mechanism; a field can be
`@scope(FIELD)` for an admin-class principal too — same directive, different resolved subset.

| Directive | Location | Compiled meaning |
|---|---|---|
| `@scope(level: ScopeLevel!)` where `ScopeLevel ∈ {SCHEMA, CLASS, FIELD, EDGE}` | FIELD_DEFINITION | selects enforcement-granularity for the field |
| `@traversalScope(on: String!)` | FIELD_DEFINITION (object-property fields) | the *edge* itself carries visibility metadata joined at expansion time; entities reachable only through invisible edges never materialize |
| `@requireGroup(group: String!)` | FIELD_DEFINITION | visible only when principal's claims include group `group` (e.g., client-IdP group) |
| `@requireRole(role: Role!)` | FIELD_DEFINITION | visible only when principal holds platform `role` (console/admin semantics; embedder-defined fixed set) — **can never grant business visibility**; the compiled plan still includes `@scope`-level constraints |
| `@graphSet(graphs: [String!]!)` | OBJECT / FIELD_DEFINITION | constrains every subtree algebra node to the enumerated named graphs / graph-set names — the deployment-isolation primitive (embedders use this to make cross-domain graph queries unexpressible) |
| `@redactWith(strategy: RedactionStrategy!)` | FIELD_DEFINITION | partial visibility strategies over aggregate-or-null outcomes: `COUNT_ONLY`, `DATE_BUCKETED`, `NULL_WITH_COUNT`, `MASKED` |
| `@minConfidence(v: Float!)` | FIELD_DEFINITION (provenance-mode deployments) | solutions below threshold render as review-pending placeholders keyed by confidence source (`PENDING_LOW_CONFIDENCE`) not as values |
| `@provenance` | FIELD_DEFINITION (provenance-mode deployments) | output struct carries `{runId, groundings[], confidence?}` bound from the solution — payload contract, plan-native (never a post-hoc read-back) |
| `@maxDepth(n: Int!)` | FIELD_DEFINITION | subtree-depth cap, checked before execution |
| `@budget(cost: Int!)` | FIELD_DEFINITION | complexity weight; document cost is summed, checked against the per-request/plan cap with a typed rejection |

### Enforcement rules (normative)

1. **Directives are enforcement points, never grants.** Only the generator (from
   module security annotations) writes security directives. Compile adds constraints,
   monotonic system — rejection on attempt to reduce.
2. **One execution artifact.** Compiled plans are the only executable output;
   no resolver short-circuit, no per-adapter policy peeking.
3. **Fail closed, visibly — but hide on probes.** Explicit selection fails with the
   field `null` + a typed error; existence-probing paths (federation representatives,
   key lookups, filter-by-identifier) return *indistinguishable* nulls, no error.
   Separately tested; never reasoned about case-by-case.
4. **Cost/dept checks precede execution** and produce typed errors, never partial results.
5. **Stale permission information degrades safely:** a `PermissionResolver`
   reporting `staleACL: true` yields `VX_PERMISSION_STALE` on fields whose
   visibility needs the fresh view — item-by-item, not request-wide (only the
   affected fields degrade).
6. **Directly client-supplied registry directives** on any document/fragment →
   `VX_DIRECTIVE_REJECTED` for the whole document.

### Parking lot (proposed, not in v1 — needs design review)

| Directive | Open question |
|---|---|
| `@argSafe(argument: String!)` — arg-level (string) ACL, e.g. only principals allowed to filter on `salary` can send it | argument-level constraints need SPARQL algebra join on bind; $\epsilon$-leak analysis for error messages |
| `@totalCount` — visible-only count companion for list fields | count semantics must be plan-computed; guaranteed non-leaking in aggregates over hidden solutions |
| `@stream` — incremental pagination cursors over triples that change mid-request | cursor semantics under evolving data consistency |
| `@orderByConfidence` | ties to provenance mode; needs confidence-source contract |

---

## Part II — Error-code contract

Branch on **codes**, never messages. All errors carry `extensions`:

```
extensions: {
  code: "VX_…",
  schemaVersion: "v(n)",
  planId: "…" (server-side, for audit/staging repro),
  …code-specific keys below
}
```

| Code | Situation | Code-specific keys | Client guidance |
|---|---|---|---|
| `VX_PERMISSION_DENIED` | explicit field selected, denial resolved | `fieldPath` | hide field gracefully |
| `VX_PERMISSION_STALE` | resolver reported a stale view for a gating directive | `fieldPath`, `aclStaleSource` | retry post-sync; flag data age |
| `VX_SCOPE_UNRESOLVED` | principal/scope resolution failure (IdP issues, malformed claims) | `fieldPath` | reauth; surface to admin if persistent |
| `VX_QUERY_TOO_COMPLEX` | summed cost > cap or depth > cap | `cost`, `cap` | narrow selection / paginate |
| `VX_DIRECTIVE_REJECTED` | client supplied registry directives | `directiveName` | remove; security directives are server-stamped only |
| `VX_ONTOLOGY_STALE` | schema version beyond overlap window requested | `schemaVersion`, `overlapUntil`, `changelogUrl` | migrate the document |
| `VX_SHAPE_MISMATCH` | solution doesn't satisfy the served shape (legacy partition mismatch) | `fieldPath` | check partition freshness; usually a drifted module |
| `VX_PERSISTED_QUERY_NOT_FOUND` | unknown/stale persisted query id | `id` | re-register document (or pull the current hash) |

No error message includes data-derived details (existence, counts, labels of hidden
entities). Messages are logs, not API — the guidance column is the contract.

### Fail-closed *via* code — what each sideshow means (normative)

- Nothing in `data` may reveal what a `VX_PERMISSION_DENIED` field would have shown —
  errors are generated during projection, never drawn **near then removed** (no
  read-then-drop implementations).
- Counted redaction strategies must be plan-computed and proven-leak-free (see 03
  contract for the count-and-binding proof shape).
- A missing/absent field and a hidden field have identical wire shape (`null`, no
  error) *except* when the field was explicitly selected — clients cannot distinguish
  "nothing here" from "something hidden here."

---

## Part III — Introspection, slicing, security metadata

| Principal class | Introspection scope |
|---|---|
| anonymous | off (schema unavailable) — public GraphQL front door is *always closed* in standalone mode unless explicitly enabled |
| client app | served modules only (their slice) |
| platform/embedder admin | + directive coverage report, deprecation inventory, drift triggers |
| auditor | no introspection; fixed audit query |

`__directive` (spec introspection field) reports only the *ergonomic, non-security*
directive set at this level — security directives are visible in SDL served to
platform principals, never to client apps (clients don't need to see enforcement
posture; attackers shouldn't get a tour of it).

---

## Part IV — Versioning

- Semver, aggressively additive. SDL-algorithm deterministic; regeneration of the
  same input graphs produces a byte-identical schema (hash-pinned).
- Breaking change protocol: deprecated field → 12-month overlap (configurable
  per-install; embedders can set different windows), removal accompanied by
  `VX_ONTOLOGY_STALE` with `changelogUrl`.
- Directive registry follows semver *at the registry level* — a directive's compiled
  semantics may tighten (security audit findings) in a *patch* release when the prior
  behavior was a violation of the enforcement rules above; this is documented as a
  **security-fix-forces-minor-or-patch** carve-out and is rare *by design*.
- Persisted-query registrations track `schemaVersion` and the SDL module hash — a
  registration is portable across instances with identical inputs.
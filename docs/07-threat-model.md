# 07 — Threat Model & Security Posture

CartoQL's value proposition is security compilation; the project's credibility therefore
rests on a published threat model, not on claims. This document is the development-time
contract for security work; the public-facing artifacts are `SECURITY.md` (reporting)
and the testkit's leak-probe corpus (proof).

## Assets & trust boundaries

```
clients (untrusted) ──► Gateway [parse → validate → directives → compile → execute]
                          │                ▲                  ▲
                          │                │                  │
                    StoreAdapter      PermissionResolver   module authors
                    (backend;         (embedder SPI;       (semi-trusted: SDL
                     SPARQL store      embedder-controlled  generation input —
                     = trusted-ish      = trusted)           shapes/annotations
                     but query                                            are data!)
                     shaped by us)
```

**Trust levels:** client = untrusted · module sources = semi-trusted (data that shapes
generated maps) · SPIs and backend = trusted (embedder-controlled) · CartoQL core = the
enforcement mechanism itself.

## Threat inventory (STRIDE-flavored, ranked)

### T1 — SPARQL injection via query arguments [M1]
Injection through string values in GraphQL arguments/variables is the classic overlay
bug because RDF query languages have rich string escape semantics.
**Mitigation (all mandatory):**
- every argument compiles to a **bound variable** (06); no string interpolation in
  SPARQL-emitting code — enforced by a CI lint rule on the algebra serializer plus a
  fuzzing property (never a parallel "escape hatch" path, per [CONTRIBUTING.md](https://github.com/fab679/cartoql/blob/main/CONTRIBUTING.md) rule 2)
- fuzz corpus includes adversarial data (quote/escape/null-byte/keyword-injection strings), plus
  unicode homoglyphs (the fuzz suite runs every argument through the compiler and tests
  store-side plan equivalence, no rejection-by-luck)
- Error output never echoes untrusted input or raw query text fragments back to clients

### T2 — SSRF via `SERVICE` federation [M1-federation, M4-federation]
`SERVICE` endpoints are attacker-controllable server-side fetch axes if ever taken
from a client.
**Mitigation:** federation target endpoints are **static-config-only** (declared in
`cartoql.json` exactly as [04](04-integration.md) states — clients can never supply them),
with scheme allowlist (`https:` only by default), only resolvable via DNS at request
time (no runtime redirects followed), per-endpoint rendered as declared class in health
output. No `SERVICE BY <client-string>` of any kind in M1.

### T3 — DoS via complexity attacks [M1]
Contention vectors: nesting depth, high fan-out list fields (triangular access
patterns), heavy aggregation fields, fragment-spread aliasing explosions.
**Mitigation:** `@maxDepth` and `@budget` are checked at document parse,
*before execution*; an operator-facing `explain` endpoint reports what a registered
document's compiled cost is so clients can self-check before shipping;

### T4 — Authorization bypass via malformed/edge directives [M2]
Threat logic: algebra bugs where scopes/traversals/comments/`__typename` pseudo-fields
or fragment-spreads on interfaces reconstruct a field without carrying its constraints.
**Mitigation:** compiler invariant — directives travel **with the field definition, not
the document node** — so any reconstruction, any spread resolution, any alias lookup, or
`__type` recombination re-applies the definition's directives; automated property tests — CI-enforced,
not a review-time judgment call asserts: for every generated type & every reachable retrieval
path in a document, every directive's constraint is present in the compiled plan (AST-level round-trip + algebra inspection).

### T5 — Plan-cache poisoning across principals [M2]
Plans cached under `(schemaVersion, documentShape, permissionViewVersion)` must never be
reused for a different permission view.
**Mitigation:** permissionViewVersion is part of the key (never "just principal id"),
cache lookups are keyed strictly, and the negative-probe suite includes: same document
ID, different principals with overlapping-but-different views — asserting zero plan
reuse and zero result reuse.

### T6 — SDL/module forgery (trust-model violation) [M2]
Module source tampering with stamping metadata: crafted SHACL annotations that *weaken*
enforcement (e.g. annotate something as `public` that shouldn't be).
**Mitigation:** stamping annotation overrides flowing from module files pass through a
**per-module policy gate** (embedder-side SPI, open in standalone mode), tagged with
module author identity; suspicious overrides (widening `@scope PUBLIC` where domain
metadata says restricted) reject with a build-time policy lint, not runtime surprises.
The standalone default is documented: gateway with no configured security = **no
security claims made** (README says this loudly, [04](04-integration.md#path-2--services-mode-security-profiles--permission-sources)).

### T7 — Existence/channel leaks [M2]
Counts, aggregate, sort, filter, error messages, timing side channels revealing the
existence or shape of invisible data ([03](03-directive-spec.md) rules, Part II).
**Mitigation:** existence-blind error semantics (two-track), count/probe fixtures in
the testkit leak corpus, and a standing rule: new aggregates require a written
leak analysis (parking-lot gate).

### T8 — Introspection recon [all milestones]
Schema-driven probing to enumerate enforcement posture or sensitive field shapes.
**Mitigation:** principal-class-scoped introspection ([03](03-directive-spec.md) Part III);
security directives invisible to client principals; anonymous introspection off by default;
exposure of enforcement posture in errors prohibited (codes say permission denied, never
what would have been granted).

### T9 — Replay/session fixation in persisted-query mode [M4]
Persisted query IDs are static, and a registered document goes stale against a security-fixed
schema version.
**Mitigation:** registrations pin `(schemaVersion, module-hash)`; re-registration against a newer schema version is the
standard migration path; expired-past-overlap documents fail with `CQL_ONTOLOGY_STALE`, never
silently serve under a newer schema.

### T10 — Backend store inference timing [since-M1]
Silent expensive-query differential timing reveals facts (e.g. a permission-filtered
query returning fast because a store precomputed restricted subsets).
**Mitigation:** out of CartoQL's colocated control in highly-sensitive deployments —
documented as a **deployment caveat**; recommend embedders co-locate the permission
check with the store, or use result-latency padding as operational policy. Honest note:
mitigating timing fully is beyond an overlay layer's guarantee set.

## Reporting & disclosure (SECURITY.md content)

- Security issues: security@ (address at publication), no GitHub issue for
  vulnerabilities
- Disclosure: coordinated, 90-day default, CVE issuance via GitHub Advisory when a
  compiled artifact is affected (likely components: core compiler, gateway) — never for
  embedder-misconfiguration
- Safe-harbor statement for researchers
- Patch release policy: directive-relevant fixes ship **patch-versioned** with backport
  to the last two minors (security carve-out noted in [03](03-directive-spec.md#part-iv--versioning))

## Security work rituals (cross-referenced, not duplicated here)

- The compiler property test suite (T4/T5 neg-probes) runs in CI on every PR —
  red = merge block, not review judgment
- Quarterly adversarial review of the threat inventory with fresh eyes on each row
- The [kmap security docs](kmap/07-security-tenancy-privacy.md) —
  the reference embedder's deployment — live independently; failures there are embedder
  findings, but KMap-specific leak hunts almost always improve the OSS testkit corpus
  — route them here as fixtures, not just fixes
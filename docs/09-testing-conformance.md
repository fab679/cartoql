# 09 — Testing & Conformance

Verax's claims live or die on two test families: the **fixture corpus** (correctness
and portability) and the **leak-probe corpus** (security). Everything else — fuzzing,
property tests, performance runs — hangs off those. This document defines both, plus
the **adapter conformance levels** that make "works with your store" a meaningful
statement.

## The fixture corpus ("gold shards")

A versioned, in-repo set of small ontologies + SHACL sets + expected artifacts:

```
corpus/
  shards/
    core/            minimal Person/Organization/Publication ontology; shapes; data (~1k triples)
    multilang/       rdf:langString coverage (negotiation, per-language fields)
    typing/          multi-typed entities, unions, interface hierarchies, blank nodes
    graphs/          named-graph scoping, cross-graph duplicate facts (D9)
    pagination/      cursor stability, ordering keys, page-boundary races
    federation/      SERVICE targets (a stub endpoint ships in-repo for CI)
    perf/            scale shard (~250k triples) — only used by perf runs, not correctness CI
  expected/
    sdl/             generated SDL per shard (byte-stable; regeneration must be deterministic)
    plans/           compiled SPARQL algebra per reference document (JSON IR snapshots)
    responses/       expected GraphQL responses per document × shard
```

Normative rules:
- **Snapshot-based**: expected SDL/plans/responses are reviewed artifacts. A change to
  a snapshot goes through review like any contract change — "the generator output
  changed" is visible in diff, not discovered downstream.
- **Every normative rule in [06](06-semantic-mapping.md) maps to at least one fixture**
  (traceability matrix maintained in `corpus/TRACEABILITY.md`; a spec edit without new
  or adjusted fixtures is an incomplete PR).
- Store-independent: correctness fixtures assert *responses*, not store query text —
  portability is a project principle. Plan snapshots (algebra IR) are store-independent
  by construction once the IR decision (ADR-1) holds.

## The leak-probe corpus (security fixtures)

Every fixture is shape-vs-reality pair: data that exists, claims that declare it
invisible to a probe principal.

```
leakprobes/
  filtering/         selected-field denial → null + error code (visible track)
  probes/            key lookups, filter-by-identifier, federation representatives →
                    indistinguishable-from-empty (blind track) — asserting NOT the error path
  counts/            aggregates over partially-visible sets — assert computed over
                    visible candidates only (T7 in [07](07-threat-model.md))
  traversal/         entity reachable only via hidden edges — must not materialize
  cache/             same document, overlapping-but-different principals → zero plan/result reuse (T5)
  injection/         adversarial argument data through the compiler (T1)
  directive-forgery/ client-supplied registry directives → VX_DIRECTIVE_REJECTED (T4)
  cost/              complexity attacks → VX_QUERY_TOO_COMPLEX, pre-execution (T3)
```

Rules:
- One probe = one fixture pair (a probe principal's expected response, a control
  principal's expected response, same document). The *pair* is the test; single-sided
  expectations hide leaks.
- Probes run in CI on **every** PR touching compiler directives, error semantics, or
  caching. Red = merge block ([CONTRIBUTING.md](../CONTRIBUTING.md)).
- The corpus is public in-repo — deliberately. Published probes tell adopters exactly
  what "security compilation" is tested to mean, and invite them to contribute nastier
  ones (classified submissions via [security channels](07-threat-model.md#reporting--disclosure-securitymd-content)
  instead).

## Property-based & fuzz testing

| Property/fuzz | What it asserts |
|---|---|
| Round-trip determinism | document → IR → serialized SPARQL → parsed-back IR equal (serialize/parse stability) |
| Injection fuzz | arbitrary byte-string arguments never produce SPARQL that executes differently than the bound-variable equivalent (T1) |
| Document fuzz | grammar-valid but hostile documents (deep nesting, alias storms, fragment aliasing, duplicated fields across fragments) → parse-time rejection or bounded cost — never runaway compilation |
| Cost monotonicity | adding a selection can never decrease a document's computed cost |
| Constraint monotonicity | adding a directive/re-shaping a field can never remove a constraint from the compiled IR (the compiler's load-bearing invariant, T4) |

## Adapter conformance levels

What "Verax-compatible with store X" means — printed by `verax doctor` per adapter:

| Level | Requires |
|---|---|
| **L0 — Compatible** | full correctness corpus passes through the adapter's SPARQL 1.1 path; response-equivalence to the reference adapter within tolerance (no semantic divergence allowed for level 0) |
| **L1 — Plan-Introspecting** | L0 + exposes query-plan introspection (EXPLAIN or equivalent enough for budget calibration) |
| **L2 — Native-Optimized** | L1 + documented capability uplift (native cancellation, streaming, hint formats) — must still pass L0's semantic-equivalence requirement — this is the bar when adapters claim performance advantages |

In-repo CI runs L0 across ≥3 stores (Jena/Fuseki, Oxigraph, one of GraphDB/Virtuoso
community builds as availability allows); L1/L2 certification is per-store and
needs a documented test run.

## Test tooling (`packages/testkit/`)

CLI surface used by both CI and adopters:

```
verax testkit corpus run [--adapter <name>] [--shards …]
verax testkit leakprobes run [--adapter <name>]
verax testkit fixtures emit --from-shapes <…>       # generated permission fixtures for embedders (04)
verax testkit doctor --adapter <name>              # conformance level report
verax testkit perf run --band reference            # perf regression band vs last tag
```

## Performance test gates (shared with [08](08-performance-engineering.md))

Per release: perf corpus run against reference stores on reference hardware, numbers
recorded in the release log; regression >15% in any band blocks the tag until
triaged (fix or documented budget change — "worse but nobody noticed" never ships).
# Verax — Documentation

GraphQL over RDF, compiled with a plan-level security kernel and provenance-first
semantics. Generated, never mapped; enforced in the plan, never in resolvers.

| # | Doc | Covers |
|---|---|---|
| 1 | [Vision](01-vision.md) | The gap, positioning vs. existing tools, design principles, non-goals, name & license rationale |
| 2 | [Architecture](02-architecture.md) | Generator, compiler, directive registry, the four SPIs, backend adapters, federation interface, repo layout |
| 3 | [Directive & Error Spec](03-directive-spec.md) | Normative directive registry, enforcement rules, `VX_*` error-code contract, introspection scoping, versioning |
| 4 | [Integration Guide](04-integration.md) | Standalone / services / platform-embedder paths, GraphQL-LD migration, deployment notes |
| 5 | [Roadmap](05-roadmap.md) | M0–M4 milestones (M1 = usable-by-anyone endpoint first), standing engineering rules, success signals |
| 6 | [Semantic Mapping](06-semantic-mapping.md) | The RDF→GraphQL impedance manual: types, blank nodes, language tags, inverses, pagination/injection — decision points D1–D10 |
| 7 | [Threat Model](07-threat-model.md) | Assets & trust boundaries, threats T1–T10 with mitigations, disclosure policy |
| 8 | [Performance Engineering](08-performance-engineering.md) | Single-plan execution (the n+1 rejection), cost formula, caches, SLO bands, resource protection |
| 9 | [Testing & Conformance](09-testing-conformance.md) | Gold shards, leak-probe corpus, property/fuzz testing, adapter conformance L0–L2, release perf gates |
| 10 | [Governance & Ops](10-project-governance.md) | ADR log, RFC process, release discipline, observability metrics contract, config reference |
| 11 | [Glossary](11-glossary.md) | The coined vocabulary, one table |

Project home: [../README.md](../README.md) · License: Apache-2.0 ·
Vulnerability reporting: [../SECURITY.md](../SECURITY.md) ·
Contribution mechanics: [../CONTRIBUTING.md](../CONTRIBUTING.md)

## Reading paths

- **Evaluation / adoption** → 01, 04, 05 (then 06 for the semantics you'll hit)
- **Implementation** → 02, 06, 08, 09 (then 03 as the contract under test)
- **Security review** → 07, 09's leak-probe section, 03's enforcement rules
- **Operations** → 10 (metrics, config), 08 (SLOs, limits), 04 (deployment notes)
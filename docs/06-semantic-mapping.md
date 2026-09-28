# 06 — Semantic Mapping: RDF → GraphQL (the impedance manual)

Every decision an implementer hits on day one. Normative for M1. Where a rule has an
M2 interaction (permission filtering), the effect is noted.

## Type resolution

### Multi-typing (the classic clash)

RDF entities carry any number of `rdf:type` values; a GraphQL field returns exactly one
type or a union. Resolution rule, in order:

1. If a node shape targets the entity's class set **exactly**, use its type — normal case.
2. If multiple shapes apply, the **most specific non-abstract shape wins** (deepest in
   the declared `subclassOf` hierarchies among the candidate shapes); ties are broken
   by shape declaration order in the module and emit a **generation-time warning**
   into the module's build log (never silently).
3. If several disjoint shapes could apply and ambiguity is unresolved, the field's
   generated type is a **union** of the candidates; GraphQL clients then use inline
   fragments. Unions are the escape hatch, not the default.
4. Interfaces: node shapes targeting a shared `inheritsFrom`/class hierarchy generate
   a GraphQL `interface` when ≥2 shapes share the parent class. Interface field sets
   are the intersection of member fields.

The generator never invents types: an entity with no covering shape is **not exposed**
at that level (surfaced instead through the generic fallback root `Entity`, see
[Fallthrough](#fallthrough-behavior)).

### Blank nodes

**Skolemize at generation using a deterministic scheme** (`urn:verax:skolem:{shape}:{stable-content-hash}`)
so the same blank node across requests yields the same IRI (stable cursors and
pagination depend on this). Blank nodes are never exposed as opaque `null` ids and
never auto-materialize as first-class types: they appear only as nested payload values
inside their parent's field shape. Blank nodes at the *root* of a query are
inexpressible (no root that returns them is generated).

### Literals & scalars

| XSD datatype | GraphQL scalar | Notes |
|---|---|---|
| string, plain literals | `String` | |
| `rdf:langString` | per-language fields or `@lang` argument (below) | |
| boolean | `Boolean` | |
| integer, long, int, nonNegativeInteger… | `Int` if JS-safe; otherwise `BigInt`-backed `veraxBigint` custom scalar | the generator **must not** silently coerce out-of-range values |
| decimal, double, float | `Decimal` custom scalar **serialized as string** + optional `numericFloat` variant | precision loss is data corruption in finance/ontology contexts; strings are the default, floats are opt-in per field |
| date, dateTime, time, duration, gYear… | custom scalars (`veraxDate`, …) with strict round-trip ISO-8601 parsing | |
| `xsd:anyURI` / IRIs | scalar `IRI` (string) | distinguished because `@key` and hyperlink features require knowing a field is an entity reference |

Property values that don't match the shape's declared datatype **fail the shape** and
the field returns `null` (never a best-effort cast); mismatches surface through the
health reporting channel (`VX_SHAPE_MISMATCH` is for cross-partition cases).

### Language tags (`rdf:langString`)

A multilingual property generates:
- by default: a single field returning the value under the **language-negotiation
  header** (`Accept-Language` style precedence: `?lang` argument > header > module
  default > `@none` fallback > any),
- or, per shape annotation `sh-verax:exposeLanguages: true`: a field per language
  (`labelEn`, `labelFr`, …) plus a map-style `labels` field.

The chosen language of any resolved string rides in the field's scalar (not a
second request), and the value keeps its tag so clients don't lose it — written to
response `extensions` when field-level extensions are enabled for the operation.

## Property resolution

### Directions: forward, inverse, chains

- A field exists per `sh:path` … with **one exception**: single-hop properties only.
  A `sh:path` with length > 1 is **not** auto-flattened — it gets a *generated closure
  field* only when the shape author explicitly names it (`sh-verax:propertyChainField`),
  and it lands as its own typed field (same cost and permission treatment as any hop).
- **Inverse properties**: the generator emits reverse-traversal fields for any object
  property that another shape declares (e.g., `worksFor → worksHereEmployees`), named
  from `sh-verax:inverseOf` when given, else a deterministic auto-name
  (`{property}Inverse`); auto-inverse generation is off by default (noise) and on by
  shape-annotation (`sh-verax:generateInverse: true`).
- **Multi-valued properties are lists by default** (`[X]!` outer non-null when
  `minCount ≥ 0`), because RDF properties are open-world: a single-typed field would
  silently drop values to satisfy GraphQL's shape.

### Named graphs & dataset scope

- A module declares its **dataset scope**: which named graph(s) / graph-set(s) the
  module targets; the generator stamps `@graphSet` … even in standalone mode (with a
  single-graph config this is formality — it becomes the M2 isolation primitive for
  free).
- Default-graph-only stores: scope resolves to the default graph; no special casing
  in the compiler (algebra always carries an explicit graph constraint).

### Duplicate & set semantics

Every generated list field applies `DISTINCT` over the **binding set**
(tuple `[subject, object, graph]`), not on entity IRI alone — the same fact (same s,o)
recorded in two graphs counts once; distinct facts (same s, different o) never collapse.
Aggregate directives (`@totalCount` in parking lot) operate on the deduplicated set.

## Arguments, coercion & injection (security-relevant, applies to M1)

- **Every argument compiles to a SPARQL bound variable** — never string-substituted.
  The compiler emits parameterized SPARQL; continuous fuzz testing asserts no code
  path in core builds a query by concatenation (static lint rule on the algebra
  serializer: string-interpolation in SPARQL positions = CI failure).
- **Value whitelisting**: enum arguments compile to `IN` bindings over declared values.
- **Argument coercion failure** → a single typed error `VX_INVALID_ARGUMENT`
  (`extensions: { argumentPath }`); coercion never falls back to ignoring the argument.
- **Limits**: all list-typed fields carry `first: Int` with a per-module default
  (`sh-verax:defaultPageSize`, default 20) and server max(configurable, default 500);
  `first > max` errors (`VX_QUERY_TOO_COMPLEX`), it does not silently pre-clip.
- **Per-field argument limits**: max 8 typed arguments per field (default; configurable) —
  part of the complexity lint config.

## Pagination & ordering (the client contract)

Cursor-based pagination is **listed-field-only** (no offset field semantics anywhere,
because permission-filtered offsets are a leak vector — counts change underneath you
mid-scroll, never mind concurrent queries):

- Cursor fields: `first` / `after`/`cursor` on every list field (auto-generated).
- **Cursor format** (opaque): base64 of canonical JSON `{orderByKey, lastValue,
  lastIRI, graphHash}`; decoding re-emits the exact query clause — the cursor *is*
  the rebind proof, tied to the **schemaVersion + permissionViewVersion**, so
  a stale view's cursor fails (`VX_PERMISSION_STALE`), not silently returns different rows.
- **Stable order** guarantee: a canonical ordering key is always injected when a field
  is paginated — module default `sh-verax:orderKey` (property definition) or synthesized
  ordering key from `IRI`, so the same page-select traverses the same window. Additive
  ordering options come from `orderBy` argument over **indexed/default orderKey fields
  only** (simple properties, not unions — sorting must be plan-computable, and a
  permission-hidden sort key behaves like a filter, so hidden sorts are exposed-optional).

## Precision & integrity

- Numeric fields: precision-preservation circuit (string-serializing + the
  round-trip test under the adapter corpus).
- Every list's connection shape is `edges { node, cursor }, pageInfo` — fields
  verifiable for `null`-ness per above type rules; fields do not silently drop
  values, and unmatched-shape fact rows always return `null` with health reporting,
  not inferred re-typing.

## Fallthrough behavior

Standalone/undefined-shape entities are still reachable via:
- generic root `entity(iri: ID!)` returning a minimal typed bundle (`iri`, `types[]`,
  properties via a **generic graph probe** field, paginated, restricted to
  the module's declared dataset scope),
- never a schemaless "anything" field — the probe is scope-, cost-, and
  introspection-checked like every other root.

## The pipeline decision points (recorded for implementation)

| # | Decision | Answered | Notes |
|---|---|---|---|
| D1 | Blank nodes at root | **inexpressible** | no generated root returns them |
| D2 | default page size | 20 | module override via shape annotation |
| D3 | decimal serialization | **string** default | `verax-BigInt/Decimal` custom scalars |
| D4 | multi-typed resolution | specific-shape-wins → union fallback | warning on ambiguity, never silent |
| D5 | auto-inverse fields | off by default | shape annotation opts in |
| D6 | ordering guarantee | canonical key always injected | IRI tiebreaker default |
| D7 | injection defense | bound vars + lint rule + fuzz | see security doc |
| D8 | language tag mechanism | `Accept-Language` negotiation first | per-language fields opt-in |
| D9 | list cardinality | `DISTINCT` on binding-set rule | avoid double-count across graphs |
| D10 | default-graph vs named | always explicit graph constraint in algebra | module scope stamped at generation |
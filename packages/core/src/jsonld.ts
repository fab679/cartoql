/**
 * @cartoql/core — JSON-LD output serialization (docs/04 Path 1 response surface).
 *
 * A shaped ResponseData walks hand-in-hand with the plan that produced it: every
 * GraphQL field in the response tree is a compiled FieldExpansion whose `path`
 * IS the predicate IRI, so JSON-LD costs one parallel walk — no mapping file,
 * no context generation ambiguity.
 *
 * v0 output is **expanded form** (IRI keys, @id/@value/@reverse), a deliberate
 * boundary, not an omission: GraphQL field names collide across types
 * (`Person.name` and `Organization.name` can name different predicates), so a
 * single flat `@context` cannot be faithful. Type-scoped compact contexts are
 * the follow-up (see docs/05 roadmap); expanded form is always honest.
 *
 * Encoding decisions (each has a reason, none is an oversight):
 *  - **Subjects**: identity is data — the computed `iri` field (client-selected)
 *    becomes `@id`. Entities without it emit as blank-node resources; richer
 *    identity (always-on iri) is a response-shape change, not an LD concern.
 *  - **Inverses**: inverse expansions carry no subject-side predicate — they
 *    emit under `@reverse` with the path IRI (JSON-LD 1.1 term shape).
 *  - **Nulls are omitted** (JSON-LD has no null): the two-track contract keeps
 *    holding — visible denial still surfaces in `errors[]`
 *    (CQL_PERMISSION_DENIED); existence-blind fields are simply absent, which
 *    is the same shape absence takes. Never emit a null key: it would re-open
 *    the existence channel the schematic removal just closed.
 *  - **Connection wrappers** (`edges`/`cursor`/`pageInfo`) stay JSON-native —
 *    they have no RDF meaning; only `node` is translated.
 *  - **__typename / D4 typeCondition-skip keys** have no predicate and are
 *    dropped.
 *  - Scalars emit as lexical `@value` strings — the adapters' lexical world is
 *    the projection contract; typed literals are a compact-form decision.
 */
import type { Plan, EntityLookup, FieldExpansion } from './ir.js'
import type { ResponseData } from './executor.js'

/** The computed-identity pseudo-path (shared with adapters/assembly). */
export const COMPUTED_IRI = 'urn:cartoql:computed:iri'

/**
 * The wire-vocabulary context: the GraphQL response envelope (data/errors) and
 * the JSON-native structures around entities (connections) get fixed URN terms
 * so EVERY key in the emitted document is context-mapped — the document is
 * strictly machine-valid JSON-LD, and a consumer RDF-ifying it can drop the
 * whole urn:cartoql:wire: / urn:cartoql:root: branch in one filter. Root fields
 * mint terms per request (they are entry points, not predicates).
 */
const WIRE_PREFIX = 'urn:cartoql:wire:'
const WIRE_CONTEXT: Readonly<Record<string, string>> = {
  data: `${WIRE_PREFIX}data`,
  errors: `${WIRE_PREFIX}errors`,
  message: `${WIRE_PREFIX}message`,
  path: `${WIRE_PREFIX}path`,
  extensions: `${WIRE_PREFIX}extensions`,
  code: `${WIRE_PREFIX}code`,
  name: `${WIRE_PREFIX}name`,
  edges: `${WIRE_PREFIX}edges`,
  node: `${WIRE_PREFIX}node`,
  cursor: `${WIRE_PREFIX}cursor`,
  pageInfo: `${WIRE_PREFIX}pageInfo`,
  hasNextPage: `${WIRE_PREFIX}hasNextPage`,
  endCursor: `${WIRE_PREFIX}endCursor`,
}

export interface JsonLdResult {
  readonly '@context': Readonly<Record<string, string>>
  readonly data: unknown
  readonly errors: ResponseData['errors']
}

/** Convert a shaped response to an expanded JSON-LD document, plan-guided. */
export function toJsonLd(plan: Plan, response: ResponseData): JsonLdResult {
  const data: Record<string, unknown> = {}
  const context: Record<string, string> = { ...WIRE_CONTEXT }
  for (const root of plan.roots) {
    if (root.kind !== 'EntityLookup') continue // adapters v0 only run these
    context[root.rootField] = `urn:cartoql:root:${root.rootField}`
    if (!(root.rootField in response.data)) continue
    const raw = response.data[root.rootField]
    data[root.rootField] =
      raw === null || raw === undefined
        ? null
        : root.connectionShaping !== undefined
          ? ldConnection(root, raw)
          : ldEntity(root.children as readonly FieldExpansion[], raw)
  }
  return { '@context': context, data, errors: response.errors }
}

function ldConnection(root: EntityLookup, raw: unknown): unknown {
  const value = raw as { readonly edges?: readonly unknown[]; readonly pageInfo?: unknown }
  const out: Record<string, unknown> = {}
  if (root.connectionShaping?.edges && Array.isArray(value.edges)) {
    out['edges'] = value.edges.map((edge) => {
      const e = edge as { readonly node?: unknown; readonly cursor?: unknown }
      return {
        node: e.node === null || e.node === undefined ? null : ldEntity(root.children as readonly FieldExpansion[], e.node),
        cursor: e.cursor,
      }
    })
  }
  if (root.connectionShaping?.pageInfo && value.pageInfo !== undefined) out['pageInfo'] = value.pageInfo
  return out
}

function ldEntity(expansions: readonly FieldExpansion[], raw: unknown): unknown {
  const entity = raw as Readonly<Record<string, unknown>>
  if (entity === null || typeof entity !== 'object') return null
  // last-wins matches the assembler: duplicate responseKeys (aliased under two
  // type conditions) overwrite each other in the JSON tree the same way
  const byKey = new Map<string, FieldExpansion>()
  for (const e of expansions) byKey.set(e.responseKey, e)

  const node: Record<string, unknown> = {}
  const reverse: Record<string, unknown[]> = {}
  for (const [key, value] of Object.entries(entity)) {
    const expansion = byKey.get(key)
    if (expansion === undefined) continue // not compiled: never invent triples
    // computed identity — the one subject channel (identity is data)
    if (expansion.path === COMPUTED_IRI) {
      if (typeof value === 'string' && value !== '') node['@id'] = value
      continue
    }
    if (expansion.returnsTypename !== undefined) continue // __typename: no predicate
    if (value === null || value === undefined) continue // nulls omitted (header doc)
    if (expansion.itemType.kind === 'class') {
      const nodes =
        expansion.cardinality === 'single'
          ? [ldEntity(expansion.children as readonly FieldExpansion[], value)].filter((v) => v !== null)
          : (value as readonly unknown[]).map((child) => ldEntity(expansion.children as readonly FieldExpansion[], child))
      if (expansion.inverse) reverse[expansion.path] = nodes
      else node[expansion.path] = nodes
      continue
    }
    // datatype: lexical strings → @value objects (expanded-form single shape)
    const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined)
    node[expansion.path] = values.map((v) => ({ '@value': String(v) }))
  }
  if (Object.keys(reverse).length > 0) node['@reverse'] = reverse
  return node
}
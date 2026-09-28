/**
 * @verax/adapter-sparql-http — the default SPARQL 1.1 StoreAdapter (docs/02 §5, tier 0).
 *
 * This module implements the **projection** half: compiled plan → SPARQL SELECT +
 * protocol bindings. Response assembly from SPARQL result JSON and the live-store
 * parity harness land in the next slice (tracked in corpus/TRACEABILITY.md).
 *
 * Projection conformance contract (part of the eventual L0 claim, docs/09):
 *
 *  - one compiled plan; the adapter projects **one SELECT per plan root** — the
 *    adapter-split rule docs/02 §5 explicitly permits ("the adapter, not the
 *    compiler, splits; splitting rules are part of the conformance contract"),
 *    keeping the compiler document-level (ADR-2) honest
 *  - **every client value is a protocol-bound variable** (SPARQL 1.1 Protocol
 *    request parameters `$var=term`): the lookup IRI, the after-cursor IRI —
 *    nothing client-supplied is embedded in query text (docs/06 D7, T1)
 *  - **one recorded exception**: SPARQL 1.1 grammar requires `LIMIT` to be an
 *    integer *literal*, so the page size is validated (integer, clamped
 *    0..MAX_PAGE) and const-inlined. Integers have no escaping surface; the
 *    no-interpolation lint rule applies unchanged to string-typed values.
 *    Mirrors docs/07 T1.
 *  - every pattern tree is wrapped in `GRAPH <scope>` — D10 is *query-visible*,
 *    so a graph-scope bug cannot hide (docs/07 T10 reasoning)
 *  - canonical ordering: `ORDER BY ?root` + after-filter `FILTER(?root > $after)`
 *    implement the IRI ordering (docs/06 D6); `LIMIT first+1` answers hasNextPage
 *    in the same round trip, per the docs/08 single-trip discipline
 *  - OPTIONAL trees follow the plan's expansion shape exactly: nested class
 *    fields become OPTIONAL-wrapped pattern groups; the reference adapter's
 *    evaluation is the semantic target this projection must reproduce
 */
import {
  decodeCursor,
  ExecutorError,
  graphScopeHash,
  resolveBinding,
  type ResolvedVariables,
} from '../../../core/src/executor.js'
import type { EntityLookup, FieldExpansion, Plan } from '../../../core/src/ir.js'

/** Docs/06 D2-adjacent guard: the inlined LIMIT literal lives inside this bound. */
export const MAX_PAGE = 500

/** A projected request: query text plus SPARQL 1.1 Protocol variable bindings. */
export interface SparqlRequest {
  readonly query: string
  /**
   * Variable name → RDF term syntax (`<iri>`). Keys are bare variable names; the
   * HTTP transport turns each into a SPARQL 1.1 Protocol `$var` parameter.
   * Client values only ever leave through here (D7/T1).
   */
  readonly bindings: Readonly<Record<string, string>>
}

/**
 * Project one plan root into a SPARQL SELECT. Deterministic for a given
 * `(plan, rootIndex, variables)`: snapshot tests depend on it.
 */
export function projectRoot(
  root: EntityLookup,
  rootIndex: number,
  variables: ResolvedVariables,
): SparqlRequest {
  const e = `v${rootIndex}_e` // root entity variable
  const bindings: Record<string, string> = {}
  const patterns: string[] = [`  ?${e} a <${root.targetClass}> .`]
  const selected: string[] = [e]

  emitChildren(patterns, selected, root.children as readonly FieldExpansion[], e, 0)

  const scope = root.graphs[0] ?? 'urn:verax:dataset:default'
  const where: string[] = [`  GRAPH <${scope}> {`, ...patterns, `  }`]

  if (root.mode === 'single') {
    const iri = resolveBinding(root.iri, variables, `${root.rootField}(iri:)`)
    if (typeof iri !== 'string' || iri === '') {
      throw new ExecutorError(`${root.rootField}: iri must bind to a non-empty string`)
    }
    // Protocol-bound: the client IRI never appears in query text.
    bindings[e] = `<${iriTermSafe(iri)}>`
  } else {
    where.push(`  ORDER BY ?${e}`)
    const afterTerm =
      root.pagination?.after !== undefined
        ? resolveBinding(root.pagination.after, variables, `${root.rootField}(after:)`)
        : null
    if (typeof afterTerm === 'string' && afterTerm !== '') {
      const cursor = decodeCursor(afterTerm, graphHashOf(root))
      const a = `${e}_after`
      bindings[a] = `<${iriTermSafe(cursor.lastIRI)}>`
      where.push(`  FILTER(?${e} > $${a})`)
    }
    where.push(`  LIMIT ${pageLimitPlusOne(root, variables)}`)
  }

  const query = `SELECT DISTINCT ${selected.map((v) => `?${v}`).join(' ')}\nWHERE {\n${where.join('\n')}\n}\n`
  return { query, bindings }
}

function emitChildren(
  patterns: string[],
  selected: string[],
  children: readonly FieldExpansion[],
  parentVar: string,
  depth: number,
): void {
  // children's array index is document selection order — deterministic naming
  children.forEach((child, index) => {
    const childVar = `${parentVar}_${index}`
    const leaf = `${childVar}_v`
    const arrow = child.inverse ? `^<${child.path}>` : `<${child.path}>`
    selected.push(leaf)
    if (child.itemType.kind === 'class') {
      selected.push(childVar)
      patterns.push(`  ${indent(depth)}OPTIONAL { ?${parentVar} ${arrow} ?${childVar} .`)
      emitChildren(patterns, selected, child.children as readonly FieldExpansion[], childVar, depth + 1)
      patterns.push(`  ${indent(depth)}}`)
    } else {
      patterns.push(`  ${indent(depth)}OPTIONAL { ?${parentVar} ${arrow} ?${leaf} }`)
    }
  })
}

function indent(depth: number): string {
  return ' '.repeat(Math.min(depth, 4))
}

/**
 * Optional-argument resolution: a variable the client did not provide resolves
 * to *absent* (→ the caller's default), unlike resolveBinding, which treats a
 * missing variable as a fail-loud contract violation. Applied only to
 * pagination arguments; the lookup IRI stays strictly required.
 */
function resolveOptional(
  binding: Parameters<typeof resolveBinding>[0],
  variables: ResolvedVariables,
): string | number | boolean | null {
  if (binding !== undefined && typeof binding === 'object' && binding !== null && 'variable' in binding) {
    return variables[binding.variable] ?? null
  }
  return resolveBinding(binding, variables, 'optional')
}

/** LIMIT must be a literal (SPARQL 1.1): validated integer, const-inlined, +1 for hasNextPage. */
function pageLimitPlusOne(root: EntityLookup, variables: ResolvedVariables): number {
  const raw =
    root.pagination?.first !== undefined
      ? resolveOptional(root.pagination.first, variables)
      : null
  const size = typeof raw === 'number' ? raw : root.pagination?.defaultFirst ?? 20
  if (!Number.isInteger(size) || size < 0 || size > MAX_PAGE) {
    throw new ExecutorError(`${root.rootField}: first must be an integer within 0..${MAX_PAGE} — refusing to inline anything else`)
  }
  return size + 1
}

/**
 * Values that leave via protocol bindings still pass a term-syntax guard: an IRI
 * containing `>`/quotes/whitespace cannot be represented as an absolute IRI term
 * and must never be smuggled through. This is defense-in-depth on top of D7 —
 * not the primary injection barrier.
 */
function iriTermSafe(iri: string): string {
  if (/[\s"'<>{}]/.test(iri)) {
    throw new ExecutorError('value is not representable as an absolute IRI term — refused')
  }
  return iri
}

function graphHashOf(root: EntityLookup): string {
  return graphScopeHash(root.graphs)
}
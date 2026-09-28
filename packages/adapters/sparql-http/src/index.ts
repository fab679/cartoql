/**
 * @verax/adapter-sparql-http — the default SPARQL 1.1 StoreAdapter (docs/02 §5, tier 0).
 *
 * Projection conformance contract (part of the L0 claim, docs/09):
 *
 *  - one compiled plan → **one SELECT per plan root** (the adapter-split rule
 *    docs/02 §5 permits; the compiler stays document-level/ADR-2)
 *  - client values travel in one of exactly two transports, both term-level:
 *      a) **protocol binding** (preferred): SPARQL 1.1 Protocol `$var` request
 *         parameters — query text stays client-value-free;
 *      b) **VALUES fallback**: some stores (e.g. Oxigraph 0.5.x) ignore
 *         protocol bindings; the term then rides in a `VALUES ?v { (<iri>) }`
 *         clause — a dedicated value-list grammar position with the same
 *         `iriTermSafe` guard. No client value is ever concatenated into a
 *         free-text syntax position; the docs/07 T1 lint rule is unchanged.
 *    The adapter probes (a) (`bindingMode: 'auto'`) and falls back to (b);
 *    `probeProtocolBinding()` is exported for the conformance doctor.
 *  - **one recorded grammar exception**: `LIMIT` must be an integer literal —
 *    validated (integer, 0..MAX_PAGE) and const-inlined (docs/07 T1 mirrors).
 *  - every pattern tree is wrapped in `GRAPH <scope>` (D10 query-visible)
 *  - canonical ordering: `ORDER BY ?root` + cursor FILTER (D6); LIMIT first+1
 *    answers hasNextPage in the same round trip (docs/08)
 *
 * Response assembly reconstructs the entity tree from SPARQL result rows,
 * client-side sorted, matching the reference adapter's L0 semantics — the
 * parity suite (parity.test.ts, run when VERAX_TEST_SPARQL_ENDPOINT is set)
 * enforces response-equivalence against it.
 */
import {
  decodeCursor,
  encodeCursor,
  ExecutorError,
  graphScopeHash,
  ORDER_BY_IRI,
  resolveBinding,
  type ResolvedVariables,
  type ResponseData,
  type StoreAdapter,
} from '../../../core/src/executor.js'
import type { VeraxModule } from '../../../core/src/compiler.js'
import type { SecurityContext } from '../../../core/src/executor.js'
import type { AlgebraNode, EntityLookup, FieldExpansion, Plan } from '../../../core/src/ir.js'
import { securityConstraints } from '../../../core/src/security.js'

/** Docs/06 D2-adjacent guard: the inlined LIMIT literal lives inside this bound. */
export const MAX_PAGE = 500

export type BindingMode = 'protocol' | 'values' | 'auto'

/** A projected request: query text plus transport bindings (mode-dependent). */
export interface SparqlRequest {
  readonly query: string
  /**
   * Variable name → RDF term syntax (`<iri>`). Keys are bare variable names.
   * Protocol mode: forwarded as `$var` request params (transport (a)).
   * Values mode: these appear (guarded) in the query's VALUES clauses (transport (b)).
   */
  readonly bindings: Readonly<Record<string, string>>
}

export interface ProjectedField {
  readonly node: FieldExpansion
  readonly childVar?: string // present for class-typed fields
  readonly leafVar: string
  readonly children: readonly ProjectedField[]
}

export interface ProjectedRoot {
  readonly root: EntityLookup
  readonly entityVar: string
  readonly fields: readonly ProjectedField[]
}

/** The variable-naming tree shared by projection and assembly (bytes must agree). */
export function projectVars(root: EntityLookup, rootIndex: number): ProjectedRoot {
  const entityVar = `v${rootIndex}_e`
  const fields = walk(root.children as readonly FieldExpansion[], entityVar)
  return { root, entityVar, fields }

  function walk(children: readonly FieldExpansion[], parentVar: string): ProjectedField[] {
    return children.map((node, index) => {
      const childVar = `${parentVar}_${index}`
      const leafVar = `${childVar}_v`
      if (node.itemType.kind === 'class') {
        return { node, childVar, leafVar, children: walk(node.children as readonly FieldExpansion[], childVar) }
      }
      return { node, leafVar, children: [] }
    })
  }
}

export function projectRoot(
  root: EntityLookup,
  rootIndex: number,
  variables: ResolvedVariables,
  mode: BindingMode = 'protocol',
): SparqlRequest {
  const projected = projectVars(root, rootIndex)
  const e = projected.entityVar
  const bindings: Record<string, string> = {}
  const selected: string[] = [e]
  const expansions: string[] = []

  emitFields(expansions, selected, projected.fields, e)

  const scope = root.graphs[0] ?? 'urn:verax:dataset:default'
  const typePattern = `  ?${e} a <${root.targetClass}> .`
  const where: string[] = []

  if (mode === 'auto') {
    throw new ExecutorError("bindingMode 'auto' is resolved by the adapter, not the projection — pass 'protocol' or 'values'")
  }
  const transport = (target: string[], varName: string, term: string): void => {
    if (mode === 'protocol') {
      bindings[varName] = term
    } else {
      target.push(`  VALUES ?${varName} { ${term} }`)
    }
  }

  if (root.mode === 'single') {
    const iri = resolveBinding(root.iri, variables, `${root.rootField}(iri:)`)
    if (typeof iri !== 'string' || iri === '') {
      throw new ExecutorError(`${root.rootField}: iri must bind to a non-empty string`)
    }
    where.push(`  GRAPH <${scope}> {`, typePattern, ...expansions, `  }`)
    transport(where, e, `<${iriTermSafe(iri)}>`)
  } else {
    // LIMIT counts result ROWS and OPTIONAL fan-out multiplies rows per entity,
    // so a row-level limit pages the wrong set. Paginated roots therefore project
    // as: an inner sub-SELECT that windows ENTITIES (type + cursor filter only),
    // and an outer pattern that expands just that window. The live-store parity
    // run caught both this bug and slice-4's modifiers-inside-WHERE grammar bug.
    const inner: string[] = [`    GRAPH <${scope}> { ?${e} a <${root.targetClass}> }`]
    const afterTerm =
      root.pagination?.after !== undefined
        ? resolveOptional(root.pagination.after, variables)
        : null
    if (typeof afterTerm === 'string' && afterTerm !== '') {
      const cursor = decodeCursor(afterTerm, graphScopeHash(root.graphs))
      transport(inner, `${e}_after`, `<${iriTermSafe(cursor.lastIRI)}>`)
      // SPARQL's < / > are undefined for IRIs (evaluates to a type error, dropping
      // the row) — STR() comparison is the defined, portable form.
      inner.push(`    FILTER(STR(?${e}) > STR(?${e}_after))`)
    }
    where.push(
      `  { SELECT ?${e}`,
      '  WHERE {',
      ...inner,
      '  }',
      `  ORDER BY ?${e}`,
      `  LIMIT ${pageSize(root, variables) + 1} }`,
      `  GRAPH <${scope}> {`,
      ...expansions,
      '  }',
    )
  }

  // Scan roots: outer ORDER BY makes row order deterministic — engines are not
  // required to propagate a sub-SELECT's ordering through an outer join, and the
  // assembly depends on result order for canonical windows (D6).
  const outerOrderBy = root.mode === 'scan' ? `ORDER BY ?${e}\n` : ''
  const query = `SELECT DISTINCT ${selected.map((v) => `?${v}`).join(' ')}\nWHERE {\n${where.join('\n')}\n}\n${outerOrderBy}`
  return { query, bindings }
}

function emitFields(
  patterns: string[],
  selected: string[],
  fields: readonly ProjectedField[],
  parentVar: string,
): void {
  fields.forEach((f) => {
    const arrow = f.node.inverse ? `^<${f.node.path}>` : `<${f.node.path}>`
    selected.push(f.leafVar)
    if (f.childVar) {
      selected.push(f.childVar)
      patterns.push(`  OPTIONAL { ?${parentVar} ${arrow} ?${f.childVar} .`)
      emitFields(patterns, selected, f.children, f.childVar)
      patterns.push('  }')
    } else {
      patterns.push(`  OPTIONAL { ?${parentVar} ${arrow} ?${f.leafVar} }`)
    }
  })
}

/** The page size as the client sees it (without the hasNextPage +1). */
export function pageSize(root: EntityLookup, variables: ResolvedVariables): number {
  const raw =
    root.pagination?.first !== undefined
      ? resolveOptional(root.pagination.first, variables)
      : null
  const size = typeof raw === 'number' ? raw : root.pagination?.defaultFirst ?? 20
  if (!Number.isInteger(size) || size < 0 || size > MAX_PAGE) {
    throw new ExecutorError(`${root.rootField}: first must be an integer within 0..${MAX_PAGE}`)
  }
  return size
}

function resolveOptional(
  binding: Parameters<typeof resolveBinding>[0],
  variables: ResolvedVariables,
): string | number | boolean | null {
  if (binding !== undefined && typeof binding === 'object' && binding !== null && 'variable' in binding) {
    return variables[binding.variable] ?? null
  }
  return resolveBinding(binding, variables, 'optional')
}

/**
 * Term-syntax guard: an absolute IRI containing `>`/quotes/whitespace cannot be
 * represented as an IRI term and must never ride in any transport.
 */
function iriTermSafe(iri: string): string {
  if (/[\s"'<>{}]/.test(iri)) {
    throw new ExecutorError('value is not representable as an absolute IRI term — refused')
  }
  return iri
}

// ---------------------------------------------------------------------------
// Capabilities: does this endpoint honor SPARQL 1.1 Protocol variable bindings?
// ---------------------------------------------------------------------------

/**
 * Probe for Protocol variable binding (§2.1.3): a store that honors `$x` params
 * returns `x` bound; one that ignores them (e.g. Oxigraph 0.5.x) returns an
 * empty binding.
 */
export async function probeProtocolBinding(endpoint: string): Promise<boolean> {
  const params = new URLSearchParams()
  params.set('query', 'SELECT ?x WHERE {}')
  params.set('$x', '<urn:verax:protocol-binding-probe>')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!response.ok) return false
  const json = (await response.json()) as SparqlRowSet
  return json.results.bindings.some((row) => row['x'] !== undefined)
}

// ---------------------------------------------------------------------------
// Execution: HTTP round trip + response assembly (L0 semantics targets)
// ---------------------------------------------------------------------------

export interface SparqlHttpOptions {
  /** SPARQL 1.1 query endpoint, e.g. http://localhost:7878/query */
  readonly endpoint: string
  readonly bindingMode?: BindingMode
}

type Row = Readonly<Record<string, { readonly type: string; readonly value: string }>>
interface SparqlRowSet {
  readonly results: { readonly bindings: readonly Row[] }
}

function rootHasSecurityConstraints(node: AlgebraNode): boolean {
  if (securityConstraints(node.constraints).length > 0) return true
  return node.children.some(rootHasSecurityConstraints)
}

export class SparqlHttpAdapter implements StoreAdapter {
  readonly name = 'sparql-http'
  readonly conformance = 'L0' as const
  readonly #endpoint: string
  #mode: BindingMode

  constructor(options: SparqlHttpOptions) {
    this.#endpoint = options.endpoint
    this.#mode = options.bindingMode ?? 'auto'
  }

  async run(
    plan: Plan,
    module: VeraxModule,
    variables: ResolvedVariables,
    security?: SecurityContext,
  ): Promise<ResponseData> {
    void module
    // M2 kernel note: security-stamped plans route through the reference adapter
    // for now. Post-filtering rows *after* the store would leak through counts,
    // cursors, and hasNextPage — so this adapter refuses rather than approximates.
    // Constraint pushdown into SPARQL (permission joins in the projected query)
    // is M2 slice 2; until it lands, fail-closed honesty beats silent leaks.
    if (plan.roots.some(rootHasSecurityConstraints)) {
      throw new ExecutorError(
        'security-stamped plans require the M2 constraint-pushdown kernel — the sparql-http adapter refuses rather than post-filtering (fail closed)',
      )
    }
    if (security && security.view.allowAll !== true) {
      throw new ExecutorError(
        'non-open security contexts require constraint pushdown (M2 slice 2) — refusing to serve without kernel support',
      )
    }
    if (this.#mode === 'auto') {
      try {
        this.#mode = (await probeProtocolBinding(this.#endpoint)) ? 'protocol' : 'values'
      } catch (err) {
        throw new ExecutorError(`cannot reach SPARQL endpoint ${this.#endpoint}: ${(err as Error).message}`)
      }
    }

    const data: Record<string, unknown> = {}
    for (const [index, root] of plan.roots.entries()) {
      if (root.kind !== 'EntityLookup') {
        throw new ExecutorError(`sparql-http adapter v0 only accepts EntityLookup roots, got ${root.kind}`)
      }
      const request = projectRoot(root, index, variables, this.#mode === 'protocol' ? 'protocol' : 'values')
      const rows = await this.#execute(request)
      const projected = projectVars(root, index)
      data[root.rootField] =
        root.mode === 'single'
          ? assembleSingle(projected, rows)
          : assembleScan(projected, rows, variables)
    }
    return { data, errors: [] }
  }

  async #execute(request: SparqlRequest): Promise<SparqlRowSet> {
    const params = new URLSearchParams()
    params.set('query', request.query)
    for (const [name, term] of Object.entries(request.bindings)) {
      params.set(`$${name}`, term)
    }
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500)
      throw new ExecutorError(`SPARQL endpoint returned ${response.status}: ${body}`)
    }
    return (await response.json()) as SparqlRowSet
  }
}

// ---------------------------------------------------------------------------
// Assembly: SPARQL result rows → GraphQL response values (response-equivalence)
// ---------------------------------------------------------------------------

function assembleSingle(projected: ProjectedRoot, rows: SparqlRowSet): Record<string, unknown> | null {
  if (rows.results.bindings.length === 0) return null // absent and invisible share one shape
  return buildEntity(rows.results.bindings, projected.fields)
}

function assembleScan(
  projected: ProjectedRoot,
  rows: SparqlRowSet,
  variables: ResolvedVariables,
): Record<string, unknown> {
  const root = projected.root
  // projection guaranteed ORDER BY ?entity + LIMIT size+1: distinct in result order
  const seen = new Set<string>()
  const order: string[] = []
  for (const row of rows.results.bindings) {
    const bound = row[projected.entityVar]
    if (bound === undefined) continue
    if (!seen.has(bound.value)) {
      seen.add(bound.value)
      order.push(bound.value)
    }
  }
  const size = pageSize(root, variables)
  const page = order.slice(0, size)
  const hasNext = order.length > size
  const graphHash = graphScopeHash(root.graphs)

  const result: Record<string, unknown> = {}
  if (root.connectionShaping?.edges) {
    result['edges'] = page.map((iri) => ({
      node: buildEntity(
        rows.results.bindings.filter((r) => r[projected.entityVar]?.value === iri),
        projected.fields,
      ),
      cursor: encodeCursor({ orderByKey: ORDER_BY_IRI, lastValue: iri, lastIRI: iri, graphHash }),
    }))
  }
  if (root.connectionShaping?.pageInfo) {
    result['pageInfo'] = {
      hasNextPage: hasNext,
      endCursor:
        page.length === 0
          ? null
          : encodeCursor({
              orderByKey: ORDER_BY_IRI,
              lastValue: page[page.length - 1]!,
              lastIRI: page[page.length - 1]!,
              graphHash,
            }),
    }
  }
  return result
}

function buildEntity(rows: readonly Row[], fields: readonly ProjectedField[]): Record<string, unknown> {
  const entity: Record<string, unknown> = {}
  for (const f of fields) {
    const name = f.node.field.split('.')[1]!
    if (f.childVar === undefined) {
      const values = [...new Set(rows.map((r) => r[f.leafVar]?.value).filter((v): v is string => v !== undefined))].sort()
      entity[name] = f.node.cardinality === 'single' ? values[0] ?? null : values
    } else {
      const childVar = f.childVar
      const childIris = [...new Set(rows.map((r) => r[childVar]?.value).filter((v): v is string => v !== undefined))].sort()
      const subEntities = childIris.map((iri) =>
        buildEntity(rows.filter((r) => r[childVar]?.value === iri), f.children),
      )
      entity[name] = f.node.cardinality === 'single' ? subEntities[0] ?? null : subEntities
    }
  }
  return entity
}

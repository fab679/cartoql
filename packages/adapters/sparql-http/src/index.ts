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
  stringLiteralTerm,
  resolveBinding,
  type ResolvedVariables,
  type ResponseData,
  type SecurityContext,
  type StoreAdapter,
  type VeraxError,
} from '../../../core/src/executor.js'
import type { VeraxModule } from '../../../core/src/compiler.js'
import type { AlgebraNode, EntityLookup, FieldExpansion, Plan } from '../../../core/src/ir.js'
import { constraintTrack, evaluateConstraint, securityConstraints } from '../../../core/src/security.js'

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

export interface SecurityProjection {
  readonly security: SecurityContext
  /** The store-side ACL graph the gates join against (module.aclGraph). */
  readonly aclGraph: string
}

/** The kernel v1 ACL vocabulary — IRIs are a registry-fixed scheme (docs/03). */
export const ACL_MEMBER_OF = 'urn:verax:acl:memberOf'
export const groupIri = (group: string): string => `urn:verax:acl:group:${group}`
export const principalIri = (principalId: string): string => `urn:verax:acl:principal:${principalId}`

/** Platform-role membership predicate for store-side role gates (kernel v1 vocabulary). */
export const ACL_ROLE_MEMBER_OF = 'urn:verax:role:memberOf'
export const roleIri = (role: string): string => `urn:verax:acl:role:${role}`

/**
 * SPARQL gate for one constraint (group:/traversal:/role: alike), referencing
 * the transport-bound principal. Roles join the platform-claims vocabulary —
 * role assignments are synced facts in the same ACL graph (embedder model).
 */
function aclGate(constraint: string, aclGraph: string): string {
  const colon = constraint.indexOf(':')
  const prefix = constraint.slice(0, colon + 1)
  const value = constraint.slice(colon + 1)
  if (prefix === 'group:' || prefix === 'traversal:') {
    return `FILTER(EXISTS { GRAPH <${aclGraph}> { ?verax_principal <${ACL_MEMBER_OF}> <${groupIri(value)}> } })`
  }
  if (prefix === 'role:') {
    return `FILTER(EXISTS { GRAPH <${aclGraph}> { ?verax_principal <${ACL_ROLE_MEMBER_OF}> <${roleIri(value)}> } })`
  }
  throw new ExecutorError(`unknown constraint kind in gate emission (${constraint}) — refusing`)
}

export function projectRoot(
  root: EntityLookup,
  rootIndex: number,
  variables: ResolvedVariables,
  mode: BindingMode = 'protocol',
  security?: SecurityProjection,
): SparqlRequest {
  const projected = projectVars(root, rootIndex)
  const e = projected.entityVar
  const bindings: Record<string, string> = {}
  const selected: string[] = [e]
  const expansions: string[] = []

  const gatesFor = (constraints: readonly string[]): readonly string[] => {
    if (security === undefined) return []
    return securityConstraints(constraints).map((c) => aclGate(c, security.aclGraph))
  }

  const rootGates = gatesFor(root.constraints)
  const scope = root.graphs[0] ?? 'urn:verax:dataset:default'
  emitFields(expansions, selected, projected.fields, e, gatesFor, scope)
  const typePattern = `  ?${e} a <${root.targetClass}> .`
  const where: string[] = []

  // principal rides via the guarded transport, exactly like client values (D7
  // discipline applies to kernel-supplied terms too — same VALUES position)
  const bindPrincipal = (target: string[]): void => {
    const term = `<${principalIriTermSafe(security?.security.principalId ?? 'anonymous')}>`
    if (mode === 'protocol') {
      bindings['verax_principal'] = term
    } else {
      target.push(`  VALUES ?verax_principal { ${term} }`)
    }
  }

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
    // entity-level gates: invisible entities resolve zero rows in-store —
    // existence-blind *including* at the store boundary
    for (const gate of rootGates) where.push(`  ${gate}`)
    if (security !== undefined) bindPrincipal(where)
    transport(where, e, `<${iriTermSafe(iri)}>`)
  } else {
    // LIMIT counts result ROWS and OPTIONAL fan-out multiplies rows per entity,
    // so a row-level limit pages the wrong set. Paginated roots therefore project
    // as: an inner sub-SELECT that windows ENTITIES (type + cursor filter only),
    // and an outer pattern that expands just that window. The live-store parity
    // run caught both this bug and slice-4's modifiers-inside-WHERE grammar bug.
    // D1: blank subjects never materialize — isIRI gates the window population
    const inner: string[] = [`    GRAPH <${scope}> { ?${e} a <${root.targetClass}> }`, `    FILTER(isIRI(?${e}))`]
    const ordering = root.ordering
    const orderByKey = ordering?.orderByKey ?? ORDER_BY_IRI
    const ordVar = ordering?.path !== undefined ? `${e}_ord` : undefined
    if (ordVar !== undefined && ordering?.path !== undefined) {
      // order key restriction (docs/06): single-valued scalar leaves. The
      // OPTIONAL carries its own GRAPH scope — the window's type pattern scopes
      // to the named graph, and so must everything else (D10: no hidden
      // default-graph access; the live parity run caught exactly this).
      inner.push(`    OPTIONAL { GRAPH <${scope}> { ?${e} <${ordering.path}> ?${ordVar} } }`)
    }
    const afterTerm =
      root.pagination?.after !== undefined
        ? resolveOptional(root.pagination.after, variables)
        : null
    if (typeof afterTerm === 'string' && afterTerm !== '') {
      const cursor = decodeCursor(afterTerm, graphScopeHash(root.graphs), orderByKey)
      const compare = (left: string): string => {
        // direction-aware pair resume over (lastValue, lastIRI); IRI tiebreak ASC
        if (ordering?.direction === 'DESC') {
          return `(STR(?${left}) < ${stringLiteralTerm(cursor.lastValue)} || (STR(?${left}) = ${stringLiteralTerm(cursor.lastValue)} && STR(?${e}) > STR(?${e}_after)))`
        }
        return `(STR(?${left}) > ${stringLiteralTerm(cursor.lastValue)} || (STR(?${left}) = ${stringLiteralTerm(cursor.lastValue)} && STR(?${e}) > STR(?${e}_after)))`
      }
      if (ordVar !== undefined) {
        transport(inner, `${e}_after`, `<${iriTermSafe(cursor.lastIRI)}>`)
        inner.push(`    FILTER(${compare(ordVar)})`)
      } else {
        // canonical IRI ordering: resume strictly after the cursor's IRI
        transport(inner, `${e}_after`, `<${iriTermSafe(cursor.lastIRI)}>`)
        // SPARQL's < / > are undefined for IRIs (a type error drops the row) —
        // STR() comparison is the defined, portable form.
        inner.push(`    FILTER(STR(?${e}) > STR(?${e}_after))`)
      }
    }
    // equality filters (docs/06): lexical STR() equality, GRAPH-scoped like every
    // pattern (D10). Transport (c): the value rides as an INLINED, guarded
    // string-literal TERM — nested FILTER-inside-EXISTS does not reliably see
    // VALUES-scoped variables across engines (live parity caught it on Oxigraph
    // 0.5); a term position is not an interpolation surface (docs/07 T1), and
    // the guard refuses control characters + escapes quotes/backslashes.
    for (let i = 0; i < (root.eqFilters ?? []).length; i += 1) {
      const filter = root.eqFilters![i]!
      const value = String(resolveBinding(filter.binding, variables, `${root.rootField}(${filter.argName}: …)`) ?? '')
      const fv = `${e}_filter${i}`
      void fv
      inner.push(`    FILTER(EXISTS { GRAPH <${scope}> { ?${e} <${filter.path}> ?${e}_filter${i}_v . FILTER(STR(?${e}_filter${i}_v) = ${stringLiteralTerm(value)}) } })`)
    }
    // entity gates live INSIDE the window sub-select: gated entities leave the
    // population before LIMIT — counts/cursors/hasNextPage see visible only.
    // The principal binds here because the gate references it in this scope.
    if (security !== undefined) bindPrincipal(inner)
    for (const gate of rootGates) inner.push(`    ${gate}`)
    const projectedInner = ordVar !== undefined ? `SELECT ?${e} ?${ordVar}` : `SELECT ?${e}`
    const orderByLine =
      ordVar !== undefined && ordering?.direction === 'DESC'
        ? `ORDER BY DESC(?${ordVar}) ?${e}`
        : ordVar !== undefined
          ? `ORDER BY ?${ordVar} ?${e}`
          : `ORDER BY ?${e}`
    where.push(
      `  { ${projectedInner}`,
      '  WHERE {',
      ...inner,
      '  }',
      `  ${orderByLine}`,
      `  LIMIT ${pageSize(root, variables) + 1} }`,
      `  GRAPH <${scope}> {`,
      ...expansions,
      '  }',
    )
    // project the ordinate so assembly can mint pair-parity cursors
    if (ordVar !== undefined) selected.push(ordVar)
    // field-level gates in the expansions reference the principal too — bind the
    // outer scope when any gate will look it up there
    if (security !== undefined && projectedFieldsHaveGates(projected)) {
      bindPrincipal(where)
    }
  }

  // Scan roots: outer ORDER BY makes row order deterministic AND must mirror the
  // active ordering — engines do not propagate a sub-SELECT's order through an
  // outer join, and the assembly's page slice depends on result order (D6).
  // Outer IRI sorting of an ordered window was a live-parity catch.
  let outerOrderBy = ''
  if (root.mode === 'scan') {
    const ord = root.ordering?.path !== undefined ? `${e}_ord` : undefined
    if (ord !== undefined) {
      outerOrderBy = `${root.ordering?.direction === 'DESC' ? `ORDER BY DESC(?${ord}) ?${e}` : `ORDER BY ?${ord} ?${e}`}\n`
    } else {
      outerOrderBy = `ORDER BY ?${e}\n`
    }
  }
  const query = `SELECT DISTINCT ${selected.map((v) => `?${v}`).join(' ')}\nWHERE {\n${where.join('\n')}\n}\n${outerOrderBy}`
  return { query, bindings }
}

function emitFields(
  patterns: string[],
  selected: string[],
  fields: readonly ProjectedField[],
  parentVar: string,
  gatesFor: (constraints: readonly string[]) => readonly string[],
  scope = 'urn:verax:dataset:default',
): void {
  fields.forEach((f) => {
    // __typename (D4): per-implementer OPTIONAL + BIND marker; assembly maps them
    if (f.node.returnsTypename !== undefined) {
      let markerIndex = 0
      for (const [implIri, typeName] of Object.entries(f.node.returnsTypename)) {
        const marker = `${parentVar}_tn${markerIndex}`
        selected.push(marker)
        patterns.push(`  OPTIONAL { GRAPH <${scope}> { ?${parentVar} a <${implIri}> } BIND(<urn:verax:type:${typeName}> AS ?${marker}) }`)
        markerIndex += 1
      }
      return
    }
    const arrow = f.node.inverse ? `^<${f.node.path}>` : `<${f.node.path}>`
    selected.push(f.leafVar)
    // field gates wrap the field's OPTIONAL contents: an unmet gate yields no
    // bindings for the field — the store enforces the null, existence-blind
    const gates = gatesFor(f.node.constraints)
    if (f.childVar) {
      selected.push(f.childVar)
      patterns.push(`  OPTIONAL { ?${parentVar} ${arrow} ?${f.childVar} .`)
      // D1: blank objects never materialize as related entities
      patterns.push(`    FILTER(isIRI(?${f.childVar}))`)
      for (const g of gates) patterns.push(`    ${g}`)
      // D4: typed-fragment children carry the concrete-class condition inside
      // the OPTIONAL — the store resolves conditions (non-matches bind nothing)
      if (f.node.typeCondition !== undefined) {
        patterns.push(`    FILTER(EXISTS { GRAPH <${scope}> { ?${f.childVar} a <${f.node.typeCondition}> } })`)
      }
      emitFields(patterns, selected, f.children, f.childVar, gatesFor, scope)
      patterns.push('  }')
    } else if (gates.length === 0) {
      patterns.push(`  OPTIONAL { ?${parentVar} ${arrow} ?${f.leafVar} }`)
    } else {
      patterns.push(`  OPTIONAL { ?${parentVar} ${arrow} ?${f.leafVar}`)
      for (const g of gates) patterns.push(`    ${g}`)
      patterns.push('  }')
    }
  })
}

function projectedFieldsHaveGates(projected: ProjectedRoot): boolean {
  const walk = (fields: readonly ProjectedField[]): boolean =>
    fields.some(
      (f) => securityConstraints(f.node.constraints).length > 0 || walk(f.children),
    )
  return walk(projected.fields)
}

/** Kernel-supplied IRIs get the same term-syntax guard as client values. */
function principalIriTermSafe(principalId: string): string {
  if (/[^a-zA-Z0-9:._-]/.test(principalId)) {
    throw new ExecutorError('principal id is not representable in the ACL IRI scheme — refused')
  }
  return principalIri(principalId)
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
export async function probeProtocolBinding(
  endpoint: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<boolean> {
  const params = new URLSearchParams()
  params.set('query', 'SELECT ?x WHERE {}')
  params.set('$x', '<urn:verax:protocol-binding-probe>')
  // a probe is a probe: it borrows the caller's fetcher and it times out — a
  // hung endpoint must not hang capability detection (docs/08)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    })
    if (!response.ok) return false
    const json = (await response.json()) as SparqlRowSet
    return json.results.bindings.some((row) => row['x'] !== undefined)
  } catch {
    return false // probe failure = can't confirm = fall back (values mode is compatible everywhere)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Execution: HTTP round trip + response assembly (L0 semantics targets)
// ---------------------------------------------------------------------------

export interface SparqlHttpOptions {
  /** SPARQL 1.1 query endpoint, e.g. http://localhost:7878/query */
  readonly endpoint: string
  readonly bindingMode?: BindingMode
  /**
   * Hard request timeout in ms for one plan execution (all roots). Default per
   * docs/08: min(30 s, cost x 10 ms) — a cost-scaled budget, not one blunt
   * number. A hung store hangs nothing.
   */
  readonly timeoutMs?: number
  /** Injectable fetch for tests. */
  readonly fetcher?: typeof fetch
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
  readonly #timeoutMs?: number
  readonly #fetcher: typeof fetch
  #mode: BindingMode

  constructor(options: SparqlHttpOptions) {
    this.#endpoint = options.endpoint
    this.#mode = options.bindingMode ?? 'auto'
    this.#timeoutMs = options.timeoutMs
    this.#fetcher = options.fetcher ?? fetch
  }

  async run(
    plan: Plan,
    module: VeraxModule,
    variables: ResolvedVariables,
    security?: SecurityContext,
  ): Promise<ResponseData> {
    // Kernel routing (M2 slice 2): stamped plans enforce IN THE STORE — gates
    // join the module's ACL graph inside the projected query. Everything that
    // would be an approximation is still a refusal:
    //   - stamped plan without a security context (open posture makes stamps
    //     meaningless — the stamping governance cannot have meant that)
    //   - stamped plan without module.aclGraph (no store-side facts to join)
    const stamped = plan.roots.some(rootHasSecurityConstraints)
    const securityProjection: SecurityProjection | undefined =
      stamped && security !== undefined && module.aclGraph !== undefined
        ? { security, aclGraph: module.aclGraph }
        : undefined
    if (stamped && security === undefined) {
      throw new ExecutorError(
        'security-stamped plan without a security context — the open posture makes stamps meaningless; refusing (fail closed)',
      )
    }
    if (stamped && security !== undefined && module.aclGraph === undefined) {
      throw new ExecutorError(
        'security-stamped plan but the module declares no aclGraph — no store-side membership facts to join; refusing (fail closed)',
      )
    }
    if (this.#mode === 'auto') {
      // probe failure = VALUES fallback (compatible everywhere), NOT a refusal:
      // an unreachable endpoint will fail on the real request with the real error
      this.#mode = (await probeProtocolBinding(this.#endpoint, this.#fetcher, this.#timeoutMs ?? 5_000)) ? 'protocol' : 'values'
    }

    const errors: VeraxError[] = []
    const data: Record<string, unknown> = {}
    // docs/08 default: min(30 s, cost x 10 ms); explicit timeoutMs overrides
    const timeoutMs = this.#timeoutMs ?? Math.min(30_000, Math.max(50, plan.cost * 10))
    for (const [index, root] of plan.roots.entries()) {
      if (root.kind !== 'EntityLookup') {
        throw new ExecutorError(`sparql-http adapter v0 only accepts EntityLookup roots, got ${root.kind}`)
      }
      const request = projectRoot(
        root,
        index,
        variables,
        this.#mode === 'protocol' ? 'protocol' : 'values',
        securityProjection,
      )
      const rows = await this.#execute(request, timeoutMs)
      const projected = projectVars(root, index)
      data[root.rootField] =
        root.mode === 'single'
          ? assembleSingle(projected, rows, security, errors)
          : assembleScan(projected, rows, variables, security, errors)
    }
    return { data, errors }
  }

  async #execute(request: SparqlRequest, timeoutMs: number): Promise<SparqlRowSet> {
    const params = new URLSearchParams()
    params.set('query', request.query)
    for (const [name, term] of Object.entries(request.bindings)) {
      params.set(`$${name}`, term)
    }
    // docs/08: a hung store hangs nothing — AbortController + a cost-scaled budget
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await this.#fetcher(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal,
      })
    } catch (err) {
      throw new ExecutorError(
        controller.signal.aborted
          ? `SPARQL request exceeded its ${timeoutMs}ms budget (cost-scaled, docs/08) — aborted, plan not partially answered`
          : `SPARQL request failed: ${(err as Error).message}`,
      )
    } finally {
      clearTimeout(timer)
    }
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

function assembleSingle(
  projected: ProjectedRoot,
  rows: SparqlRowSet,
  security: SecurityContext | undefined,
  errors: VeraxError[],
): Record<string, unknown> | null {
  if (rows.results.bindings.length === 0) return null // absent and invisible share one shape
  return buildEntity(rows.results.bindings, projected.fields, security, errors)
}

function assembleScan(
  projected: ProjectedRoot,
  rows: SparqlRowSet,
  variables: ResolvedVariables,
  security: SecurityContext | undefined,
  errors: VeraxError[],
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

  // cursor parity with the reference adapter: same orderByKey, same ordinate
  const orderByKey = root.ordering?.orderByKey ?? ORDER_BY_IRI
  const ordVar = `${projected.entityVar}_ord`
  const ordinateOf = (iri: string, row: Row): string =>
    root.ordering?.path !== undefined ? row[ordVar]?.value ?? iri : iri
  const result: Record<string, unknown> = {}
  if (root.connectionShaping?.edges) {
    result['edges'] = page.map((iri) => ({
      node: buildEntity(
        rows.results.bindings.filter((r) => r[projected.entityVar]?.value === iri),
        projected.fields,
        security,
        errors,
        projected.entityVar,
      ),
      cursor: encodeCursor({ orderByKey, lastValue: ordinateOf(iri, rows.results.bindings.find((r) => r[projected.entityVar]?.value === iri) ?? {} as Row), lastIRI: iri, graphHash }),
    }))
  }
  if (root.connectionShaping?.pageInfo) {
    result['pageInfo'] = {
      hasNextPage: hasNext,
      endCursor:
        page.length === 0
          ? null
          : encodeCursor({
              orderByKey,
              lastValue: ordinateOf(page[page.length - 1]!, rows.results.bindings.find((r) => r[projected.entityVar]?.value === page[page.length - 1]) ?? ({} as Row)),
              lastIRI: page[page.length - 1]!,
              graphHash,
            }),
    }
  }
  return result
}

function buildEntity(
  rows: readonly Row[],
  fields: readonly ProjectedField[],
  security: SecurityContext | undefined,
  errors: VeraxError[],
  entityVar?: string,
): Record<string, unknown> {
  const entity: Record<string, unknown> = {}
  const firstRow = rows[0] ?? {}
  for (const f of fields) {
    // D4 __typename: per-implementer markers bound in rows; most specific wins
    // (any marker whose type name differs from the containing type)
    if (f.node.returnsTypename !== undefined && entityVar !== undefined) {
      const parentName = f.node.field.split('.')[0]
      const markerNames = Object.keys(firstRow).filter((k) => new RegExp(`^${entityVar}_tn\\d+$`).test(k))
      const matched = markerNames
        .map((m) => firstRow[m]!.value.replace('urn:verax:type:', ''))
        .filter((n2) => f.node.returnsTypename![Object.keys(f.node.returnsTypename!).find((k) => f.node.returnsTypename![k] === n2) ?? ''] !== undefined || true)
      const concrete = matched.find((n2) => n2 !== parentName)
      entity[f.node.responseKey] = concrete ?? matched[0] ?? parentName
      continue
    }
    // D4 conditioned children: when this entity's rows carry NO binding for the
    // condition's fields, the key is OMITTED (reference skips non-matching
    // conditions — existence-blind parity, key-presence included)
    if (f.node.typeCondition !== undefined) {
      const hasAnyBinding = rows.some((r) => r[f.leafVar] !== undefined || r[f.childVar ?? ''] !== undefined)
      if (!hasAnyBinding) continue
    }
    const name = f.node.responseKey
    // Track by prefix, mirroring the reference adapter exactly (parity compares
    // data AND errors): `group:` → visible denial (null + typed error);
    // `traversal:` → existence-blind edge (no bindings, no error — the store-side
    // gate already withheld the rows for exactly this reason).
    let deniedTrack: 'visible-denial' | 'existence-blind' | null = null
    if (security !== undefined) {
      for (const c of securityConstraints(f.node.constraints)) {
        if (!evaluateConstraint(c, security.view).visible) {
          deniedTrack = constraintTrack(c)
          break
        }
      }
    }
    if (deniedTrack === 'existence-blind') {
      entity[name] = f.node.cardinality === 'single' ? null : []
      continue
    }
    if (deniedTrack === 'visible-denial') {
      errors.push({
        message: `field ${f.node.field} requires authorization the principal does not hold`,
        path: f.node.field,
        extensions: { code: 'VX_PERMISSION_DENIED' },
      })
      entity[name] = null
      continue
    }
    if (f.childVar === undefined) {
      const values = [...new Set(rows.map((r) => r[f.leafVar]?.value).filter((v): v is string => v !== undefined))].sort()
      entity[name] = f.node.cardinality === 'single' ? values[0] ?? null : values
    } else {
      const childVar = f.childVar
      const childIris = [...new Set(rows.map((r) => r[childVar]?.value).filter((v): v is string => v !== undefined))].sort()
      const subEntities = childIris.map((iri) =>
        buildEntity(rows.filter((r) => r[childVar]?.value === iri), f.children, security, errors, childVar),
      )
      entity[name] = f.node.cardinality === 'single' ? subEntities[0] ?? null : subEntities
    }
  }
  return entity
}

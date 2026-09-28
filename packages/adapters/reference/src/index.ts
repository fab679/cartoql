/**
 * @cartoql/adapter-reference — the reference StoreAdapter (docs/02 §5, docs/09 L0).
 *
 * Evaluates compiled plans directly over an in-memory n3 store. Its observable
 * behavior IS the platform semantics: the SPARQL 1.1 HTTP adapter must reach
 * response-equivalence with this one to claim L0, and corpus response snapshots
 * are minted here. It deliberately contains no SPARQL — the IR is the contract,
 * not a query language.
 *
 * Security (M2): this adapter is where the kernel's two-track semantics are
 * proven observable (docs/03 rule 3):
 *  - **entity invisibility** (type-level stamps, gated scan populations) →
 *    existence-blind: filtered before windowing, so counts/cursors/hasNextPage
 *    only ever see what the principal may see; zero error entries.
 *  - **field denial** (field-level stamps, explicitly selected) → visible
 *    denial: field resolves null plus a typed error (CQL_PERMISSION_DENIED /
 *    CQL_SCOPE_UNRESOLVED when fail-closed trips).
 *
 * v0 semantics notes:
 *  - the store is one logical dataset; a plan whose graph scope doesn't match the
 *    adapter's scope is refused loudly (D10), never silently re-targeted
 *  - ordering is canonical: entities by IRI ascending (docs/06 D6), literals by
 *    lexical value — pagination cursors depend on both
 *  - datatype fields yield literal lexical values; shape violations throw
 *    ExecutorError (the production stale-shape health channel roots here)
 */
import { Parser, Store } from 'n3'
import type { EntityLookup, FieldExpansion, Plan } from '../../../core/src/ir.js'
import {
  decodeCursor,
  encodeCursor,
  ExecutorError,
  graphScopeHash,
  OPEN_CONTEXT,
  ORDER_BY_IRI,
  resolveBinding,
  type ResolvedVariables,
  type ResponseData,
  type SecurityContext,
  type StoreAdapter,
  type CartoQLError,
} from '../../../core/src/executor.js'
import { constraintTrack, evaluateConstraint, securityConstraints } from '../../../core/src/security.js'
import type { CartoQLModule } from '../../../core/src/compiler.js'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

export class ReferenceAdapter implements StoreAdapter {
  readonly name = 'reference'
  readonly conformance = 'reference' as const
  readonly #store: Store
  readonly #scopeHash: string

  constructor(store: Store, scopeGraphs: readonly string[]) {
    this.#store = store
    this.#scopeHash = graphScopeHash(scopeGraphs)
  }

  static fromTurtle(turtle: string, scopeGraphs: readonly string[]): ReferenceAdapter {
    const store = new Store()
    for (const q of new Parser().parse(turtle)) store.addQuad(q)
    return new ReferenceAdapter(store, scopeGraphs)
  }

  async run(
    plan: Plan,
    module: CartoQLModule,
    variables: ResolvedVariables,
    security: SecurityContext = OPEN_CONTEXT,
  ): Promise<ResponseData> {
    if (graphScopeHash(module.datasetGraphs) !== this.#scopeHash) {
      throw new ExecutorError('plan graph scope does not match adapter scope — the plan may not run here (D10)')
    }
    const errors: CartoQLError[] = []
    const data: Record<string, unknown> = {}
    for (const root of plan.roots) {
      if (root.kind !== 'EntityLookup') {
        throw new ExecutorError(`reference adapter v0 only accepts EntityLookup roots, got ${root.kind}`)
      }
      data[root.rootField] =
        root.mode === 'single'
          ? this.#single(root, variables, security, errors)
          : this.#scan(root, variables, security, errors)
    }
    return { data, errors }
  }

  /** Entity visibility — the existence-blind track. No error entries, ever. */
  #entityVisible(typeClass: EntityLookup, security: SecurityContext): boolean {
    return securityConstraints(typeClass.constraints).every((c) =>
      evaluateConstraint(c, security.view).visible,
    )
  }

  #single(
    root: EntityLookup,
    variables: ResolvedVariables,
    security: SecurityContext,
    errors: CartoQLError[],
  ): Record<string, unknown> | null {
    const iri = resolveBinding(root.iri, variables, `${root.rootField}(iri:)`)
    if (typeof iri !== 'string' || iri === '') {
      throw new ExecutorError(`${root.rootField}: iri must bind to a non-empty string`)
    }
    // Absent and invisible are the same shape here: null, no error entries.
    if (!this.#isOfType(iri, root.targetClass)) return null
    if (!this.#entityVisible(root, security)) return null
    return this.#buildEntity(iri, root.children as readonly FieldExpansion[], security, errors)
  }

  #scan(
    root: EntityLookup,
    variables: ResolvedVariables,
    security: SecurityContext,
    errors: CartoQLError[],
  ): Record<string, unknown> {
    // Population, in order (each stage narrows the world before windowing,
    // so counts/cursors/hasNextPage describe only what survives):
    //   1. existence-blind entity gating (docs/07)
    //   2. equality filters — lexical STR() equality (docs/06)
    //   3. ordering: field key (ASC/DESC) with stable IRI tiebreak, or canonical IRI (D6)
    const ordering = root.ordering
    const orderByKey = ordering?.orderByKey ?? ORDER_BY_IRI
    const ordValue = (iri: string): string => {
      if (ordering?.path === undefined) return iri
      const values = this.#store.getObjects(iri, ordering.path, null).map((v) => v.value).sort()
      return values[0] ?? ''
    }
    const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
    const dir = ordering?.direction === 'DESC' ? -1 : 1
    const cmpEntries = (aOrd: string, aIri: string, bOrd: string, bIri: string): number => {
      const byOrd = dir * asc(aOrd, bOrd)
      return byOrd !== 0 ? byOrd : asc(aIri, bIri) // stable IRI tiebreak, always ascending
    }
    const filters = (root.eqFilters ?? []).map((f) => ({
      path: f.path,
      value: String(resolveBinding(f.binding, variables, `${root.rootField}(${f.argName}: …)`) ?? ''),
    }))
    const all = this.#subjectsOfType(root.targetClass)
      .filter(() => this.#entityVisible(root, security))
      .filter((iri) => filters.every((f) => this.#store.getObjects(iri, f.path, null).some((v) => v.value === f.value)))
      .map((iri) => ({ iri, ord: ordValue(iri) }))
      .sort((a, b) => cmpEntries(a.ord, a.iri, b.ord, b.iri))
      .map((e) => e.iri)
    // pagination arguments are OPTIONAL (docs/06) and arrive in TWO shapes:
    // a `{variable}` binding resolved from the request, or a literal value in
    // the document itself (first: 2). Literals previously fell through as
    // null and reverted pages to the default size — the parity corpus only
    // exercised the variable shape, so this asymmetric bug survived until a
    // literal-first query ran against the reference adapter (caught live).
    const optionalTerm = (binding: { variable: string } | number | string | null): string | null => {
      if (binding === null || binding === undefined || typeof binding === 'number') {
        return typeof binding === 'number' ? String(binding) : null
      }
      if (typeof binding === 'string') return binding
      const value = variables[binding.variable]
      return value === undefined || value === null ? null : String(value)
    }
    const afterTerm = optionalTerm(root.pagination?.after !== undefined ? root.pagination.after as { variable: string } : null)
    let start = 0
    if (typeof afterTerm === 'string' && afterTerm !== '') {
      // cursor ordering must match this query's ordering (executor validates)
      const cursor = decodeCursor(afterTerm, this.#scopeHash, orderByKey)
      // pair resume: strictly after (lastValue, lastIRI) in the active ordering
      start = all.findIndex((iri) => cmpEntries(ordValue(iri), iri, cursor.lastValue, cursor.lastIRI) > 0)
      if (start === -1) start = all.length
    }
    const firstRaw = optionalTerm(root.pagination?.first !== undefined ? root.pagination.first as never : null)
    const firstValue = firstRaw === null ? undefined : Number(firstRaw)
    if (typeof firstValue === 'number' && (!Number.isInteger(firstValue) || firstValue < 0 || firstValue > 500)) {
      throw new ExecutorError(`${root.rootField}: first must be an integer within 0..500`)
    }
    const size = typeof firstValue === 'number' ? firstValue : root.pagination?.defaultFirst ?? 20
    const page = all.slice(start, start + size)

    const result: Record<string, unknown> = {}
    if (root.connectionShaping?.edges) {
      result['edges'] = page.map((iri) => ({
        node: this.#buildEntity(iri, root.children as readonly FieldExpansion[], security, errors),
        cursor: encodeCursor({
          orderByKey,
          lastValue: ordValue(iri),
          lastIRI: iri,
          graphHash: this.#scopeHash,
        }),
      }))
    }
    if (root.connectionShaping?.pageInfo) {
      result['pageInfo'] = {
        hasNextPage: page.length > 0 && start + page.length < all.length,
        endCursor: page.length === 0
          ? null
          : encodeCursor({
              orderByKey,
              lastValue: ordValue(page[page.length - 1]!),
              lastIRI: page[page.length - 1]!,
              graphHash: this.#scopeHash,
            }),
      }
    }
    return result
  }

  #buildEntity(
    subject: string,
    children: readonly FieldExpansion[],
    security: SecurityContext,
    errors: CartoQLError[],
  ): Record<string, unknown> {
    const entity: Record<string, unknown> = {}
    for (const child of children) {
      // D4: typed-fragment children apply only when the materialized entity has
      // the condition class — non-matching conditions skip existence-blind
      if (child.typeCondition !== undefined && !this.#isOfType(subject, child.typeCondition)) {
        continue
      }
      if (child.returnsTypename !== undefined) {
        entity[child.responseKey] = this.#resolveTypename(subject, child)
        continue
      }
      if (child.path === 'urn:cartoql:computed:iri') {
        entity[child.responseKey] = subject
        continue
      }
      entity[child.responseKey] = this.#expandField(subject, child, security, errors)
    }
    return entity
  }

  /**
   * Concrete implementer name for __typename (D4). Hierarchy entities carry BOTH
   * the parent and their concrete type — most specific wins (docs/06): any
   * matched name differing from the containing type beats the parent fallback.
   */
  #resolveTypename(subject: string, child: FieldExpansion): string {
    const returns = child.returnsTypename!
    const parentName = child.field.split('.')[0]
    const matches: string[] = []
    for (const iri of this.#store.getObjects(subject, RDF_TYPE, null).map((t) => t.value)) {
      if (returns[iri] !== undefined) matches.push(returns[iri]!)
    }
    const concrete = matches.find((n) => n !== parentName)
    return concrete ?? matches[0] ?? (parentName ?? 'Unknown')
  }

  #expandField(
    subject: string,
    field: FieldExpansion,
    security: SecurityContext,
    errors: CartoQLError[],
  ): unknown {
    // Two tracks by constraint prefix (docs/03): `group:` → visible denial (the
    // client selected this field: null plus a typed error — a silent null would
    // read as corruption, not privacy); `traversal:` → existence-blind edge (the
    // related entity never materializes, and NO error entry appears — the edge's
    // existence itself is what was hidden).
    for (const c of securityConstraints(field.constraints)) {
      const decision = evaluateConstraint(c, security.view)
      if (!decision.visible) {
        if (constraintTrack(c) === 'existence-blind') {
          return field.cardinality === 'single' ? null : []
        }
        errors.push({
          message: `field ${field.field} requires authorization the principal does not hold`,
          path: field.field,
          extensions: { code: decision.code },
        })
        return null
      }
    }

    if (field.itemType.kind === 'datatype') {
      const values = this.#store
        .getObjects(subject, field.path, null)
        .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      for (const v of values) {
        if (v.termType !== 'Literal') {
          throw new ExecutorError(`shape violation: ${field.field} expects literals, found ${v.termType}`)
        }
      }
      const lexical = values.map((v) => v.value)
      return field.cardinality === 'single' ? lexical[0] ?? null : lexical
    }

    // class-typed fields always carry children in v0 (compiler enforces)
    if (field.children.length === 0) {
      throw new ExecutorError(`contract violation: class field ${field.field} has no children in the plan`)
    }
    // docs/07: entity visibility follows the entity into expansions — nested
    // items failing their type's stamps leave the population first: invisible
    // ≡ absent for nested entities, identical to root-level gating (blind).
    const itemVisible = (iri: string): boolean => {
      const gateOk = securityConstraints(field.itemTypeConstraints).every((c2) =>
        evaluateConstraint(c2, security.view).visible,
      )
      return gateOk && this.#isOfType(iri, field.itemType.kind === 'class' ? field.itemType.iri : '')
    }
    const matches = (field.inverse
      ? [...this.#store.getSubjects(field.path, subject, null)]
      : [...this.#store.getObjects(subject, field.path, null)]
    )
      // D1: blank nodes never materialize as related entities (docs/06)
      .filter((tt) => tt.termType === 'NamedNode')
      .map((tt) => tt.value)
      .filter(itemVisible)
      .sort()
    if (field.cardinality === 'single') {
      const first = matches[0]
      return first === undefined
        ? null
        : this.#buildEntity(first, field.children as readonly FieldExpansion[], security, errors)
    }
    return matches.map((iri) =>
      this.#buildEntity(iri, field.children as readonly FieldExpansion[], security, errors),
    )
  }

  #isOfType(iri: string, targetClass: string): boolean {
    return this.#store.getObjects(iri, RDF_TYPE, null).some((t) => t.value === targetClass)
  }

  #subjectsOfType(targetClass: string): string[] {
    // D1: blank subjects never materialize as entities
    return [...this.#store.getSubjects(RDF_TYPE, targetClass, null)]
      .filter((t) => t.termType === 'NamedNode')
      .map((t) => t.value)
  }
}
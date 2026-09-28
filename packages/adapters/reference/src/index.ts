/**
 * @verax/adapter-reference — the reference StoreAdapter (docs/02 §5, docs/09 L0).
 *
 * Evaluates compiled plans directly over an in-memory n3 store. Its observable
 * behavior IS the platform semantics: the SPARQL 1.1 HTTP adapter must reach
 * response-equivalence with this one to claim L0, and corpus response snapshots
 * are minted here. It deliberately contains no SPARQL — the IR is the contract,
 * not a query language.
 *
 * v0 semantics notes:
 *  - the store is one logical dataset; the plan's explicit graph set (D10) is
 *    asserted, not filtered — the reference adapter would *reject* a plan whose
 *    graph scope doesn't match its configured scope, so a graph-scoping bug is
 *    loud here rather than silent in production
 *  - ordering is canonical: entities by IRI ascending (docs/06 D6), literals by
 *    lexical value — pagination cursors depend on both
 *  - datatype fields yield literal lexical values; shape violations throw
 *    ExecutorError (data health is a build concern in the corpus; in production
 *    this becomes the stale-shape health channel, VX_SHAPE_MISMATCH)
 */
import { Parser, Store } from 'n3'
import type { AlgebraNode, EntityLookup, FieldExpansion, Plan } from '../../../core/src/ir.js'
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

  async run(plan: Plan, module: VeraxModule, variables: ResolvedVariables): Promise<ResponseData> {
    if (graphScopeHash(module.datasetGraphs) !== this.#scopeHash) {
      throw new ExecutorError('plan graph scope does not match adapter scope — the plan may not run here (D10)')
    }
    const data: Record<string, unknown> = {}
    for (const root of plan.roots) {
      if (root.kind !== 'EntityLookup') {
        throw new ExecutorError(`reference adapter v0 only accepts EntityLookup roots, got ${root.kind}`)
      }
      data[root.rootField] = root.mode === 'single'
        ? this.#single(root, variables)
        : this.#scan(root, variables)
    }
    return { data, errors: [] }
  }

  #single(root: EntityLookup, variables: ResolvedVariables): Record<string, unknown> | null {
    const iri = resolveBinding(root.iri, variables, `${root.rootField}(iri:)`)
    if (typeof iri !== 'string' || iri === '') {
      throw new ExecutorError(`${root.rootField}: iri must bind to a non-empty string`)
    }
    // Absent and invisible are the same shape here: null, no error entries.
    if (!this.#isOfType(iri, root.targetClass)) return null
    return this.#buildEntity(iri, root.typeName, root.children, root.rootField)
  }

  #scan(root: EntityLookup, variables: ResolvedVariables): Record<string, unknown> {
    const all = this.#subjectsOfType(root.targetClass).sort() // canonical order: IRI ascending (D6)
    const afterTerm = root.pagination?.after !== undefined
      ? resolveBinding(root.pagination.after, variables, `${root.rootField}(after:)`)
      : null
    let start = 0
    if (typeof afterTerm === 'string' && afterTerm !== '') {
      const cursor = decodeCursor(afterTerm, this.#scopeHash)
      start = all.findIndex((iri) => iri > cursor.lastIRI)
      if (start === -1) start = all.length
    }
    const first = root.pagination?.first !== undefined
      ? resolveBinding(root.pagination.first, variables, `${root.rootField}(first:)`)
      : undefined
    if (typeof first === 'number' && first < 0) {
      throw new ExecutorError(`${root.rootField}: first must not be negative`)
    }
    const size = typeof first === 'number' ? first : root.pagination?.defaultFirst ?? 20
    const page = all.slice(start, start + size)

    const result: Record<string, unknown> = {}
    if (root.connectionShaping?.edges) {
      result['edges'] = page.map((iri) => ({
        node: this.#buildEntity(iri, root.typeName, root.children as readonly FieldExpansion[], root.rootField),
        cursor: encodeCursor({
          orderByKey: ORDER_BY_IRI,
          lastValue: iri,
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
              orderByKey: ORDER_BY_IRI,
              lastValue: page[page.length - 1]!,
              lastIRI: page[page.length - 1]!,
              graphHash: this.#scopeHash,
            }),
      }
    }
    return result
  }

  #buildEntity(
    subject: string,
    typeName: string,
    children: readonly AlgebraNode[],
    where: string,
  ): Record<string, unknown> {
    const entity: Record<string, unknown> = {}
    for (const child of children) {
      if (child.kind !== 'FieldExpansion') {
        throw new ExecutorError(`unexpected child under ${where}: ${child.kind}`)
      }
      entity[child.field.split('.')[1]!] = this.#expandField(subject, child, where)
    }
    void typeName
    return entity
  }

  #expandField(subject: string, field: FieldExpansion, where: string): unknown {
    const matches = field.inverse
      ? this.#store.getSubjects(field.path, subject, null).map((t) => t.value).sort()
      : this.#store.getObjects(subject, field.path, null).map((t) => t.value).sort()

    if (field.itemType.kind === 'datatype') {
      // shape rule (docs/06): literal fields yield lexical values; a non-literal is a shape violation
      const values = this.#store.getObjects(subject, field.path, null).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      for (const v of values) {
        if (v.termType !== 'Literal') {
          throw new ExecutorError(`shape violation: ${where}.${field.field} expects literals, found ${v.termType}`)
        }
      }
      const lexical = values.map((v) => v.value)
      if (field.cardinality === 'single') return lexical[0] ?? null
      return lexical
    }

    // class-typed fields always carry children in v0 (compiler enforces)
    if (field.children.length === 0) {
      throw new ExecutorError(`contract violation: class field ${field.field} has no children in the plan`)
    }
    if (field.cardinality === 'single') {
      const first = matches[0]
      return first === undefined ? null : this.#buildEntity(first, '', field.children, field.field)
    }
    return matches.map((iri) => this.#buildEntity(iri, '', field.children, field.field))
  }

  #isOfType(iri: string, targetClass: string): boolean {
    return this.#store.getObjects(iri, RDF_TYPE, null).some((t) => t.value === targetClass)
  }

  #subjectsOfType(targetClass: string): string[] {
    return [...this.#store.getSubjects(RDF_TYPE, targetClass, null)].map((t) => t.value)
  }
}

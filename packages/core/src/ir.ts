/**
 * @verax/core — algebra IR (ADR-1: portable JSON algebra).
 *
 * The IR is the executable artifact family: the compiler emits IR, SPARQL is a
 * *projection* of it (produced by adapters), and every security property test
 * (constraint monotonicity, cost monotonicity — docs/09) inspects IR structure.
 * String-shaped plans are untestable; this module is why they don't exist here.
 *
 * Normative IR rules mirrored here (docs/06, docs/08):
 *  - every node carries an *explicit* graph set (D10) — there is no implicit
 *    "whatever graph" anywhere in a plan
 *  - `constraints` only ever grow (docs/03 enforcement rule 1) — the readonly
 *    type makes a removal an obvious, reviewable diff
 *  - client argument values appear as *bindings* (literal or `{ variable }`),
 *    never as interpolated text (D7) — adapters serialize them as bound
 *    variables, and no code path is allowed to concatenate them
 */

export type Iri = string

/** A client-supplied value: resolved literal, or a declared GraphQL variable reference. */
export type Binding = string | number | boolean | null | { readonly variable: string }
export type Bindings = Readonly<Record<string, Binding>>

/** Base shared by every algebra node. */
export interface AlgebraNodeBase {
  /** Explicit graph set this node's patterns are constrained to (D10). */
  readonly graphs: readonly Iri[]
  /**
   * Security directives compile into constraint IDs added to this list —
   * monotonic by construction (docs/03 enforcement rule 1).
   */
  readonly constraints: readonly string[]
}

/** Ordering for a scan window: a scalar field key (or canonical IRI), a direction. */
export interface ScanOrdering {
  /** `TypeName.fieldName` of a single-valued scalar leaf, or 'IRI' for canonical. */
  readonly key: string
  /** The SHACL path of the ordering field — present iif key is a field ordering. */
  readonly path?: string
  readonly direction: 'ASC' | 'DESC'
  /** Cursor orderByKey payload — the wire form identifying this ordering. */
  readonly orderByKey: string
}

/** Equality filter over a scalar leaf (docs/06: bound-variable args; lexical equality). */
export interface EqFilter {
  readonly argName: string
  readonly path: Iri
  /** The client's binding: literal or `{ variable }` — bound at execution, never interpolated. */
  readonly binding: Binding
}

/** Root entity retrieval: single lookup by IRI, or full scan (paginated). */
export interface EntityLookup extends AlgebraNodeBase {
  readonly kind: 'EntityLookup'
  /** Root field name as the client wrote it — the response data key. */
  readonly rootField: string
  readonly typeName: string
  readonly targetClass: Iri
  /** Binding for the IRI argument when mode === 'single'. */
  readonly iri?: Binding
  readonly mode: 'single' | 'scan'
  /** Number of client arguments on the root field — feeds the cost model's filterFactor. */
  readonly argumentCount: number
  /** Pagination bindings for mode === 'scan' (D2; cursor resolution arrives with the executor). */
  readonly pagination?: {
    readonly first?: Binding
    readonly after?: Binding
    readonly defaultFirst: number
  }
  /** mode === 'scan' only: ordering (absent = canonical IRI ascending, D6). */
  readonly ordering?: ScanOrdering
  /** mode === 'scan' only: equality filters. */
  readonly eqFilters?: readonly EqFilter[]
  /**
   * Connection response shaping (`edges`/`cursor`, `pageInfo`) is a shaping
   * concern, not algebra — recorded here so the executor knows what to build.
   */
  readonly connectionShaping?: {
    readonly edges: boolean
    readonly pageInfo: boolean
  }
  readonly children: readonly AlgebraNode[]
}

/** Expansion of one GraphQL field across an SHACL path (forward or inverse). */
export interface FieldExpansion extends AlgebraNodeBase {
  readonly kind: 'FieldExpansion'
  /** `TypeName.fieldName` — traceable to the module's semantic map. */
  readonly field: string
  /** The response key: the field name, or the client's alias for it. */
  readonly responseKey: string
  readonly path: Iri
  readonly inverse: boolean
  /** Shape-declared cardinality — feeds the cost model's listFactor. */
  readonly cardinality: 'single' | 'list'
  readonly itemType:
    | { readonly kind: 'class'; readonly iri: Iri }
    | { readonly kind: 'datatype'; readonly iri: Iri }
  /**
   * Type-level stamps of the *referenced* class (docs/07 rule: entity visibility
   * follows the entity, not just the root): nested entities failing these are
   * filtered from lists / nulled — existence-blind, edge track's failure shape.
   */
  readonly itemTypeConstraints: readonly string[]
  /**
   * D4: this expansion applies only when the materialized entity has this
   * concrete class (typed-fragment compilation). Absent = unconditional.
   * Non-matching entities skip the field existence-blind (docs/06 D4).
   */
  readonly typeCondition?: string
  /**
   * D4: __typename discrimination — implementer class IRI → GraphQL type name.
   * Present only on returnsTypename expansions.
   */
  readonly returnsTypename?: Readonly<Record<string, string>>
  readonly children: readonly AlgebraNode[]
}

export type AlgebraNode = EntityLookup | FieldExpansion

/** The compiled plan — the only thing the executor runs (one-execution-artifact rule). */
export interface Plan {
  readonly planId: string
  /** sha256 of the source document's canonical form — see docs/10 cache keys. */
  readonly documentHash: string
  readonly moduleId: string
  readonly schemaHash: string
  /** Document cost per the versioned cost model (docs/08); v0 constants live in the compiler. */
  readonly cost: number
  readonly roots: readonly AlgebraNode[]
}

/**
 * Depth of one expansion node counting itself: 1 for a leaf, 1 + the deepest
 * child chain below it otherwise. Children are always FieldExpansions in this
 * IR, so the recursion is over one kind.
 */
export function expansionDepth(node: FieldExpansion): number {
  const kids = node.children as readonly FieldExpansion[]
  if (kids.length === 0) return 1
  return 1 + Math.max(...kids.map(expansionDepth))
}

/** Total algebra nodes in a plan (docs/08 resource-protection input). */
export function planNodeCount(plan: Plan): number {
  let count = 0
  const visit = (node: AlgebraNode): void => {
    count += 1
    for (const child of node.children) visit(child)
  }
  for (const root of plan.roots) visit(root)
  return count
}

/** Maximum expansion depth (docs/08 @maxDepth input): 1 for a flat entity. */
export function planDepth(plan: Plan): number {
  let max = 0
  for (const root of plan.roots) {
    max = Math.max(max, 1 + compoundingBelow(root))
  }
  return max
}

/**
 * The deepest expansion chain strictly *below* a node (0 for a leaf root) —
 * the "hopsBelow" input of the cost model's compounding term (docs/08).
 */
export function compoundingBelow(node: AlgebraNode): number {
  const kids = node.children as readonly FieldExpansion[]
  if (kids.length === 0) return 0
  return Math.max(...kids.map(expansionDepth))
}

/**
 * Canonical JSON: object keys sorted lexicographically, recursively. The same IR
 * always yields the same serialization — planId and documentHash depend on it.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )
      return Object.fromEntries(entries.map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return JSON.stringify(walk(value))
}

// Import-time self-check: canonicalJson must be key-order-stable (arrays are
// order-preserving by design — they encode sequences) or every planId is noise.
{
  const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })
  const b = canonicalJson({ a: { d: [3, { y: 2, z: 1 }], c: 2 }, b: 1 })
  if (a !== b) throw new Error('canonicalJson is not key-order-stable')
}
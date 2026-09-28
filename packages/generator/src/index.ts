/**
 * @verax/generator — SHACL + ontology → SDL (docs/02 §1, docs/06 for the mapping rules).
 *
 * Determinism is a hard requirement (docs/09: gold-shard snapshots are byte-stable):
 * types and fields are emitted in sorted order, scalar declarations are limited to
 * those actually used, and the same input always produces the same SDL.
 */
import { createHash } from 'node:crypto'
import { Parser, Store, type Term } from 'n3'

const SH = 'http://www.w3.org/ns/shacl#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

/** Scalar prefix stays a constant for the whole renameability policy (docs/01). */
export const SCALAR_PREFIX = 'Verax'

/**
 * XSD → GraphQL scalar map (docs/06 §Literals & scalars, decision D3):
 * decimals serialize as strings by default; JS-unsafe integers lift to a bigint
 * scalar. Unknown datatypes fail generation loudly — never a best-effort cast.
 */
const SCALAR_MAP: Record<string, string> = {
  'http://www.w3.org/2001/XMLSchema#string': 'String',
  // D8 v0: langString maps to String — lexical value queryable today; language
  // negotiation (docs/06 full precedence) needs field-argument machinery and
  // is a pending traceability row, not silently approximated
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString': 'String',
  'http://www.w3.org/2001/XMLSchema#boolean': 'Boolean',
  'http://www.w3.org/2001/XMLSchema#int': 'Int',
  'http://www.w3.org/2001/XMLSchema#integer': `${SCALAR_PREFIX}Bigint`,
  'http://www.w3.org/2001/XMLSchema#long': `${SCALAR_PREFIX}Bigint`,
  'http://www.w3.org/2001/XMLSchema#nonNegativeInteger': `${SCALAR_PREFIX}Bigint`,
  'http://www.w3.org/2001/XMLSchema#decimal': `${SCALAR_PREFIX}Decimal`,
  'http://www.w3.org/2001/XMLSchema#double': `${SCALAR_PREFIX}Decimal`,
  'http://www.w3.org/2001/XMLSchema#float': `${SCALAR_PREFIX}Decimal`,
  'http://www.w3.org/2001/XMLSchema#date': `${SCALAR_PREFIX}Date`,
  'http://www.w3.org/2001/XMLSchema#dateTime': `${SCALAR_PREFIX}DateTime`,
  'http://www.w3.org/2001/XMLSchema#time': `${SCALAR_PREFIX}Time`,
  'http://www.w3.org/2001/XMLSchema#duration': `${SCALAR_PREFIX}Duration`,
  'http://www.w3.org/2001/XMLSchema#gYear': `${SCALAR_PREFIX}GYear`,
  'http://www.w3.org/2001/XMLSchema#anyURI': 'IRI',
}

export class GenerationError extends Error {
  constructor(message: string) {
    super(`[@verax/generator] ${message}`)
    this.name = 'GenerationError'
  }
}

export interface GenerateSdlInput {
  /** Turtle text of the ontology module (classes/properties; drives naming). */
  ontology: string
  /** Turtle text of the SHACL shape graph (drives the API surface). */
  shapes: string
}

export interface GeneratedField {
  name: string
  typeRef: string
  inverse: boolean
  pathIri: string
  cardinality: 'single' | 'list'
  /** GraphQL type name when this field references another exposed class. */
  itemTypeName?: string
  /** Generator-stamped group gate, rendered as @requireGroup (docs/03). */
  stamp?: string
  /** Which SDL directive renders the stamp (requireGroup default; role/hiddenUnless vocabulary). */
  stampDirective?: string
  /** Edge-level gate, rendered as @traversalScope — class-typed fields only. */
  traversalStamp?: string
}

export interface GeneratedType {
  name: string
  targetClass: string
  fields: GeneratedField[]
  /** Generator-stamped type-level group gate → @requireGroup on the type. */
  typeStamp?: string
}

/** Field/root → SHACL-path contract: the compiler's input map (see @verax/core's identical structural type). */
export interface SemanticMap {
  readonly fields: Readonly<Record<string, {
    readonly pathIri: string
    readonly inverse: boolean
    readonly itemClass?: string
    readonly itemTypeName?: string
    readonly datatype?: string
    readonly cardinality: 'single' | 'list'
  }>>
  readonly roots: Readonly<Record<string, {
    readonly typeName: string
    readonly targetClass: string
    readonly mode: 'single' | 'list'
    readonly defaultPageSize: number
  }>>
  /** D4: interface implementers (interface type name → child type names). */
  readonly hierarchy?: Readonly<{
    readonly implementers: Readonly<Record<string, readonly string[]>>
    readonly parentOf: Readonly<Record<string, string>>
  }>
}

export interface GenerateSdlOptions {
  /** Explicit graph set the module is scoped to (stamped into plans, docs/06 D10). */
  datasetGraphs?: readonly string[]
  /**
   * Security stamps (docs/03: directives are generator-stamped only — the single
   * place security semantics ever originate). M2 slice 1 covers @requireGroup at
   * field and type level; each future directive extends this table.
   */
  stamps?: readonly StampRule[]
}

/** One stamp: a group gate at field/type level, a role gate, or a traversal gate. */
export interface StampRule {
  readonly onField?: string
  readonly onType?: string
  /** Edge-level gate: the constraint enforces existence-blind (docs/@traversalScope). */
  readonly onTraversal?: string
  readonly requireGroup?: string
  /** Platform-role gate (@requireRole — console powers vocabulary, docs/03). */
  readonly requireRole?: string
  /**
   * @hiddenUnless: visible-track denial alias — identical semantics to
   * requireGroup (null + typed error), kept for docs/03 vocabulary completeness.
   */
  readonly hiddenUnless?: string
}

export interface GeneratedSdl {
  moduleId: string
  sdl: string
  schemaHash: string
  types: GeneratedType[]
  semanticMap: SemanticMap
  datasetGraphs: readonly string[]
}

function localName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  const slash = iri.lastIndexOf('/')
  const at = Math.max(hash, slash)
  if (at === -1 || at === iri.length - 1) {
    throw new GenerationError(`cannot derive a local name from IRI <${iri}>`)
  }
  return iri.slice(at + 1)
}

function upperFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s
}

/** Irregular plural forms for root list fields; everything else gets a naive +s. */
const IRREGULAR_PLURALS: Record<string, string> = {
  Person: 'people',
}

function parse(text: string, what: string): Store {
  const quads = new Parser().parse(text)
  if (quads.length === 0) {
    throw new GenerationError(`${what} graph is empty — refusing to generate from nothing`)
  }
  return new Store(quads)
}

interface RawProperty {
  kind: 'forward' | 'inverse'
  pathIri: string
  classIri?: string
  datatypeIri?: string
  minCount: number
  /** null = unbounded */
  maxCount: number | null
}

/**
 * Generate a deterministic SDL module from a SHACL shape graph (docs/02 §1).
 *
 * Rules implemented here (traceable in corpus/TRACEABILITY.md):
 *  - node shapes → object types (D4 most-specific-shape/union resolution is a later
 *    milestone: this slice requires exactly one shape per exposed class)
 *  - sh:datatype → scalar per SCALAR_MAP; unknown datatype → GenerationError (D3)
 *  - sh:class → nested object type; the class must itself have a covering shape
 *  - minCount/maxCount → nullability and list-ness (docs/06 §Property resolution)
 *  - inverse paths → `<name>Inverse` fields (D5)
 *  - paginated roots → connection types, default page size 20 (D2)
 */
export function generateSdl(
  input: GenerateSdlInput,
  moduleId = 'module',
  options: GenerateSdlOptions = {},
): GeneratedSdl {
  const shapes = parse(input.shapes, 'shapes')
  const ontology = parse(input.ontology, 'ontology')

  // D4: shape hierarchies — subclass relations make parent classes interfaces
  const SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
  const childToParent = new Map<string, string>()
  for (const subj of ontology.getSubjects(SUBCLASS_OF, null, null)) {
    if (subj.termType !== 'NamedNode') continue
    for (const parent of ontology.getObjects(subj, SUBCLASS_OF, null)) {
      if (parent.termType === 'NamedNode') childToParent.set(subj.value, parent.value)
    }
  }

  const shapeSubjects = [...shapes.getSubjects(RDF_TYPE, `${SH}NodeShape`, null)]
  const classToType = new Map<string, string>()
  for (const s of shapeSubjects) {
    const target = shapes.getObjects(s, `${SH}targetClass`, null)[0]
    if (!target) {
      throw new GenerationError(`node shape <${s.id}> has no sh:targetClass`)
    }
    const typeName = upperFirst(localName(target.value))
    if (classToType.has(target.value)) {
      throw new GenerationError(
        `two node shapes target class <${target.value}> (D4 union resolution is a later milestone)`,
      )
    }
    classToType.set(target.value, typeName)
  }
  if (classToType.size === 0) {
    throw new GenerationError('no sh:NodeShape with sh:targetClass found in the shapes graph')
  }

  // parent classes with ≥2 shaped children become GraphQL interfaces (docs/06 D4);
  // children get `implements`. The interface field set = intersection of the
  // children's fields (by name AND typeRef), which the renderer computes.
  const parentToChildren = new Map<string, string[]>()
  for (const [classIri] of classToType) {
    const parentIri = childToParent.get(classIri)
    if (parentIri === undefined) continue
    const bucket = parentToChildren.get(parentIri) ?? []
    bucket.push(classIri)
    parentToChildren.set(parentIri, bucket)
  }
  const interfaceClasses = new Map<string, string[]>() // parentClassIri → childClassIris
  for (const [parentIri, children] of parentToChildren) {
    if (children.length >= 2) interfaceClasses.set(parentIri, children)
  }
  const childOfInterface = new Map<string, string>() // childClassIri → parentClassIri
  for (const [parentIri, children] of interfaceClasses) {
    for (const c of children) childOfInterface.set(c, parentIri)
  }
  // class fields referencing a parent (children exist, parent shaped) reference the
  // INTERFACE type name in SDL; cross-type spreads compile via the hierarchy
  const classToGraphQL = new Map<string, string>()
  for (const [classIri, typeName] of classToType) classToGraphQL.set(classIri, typeName)
  for (const [parentIri] of interfaceClasses) {
    const parentType = classToType.get(parentIri)
    if (parentType !== undefined) classToGraphQL.set(parentIri, parentType)
  }
  const interfaceOf = (classIri: string): string | undefined => {
    const parentIri = childOfInterface.get(classIri)
    return parentIri === undefined ? undefined : (classToGraphQL.get(parentIri) ?? undefined)
  }

  // Every exposed class must be described by the ontology graph — modules don't
  // self-invent their vocabulary (docs/04 position: the ontology is the source).
  for (const classIri of classToType.keys()) {
    const described = ontology.countQuads(classIri, null, null, null) > 0
    if (!described) {
      throw new GenerationError(`target class <${classIri}> is not described by the ontology graph`)
    }
  }

  const types: GeneratedType[] = []
  for (const s of shapeSubjects) {
    const target = shapes.getObjects(s, `${SH}targetClass`, null)[0]!
    const typeName = classToType.get(target.value)!
    const fields: GeneratedField[] = []

    for (const propertyShape of shapes.getObjects(s, `${SH}property`, null)) {
      const raw = readProperty(shapes, propertyShape)
      const base = localName(raw.pathIri)
      const fieldName = raw.kind === 'inverse' ? `${lowerFirst(base)}Inverse` : lowerFirst(base)

      let inner: string
      if (raw.classIri) {
        inner = classToType.get(raw.classIri) ?? ''
        if (!inner) {
          throw new GenerationError(
            `field "${fieldName}" on ${typeName} references class <${raw.classIri}> with no covering node shape (docs/06 fallthrough is a later milestone)`,
          )
        }
      } else if (raw.datatypeIri) {
        inner = SCALAR_MAP[raw.datatypeIri] ?? ''
        if (!inner) {
          throw new GenerationError(
            `unsupported datatype <${raw.datatypeIri}> on ${typeName}.${fieldName} (D3: fail loud, never a best-effort cast)`,
          )
        }
      } else {
        throw new GenerationError(
          `property shape for ${typeName}.${fieldName} declares neither sh:class nor sh:datatype`,
        )
      }

      const isList = raw.maxCount === null || raw.maxCount > 1
      let typeRef: string
      if (isList) {
        // Elements non-null (a binding exists or the pattern fails the shape);
        // outer non-null iff minCount ≥ 1 (docs/06 §Property resolution).
        typeRef = `[${inner}!]${raw.minCount >= 1 ? '!' : ''}`
      } else {
        typeRef = raw.minCount >= 1 ? `${inner}!` : inner
      }
      fields.push({
        name: fieldName,
        typeRef,
        inverse: raw.kind === 'inverse',
        pathIri: raw.pathIri,
        cardinality: isList ? 'list' : 'single',
        itemTypeName: raw.classIri ? inner : undefined,
      })
    }

    fields.sort((a, b) => a.name.localeCompare(b.name))
    types.push({ name: typeName, targetClass: target.value, fields })
  }
  types.sort((a, b) => a.name.localeCompare(b.name))

  // D4 hierarchy, expressed in type names: interface → implementers, child → parent
  const implementers: Record<string, readonly string[]> = {}
  const parentOf: Record<string, string> = {}
  for (const [parentIri, childClassIris] of interfaceClasses) {
    const parentName = classToGraphQL.get(parentIri)
    if (parentName === undefined) continue
    implementers[parentName] = childClassIris.map((c) => classToGraphQL.get(c)).filter((n): n is string => n !== undefined)
    for (const childName of implementers[parentName]!) parentOf[childName] = parentName
  }

  // Semantic map: field keys `TypeName.fieldName`, roots keyed by root field name.
  const fields: Record<string, SemanticMap['fields'][string]> = {}
  for (const t2 of types) {
    for (const f of t2.fields) {
      const classIri = f.itemTypeName
        ? (findTargetClass(types, f.itemTypeName) ?? fail(`class type ${f.itemTypeName} missing from module`))
        : undefined
      fields[`${t2.name}.${f.name}`] = {
        pathIri: f.pathIri,
        inverse: f.inverse,
        itemClass: classIri,
        itemTypeName: f.itemTypeName,
        datatype: f.itemTypeName ? undefined : scalarIriFromTypeRef(f.typeRef),
        cardinality: f.cardinality,
      }
    }
  }
  const roots: Record<string, SemanticMap['roots'][string]> = {}
  for (const t2 of types) {
    const { single, plural } = rootNames(t2.name)
    roots[single] = { typeName: t2.name, targetClass: t2.targetClass, mode: 'single', defaultPageSize: 20 }
    roots[plural] = { typeName: t2.name, targetClass: t2.targetClass, mode: 'list', defaultPageSize: 20 }
  }

  applyStamps(types, options.stamps ?? [])
  const sdl = renderSdl(
    moduleId,
    types,
    options.stamps ?? [],
    { implementers, parentOf },
  )
  return {
    moduleId,
    sdl,
    schemaHash: createHash('sha256').update(sdl).digest('hex'),
    types,
    semanticMap: {
      fields,
      roots,
      ...(Object.keys(implementers).length > 0 ? { hierarchy: { implementers, parentOf } } : {}),
    },
    datasetGraphs: options.datasetGraphs ?? ['urn:verax:dataset:default'],
  }
}

function findTargetClass(types: readonly GeneratedType[], typeName: string): string | undefined {
  return types.find((t) => t.name === typeName)?.targetClass
}

function fail(message: string): never {
  throw new GenerationError(message)
}

/** Inverse of the scalar map: recover the XSD IRI for a scalar name used in a type ref. */
function scalarIriFromTypeRef(typeRef: string): string | undefined {
  for (const [iri, scalar] of Object.entries(SCALAR_MAP)) {
    const token = typeRef.replace(/[\[!\]]/g, '')
    if (token === scalar && scalar.startsWith(SCALAR_PREFIX)) return iri
    if (token === 'String' && iri.endsWith('#string')) return iri
    if (token === 'Boolean' && iri.endsWith('#boolean')) return iri
    if (token === 'Int' && iri.endsWith('#int')) return iri
    if (token === 'IRI' && iri.endsWith('#anyURI')) return iri
  }
  return undefined
}

/**
 * docs/06 ordering restriction: orderBy members come from single-valued scalar
 * leaves only (maxCount 1) — sorting on multi-valued or object fields is not
 * plan-computable. Equality-filter args use the same single-valued scalar set.
 */
function scalarLeafArgs(type: GeneratedType): readonly GeneratedField[] {
  return type.fields.filter(
    (f) => f.itemTypeName === undefined && f.cardinality === 'single' && !f.name.startsWith('__'),
  )
}

function rootNames(typeName: string): { single: string; plural: string } {
  return {
    single: lowerFirst(typeName),
    plural: IRREGULAR_PLURALS[typeName] ?? `${lowerFirst(typeName)}s`,
  }
}

function readProperty(shapes: Store, propertyShape: Term): RawProperty {
  const path = shapes.getObjects(propertyShape, `${SH}path`, null)[0]
  if (!path) {
    throw new GenerationError(`property shape <${propertyShape.id}> has no sh:path`)
  }

  let kind: 'forward' | 'inverse'
  let pathIri: string
  if (path.termType === 'NamedNode') {
    kind = 'forward'
    pathIri = path.value
  } else if (path.termType === 'BlankNode') {
    const inv = shapes.getObjects(path, `${SH}inversePath`, null)[0]
    if (!inv || inv.termType !== 'NamedNode') {
      throw new GenerationError(
        `blank-node sh:path without a valid sh:inversePath (property shape <${propertyShape.id}>)`,
      )
    }
    kind = 'inverse'
    pathIri = inv.value
  } else {
    throw new GenerationError(`unsupported sh:path term type on property shape <${propertyShape.id}>`)
  }

  const minCountTerm = shapes.getObjects(propertyShape, `${SH}minCount`, null)[0]
  const maxCountTerm = shapes.getObjects(propertyShape, `${SH}maxCount`, null)[0]
  const minCount = minCountTerm ? Number.parseInt(minCountTerm.value, 10) : 0
  const maxCount = maxCountTerm ? Number.parseInt(maxCountTerm.value, 10) : null
  if (!Number.isInteger(minCount) || (maxCount !== null && !Number.isInteger(maxCount))) {
    throw new GenerationError(`non-integer cardinality on property shape <${propertyShape.id}>`)
  }

  const classTerm = shapes.getObjects(propertyShape, `${SH}class`, null)[0]
  const datatypeTerm = shapes.getObjects(propertyShape, `${SH}datatype`, null)[0]
  return {
    kind,
    pathIri,
    classIri: classTerm?.value,
    datatypeIri: datatypeTerm?.value,
    minCount,
    maxCount,
  }
}

/**
 * Stamps land as SDL directives (docs/03 rule 1: generator-stamped only).
 * Failures here are build errors: a stamp targeting a missing type/field means
 * the security config and the module have drifted — never silently ignored.
 */
function applyStamps(types: readonly GeneratedType[], stamps: readonly StampRule[]): void {
  const byType = new Map(types.map((t2) => [t2.name, t2]))
  const reasonOf = (stamp: StampRule): string =>
    stamp.requireGroup !== undefined
      ? stamp.requireGroup
      : stamp.requireRole !== undefined
        ? stamp.requireRole // bare: the directive arg carries it; the compiler adds the role: channel prefix once
        : stamp.hiddenUnless !== undefined
          ? stamp.hiddenUnless
          : ((): never => { throw new GenerationError('stamp needs one of requireGroup/requireRole/hiddenUnless') })()
  for (const stamp of stamps) {
    if (stamp.onType) {
      const target = byType.get(stamp.onType)
      if (!target) throw new GenerationError(`stamp targets unknown type "${stamp.onType}"`)
      target.typeStamp = reasonOf(stamp)
    } else if (stamp.onTraversal) {
      const [typeName, fieldName] = stamp.onTraversal.split('.')
      const target = byType.get(typeName ?? '')
      const field = target?.fields.find((f) => f.name === fieldName)
      if (!target || !field) {
        throw new GenerationError(`traversal stamp targets unknown field "${stamp.onTraversal}"`)
      }
      if (field.itemTypeName === undefined) {
        throw new GenerationError(
          `traversal stamp on ${stamp.onTraversal} — @traversalScope applies to object-typed fields only (docs/03)`,
        )
      }
      field.traversalStamp = stamp.requireGroup
    } else if (stamp.onField) {
      const [typeName, fieldName] = stamp.onField.split('.')
      const target = byType.get(typeName ?? '')
      const field = target?.fields.find((f) => f.name === fieldName)
      if (!target || !field) {
        throw new GenerationError(`stamp targets unknown field "${stamp.onField}"`)
      }
      // resolve the reason + which SDL directive communicates it (docs/03
      // vocabulary; hiddenUnless is the visible-track twin of requireGroup)
      const reason = reasonOf(stamp)
      field.stamp = reason
      if (stamp.requireRole !== undefined) field.stampDirective = '@requireRole'
      if (stamp.hiddenUnless !== undefined) field.stampDirective = '@hiddenUnless'
    } else {
      throw new GenerationError('stamp must provide onType or onField')
    }
  }
}

function orderMember(fieldName: string, direction: 'ASC' | 'DESC'): string {
  return `${fieldName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_${direction}`
}

interface HierarchyTable {
  readonly implementers: Readonly<Record<string, readonly string[]>>
  readonly parentOf: Readonly<Record<string, string>>
}

const EMPTY_HIERARCHY: HierarchyTable = { implementers: {}, parentOf: {} }

/** Field intersection by (name, typeRef) — the docs/06 interface field set. */
function intersectFields(fieldSets: readonly GeneratedField[][]): GeneratedField[] {
  const first = fieldSets[0] ?? []
  return first.filter((f) =>
    fieldSets.every((set) => set.some((g) => g.name === f.name && g.typeRef === f.typeRef)),
  )
}

function renderSdl(
  moduleId: string,
  types: readonly GeneratedType[],
  stamps: readonly StampRule[] = [],
  hierarchy: HierarchyTable = EMPTY_HIERARCHY,
): string {
  const implementersOf = (typeName: string): readonly string[] | undefined =>
    hierarchy.implementers[typeName]
  const parentOfNamed = new Map(Object.entries(hierarchy.parentOf))
  // Scalar declarations limited to those actually used, sorted (determinism).
  const usedScalars = new Set<string>()
  for (const t of types) {
    for (const f of t.fields) {
      for (const token of f.typeRef.match(/[A-Za-z]+/g) ?? []) {
        if (token.startsWith(SCALAR_PREFIX)) usedScalars.add(token)
      }
    }
  }

  const lines: string[] = []
  lines.push(`# @verax/generated — module: ${moduleId}`)
  lines.push('# Reviewed gold-shard snapshot (docs/09). Regenerate via `npm run corpus:snapshot:core`.')
  if (stamps.length > 0) {
    lines.push('# Security-stamped module: directives below are generator-originated (docs/03 rule 1).')
    lines.push('directive @requireGroup(group: String!) on FIELD_DEFINITION | OBJECT')
    lines.push('directive @traversalScope(group: String!) on FIELD_DEFINITION')
    lines.push('directive @requireRole(role: String!) on FIELD_DEFINITION | OBJECT')
    lines.push('directive @hiddenUnless(group: String!) on FIELD_DEFINITION')
    lines.push('')
  }
  lines.push('')
  for (const scalar of [...usedScalars].sort()) lines.push(`scalar ${scalar}`)
  if (usedScalars.size > 0) lines.push('')

  const pageType = (name: string) => `${name}Connection`

  for (const t of types) {
    // D4: shape-hierarchy parents render as interfaces; children implement them.
    // The interface field set is the intersection of the implementers' fields.
    const children = implementersOf(t.name)
    if (children !== undefined) {
      const childFields = children
        .map((childName) => types.find((x) => x.name === childName)?.fields)
        .filter((f): f is GeneratedField[] => f !== undefined)
      const common = childFields.length > 0 ? intersectFields(childFields) : []
      lines.push(`interface ${t.name} {`)
      for (const f of common) lines.push(`  ${f.name}: ${f.typeRef}`)
      lines.push('}')
      lines.push('')
      // interface roots keep connection pagination (node: Agent! — polymorphic
      // connections resolve per implementer; docs/06 D4)
      lines.push(`type ${pageType(t.name)} {`)
      lines.push(`  edges: [${t.name}Edge!]!`)
      lines.push('  pageInfo: PageInfo!')
      lines.push('}')
      lines.push(`type ${t.name}Edge {`)
      lines.push(`  node: ${t.name}!`)
      lines.push('  cursor: String!')
      lines.push('}')
      lines.push('')
      continue // children render below with `implements`
    }
    const typeDirective = t.typeStamp ? ` @requireGroup(group: "${t.typeStamp}")` : ''
    const implementsClause = parentOfNamed.has(t.name) ? ` implements ${parentOfNamed.get(t.name)}` : ''
    lines.push(`type ${t.name}${typeDirective}${implementsClause} {`)
    for (const f of t.fields) {
      const directive = f.stampDirective ?? '@requireGroup'
      const argName = directive === '@requireRole' ? 'role' : 'group'
      const fieldDirective = f.stamp ? ` ${directive}(${argName}: "${f.stamp}")` : ''
      const traversalDirective = f.traversalStamp ? ` @traversalScope(group: "${f.traversalStamp}")` : ''
      lines.push(`  ${f.name}: ${f.typeRef}${fieldDirective}${traversalDirective}`)
    }
    lines.push('}')
    // Connection/edge pair for the paginated root (D2: cursor-based, default 20).
    lines.push(`type ${pageType(t.name)} {`)
    lines.push(`  edges: [${t.name}Edge!]!`)
    lines.push('  pageInfo: PageInfo!')
    lines.push('}')
    lines.push(`type ${t.name}Edge {`)
    lines.push(`  node: ${t.name}!`)
    lines.push('  cursor: String!')
    lines.push('}')
    lines.push('')
  }

  lines.push('type PageInfo {')
  lines.push('  hasNextPage: Boolean!')
  lines.push('  endCursor: String')
  lines.push('}')
  lines.push('')
  const queries: string[] = []
  const orderEnums: string[] = []
  for (const t of types) {
    const { single, plural } = rootNames(t.name)
    queries.push(`${single}(iri: ID!): ${t.name}`)

    // scan-root args: equality filter per single-valued scalar leaf (arg name =
    // field name) + orderBy enum when orderable fields exist (docs/06)
    const leaves = scalarLeafArgs(t)
    const filterArgs = leaves.map((f) => `${f.name}: String`).join(', ')
    const hasOrdering = leaves.length > 0
    if (hasOrdering) {
      const members = leaves
        .flatMap((f) => [`  ${orderMember(f.name, 'ASC')}`, `  ${orderMember(f.name, 'DESC')}`])
        .join('\n')
      orderEnums.push(`enum ${t.name}OrderBy {\n${members}\n}`)
    }
    const orderByArg = hasOrdering ? `, orderBy: ${t.name}OrderBy` : ''
    queries.push(`${plural}(${filterArgs}${leaves.length > 0 ? ', ' : ''}first: Int = 20, after: String${orderByArg}): ${pageType(t.name)}`)
  }
  queries.sort((a, b) => a.localeCompare(b))
  for (const e of orderEnums) {
    lines.push(e)
    lines.push('')
  }
  lines.push('type Query {')
  lines.push(...queries.map((q) => `  ${q}`))
  lines.push('}')

  return `${lines.join('\n')}\n`
}
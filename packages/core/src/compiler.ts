/**
 * @verax/core — the compiler: GraphQL document + module → Plan (ADR-1 IR).
 *
 * v0 scope (M1 slice 2), fail-loud on everything outside it:
 *  - queries only (no mutation surface exists in the platform, docs/03)
 *  - no fragments, no system fields (`__*`) — later milestones
 *  - variables resolve as `{ variable }` bindings — never interpolated text (D7)
 *  - every emitted node carries the module's explicit graph set (D10)
 *  - cost computed per the docs/08 v0 constants, before execution (the pre-execution
 *    rejection is the M2 `@budget` hook; the number itself is already contract)
 */
import { createHash } from 'node:crypto'
import {
  GraphQLError,
  parse,
  visit,
  type DocumentNode,
  type FieldNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql'
import {
  canonicalJson,
  compoundingBelow,
  type AlgebraNode,
  type Binding,
  type Plan,
} from './ir.js'

// docs/08 cost-model constants (v0). When the cost-model schema lands, these
// move to config — the formula shape is already pinned by the snapshot tests.
const FIELD_WEIGHT = 1
const HOPS_COMPOUNDING = 0.3
const LIST_FACTOR = 2
const FILTER_FACTOR_PER_ARG = 0.25

export class CompilerError extends Error {
  constructor(message: string) {
    super(`[@verax/compiler] ${message}`)
    this.name = 'CompilerError'
  }
}

/** One entry of the module's semantic map (field → SHACL path contract), as emitted by the generator. */
export interface SemanticFieldEntry {
  readonly pathIri: string
  readonly inverse: boolean
  readonly itemClass?: string
  /** GraphQL type name of the referenced class — needed to recurse into sub-selections. */
  readonly itemTypeName?: string
  readonly datatype?: string
  readonly cardinality: 'single' | 'list'
}

export interface SemanticRootEntry {
  readonly typeName: string
  readonly targetClass: string
  readonly mode: 'single' | 'list'
  readonly defaultPageSize: number
}

export interface SemanticMap {
  readonly fields: Readonly<Record<string, SemanticFieldEntry>>
  readonly roots: Readonly<Record<string, SemanticRootEntry>>
}

export interface VeraxModule {
  readonly moduleId: string
  readonly schemaHash: string
  readonly schema: GraphQLSchema
  readonly semanticMap: SemanticMap
  /** Explicit graph set stamped onto every plan node (D10). */
  readonly datasetGraphs: readonly string[]
  /**
   * ACL graph scope (M2 slice 2): the store-side membership graph the SPARQL
   * projection joins against (urn:...:memberOf / principal/group vocabulary).
   * Missing on unstamped modules; required for stamped plans to run store-side.
   */
  readonly aclGraph?: string
}

/**
 * Registry directives must never originate from clients (docs/03 rule 1): any
 * security-set directive appearing in a request document is rejected wholesale
 * with the typed code — ignored-not-silently is the failure mode that breeds
 * both support tickets and false confidence.
 */
const REGISTRY_DIRECTIVES = new Set(['requireGroup', 'traversalScope'])
const VX_DIRECTIVE_REJECTED = 'VX_DIRECTIVE_REJECTED'

export function compileDocument(source: string, module: VeraxModule): Plan {
  let document: DocumentNode
  try {
    document = parse(source)
  } catch (err) {
    throw new CompilerError(`document does not parse: ${(err as GraphQLError).message}`)
  }

  // client-supplied registry directives: reject the whole document.
  // graphql's visit() is the AST-walker here — a hand-rolled one walked into
  // circular loc/token structures once already (never again).
  const offending = new Set<string>()
  visit(document, {
    Directive: (node) => {
      if (REGISTRY_DIRECTIVES.has(node.name.value)) offending.add(node.name.value)
    },
  })
  if (offending.size > 0) {
    throw new CompilerError(
      `${VX_DIRECTIVE_REJECTED}: client documents may not supply security directives (${[...offending].sort().join(', ')})`,
    )
  }

  if (document.definitions.some((d) => d.kind === 'FragmentDefinition')) {
    throw new CompilerError('fragments are not supported in compiler v0')
  }
  const operations = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
  )
  if (operations.length === 0) throw new CompilerError('no operation found in document')
  if (operations.length > 1) throw new CompilerError('exactly one operation per document in v0')

  const op = operations[0]!
  if (op.operation !== 'query') {
    throw new CompilerError('only queries are compilable — there is no write surface (docs/03)')
  }
  if (!op.selectionSet || op.selectionSet.selections.length === 0) {
    throw new CompilerError('operation has an empty selection set')
  }

  const roots: AlgebraNode[] = []
  for (const selection of op.selectionSet.selections) {
    if (selection.kind !== 'Field') {
      throw new CompilerError('only plain fields are supported at the root in v0')
    }
    roots.push(compileRootField(selection, module))
  }

  const cost = sumCost(roots)
  const planCore = {
    documentHash: createHash('sha256').update(canonicalJson({ source })).digest('hex'),
    moduleId: module.moduleId,
    schemaHash: module.schemaHash,
    cost,
    roots,
  }
  return {
    ...planCore,
    planId: createHash('sha256').update(canonicalJson(planCore)).digest('hex'),
  }
}

/** Recursive visitor over the request AST collecting registry directives (all node kinds). */
function compileRootField(field: FieldNode, module: VeraxModule): AlgebraNode {
  const name = field.name.value
  if (name.startsWith('__')) throw new CompilerError(`system field ${name} is not plan-compilable in v0`)

  const root = module.semanticMap.roots[name]
  if (!root) throw new CompilerError(`unknown root field "${name}" — not in the module contract`)
  if (!field.selectionSet) throw new CompilerError(`root field "${name}" requires a selection set`)

  const args = collectArgs(field)
  const graphs = module.datasetGraphs

  if (root.mode === 'single') {
    const iri = args['iri']
    if (iri === undefined) throw new CompilerError(`root field "${name}" requires its iri argument`)
    const children = compileEntityChildren(field.selectionSet, root.typeName, module)
    return {
      kind: 'EntityLookup',
      rootField: name,
      typeName: root.typeName,
      targetClass: root.targetClass,
      mode: 'single',
      iri,
      argumentCount: Object.keys(args).length,
      graphs,
      constraints: ['explicit-graph', ...typeLevelConstraints(module, root.typeName)],
      children,
    }
  }

  // Connection roots: edges/cursor/pageInfo are response shaping (recorded as
  // hints); edges.node's sub-selection is the real entity algebra.
  const shaping: ConnectionTaxonomy = { entityChildren: [], edges: false, pageInfo: false }
  for (const selection of field.selectionSet.selections) {
    if (selection.kind !== 'Field') {
      throw new CompilerError(`fragments inside connection "${name}" are unsupported in v0`)
    }
    const sel = selection.name.value
    if (sel.startsWith('__')) throw new CompilerError(`system field ${sel} is not plan-compilable in v0`)
    if (sel === 'pageInfo') {
      shaping.pageInfo = true
      continue
    }
    if (sel === 'edges') {
      shaping.edges = true
      for (const edgeChild of selection.selectionSet?.selections ?? []) {
        if (edgeChild.kind !== 'Field') {
          throw new CompilerError('only plain node/cursor selections are supported under edges in v0')
        }
        const edgeName = edgeChild.name.value
        if (edgeName === 'cursor') continue // executor-computed, not a path
        if (edgeName !== 'node') throw new CompilerError(`unsupported edge field "${edgeName}" in v0`)
        if (edgeName.startsWith('__')) throw new CompilerError(`system field ${edgeName} is not plan-compilable in v0`)
        if (!edgeChild.selectionSet) throw new CompilerError('edges.node requires a selection set')
        shaping.entityChildren.push(
          ...compileEntityChildren(edgeChild.selectionSet, root.typeName, module),
        )
      }
      continue
    }
    throw new CompilerError(`unsupported connection field "${sel}" under root "${name}" in v0`)
  }

  return {
    kind: 'EntityLookup',
    rootField: name,
    typeName: root.typeName,
    targetClass: root.targetClass,
    mode: 'scan',
    argumentCount: Object.keys(args).length,
    pagination: {
      first: args['first'],
      after: args['after'],
      defaultFirst: root.defaultPageSize,
    },
    connectionShaping: { edges: shaping.edges, pageInfo: shaping.pageInfo },
    graphs,
    constraints: ['explicit-graph', ...typeLevelConstraints(module, root.typeName)],
    children: shaping.entityChildren,
  }
}

interface ConnectionTaxonomy {
  entityChildren: AlgebraNode[]
  edges: boolean
  pageInfo: boolean
}

function compileEntityChildren(set: SelectionSetNode, typeName: string, module: VeraxModule): AlgebraNode[] {
  const children: AlgebraNode[] = []
  for (const selection of set.selections) {
    if (selection.kind !== 'Field') {
      throw new CompilerError(`fragments under ${typeName} are unsupported in v0`)
    }
    const fieldName = selection.name.value
    if (fieldName.startsWith('__')) throw new CompilerError(`system field ${fieldName} is not plan-compilable in v0`)

    const key = `${typeName}.${fieldName}`
    const mapped = module.semanticMap.fields[key]
    if (!mapped) {
      throw new CompilerError(
        `field ${key} has no path mapping in the module contract (schema/data drift — a build error, not a runtime guess)`,
      )
    }

    if (mapped.datatype && selection.selectionSet) {
      throw new CompilerError(`scalar field ${key} cannot have a selection set`)
    }
    if (mapped.itemClass && !mapped.itemTypeName) {
      throw new CompilerError(`contract hole: ${key} maps a class with no type name`)
    }

    const itemType = mapped.datatype
      ? ({ kind: 'datatype', iri: mapped.datatype } as const)
      : ({ kind: 'class', iri: mapped.itemClass ?? '' } as const)

    // Generator-stamped directives travel from the SDL into the IR here —
    // docs/03 rule 1: constraints only ever accumulate on this readonly list.
    children.push({
      kind: 'FieldExpansion',
      field: key,
      path: mapped.pathIri,
      inverse: mapped.inverse,
      cardinality: mapped.cardinality,
      itemType,
      itemTypeConstraints:
        mapped.itemTypeName !== undefined ? typeLevelConstraints(module, mapped.itemTypeName) : [],
      graphs: module.datasetGraphs,
      constraints: fieldLevelConstraints(module, typeName, fieldName),
      children:
        mapped.itemTypeName && selection.selectionSet
          ? compileEntityChildren(selection.selectionSet, mapped.itemTypeName, module)
          : [],
    })
    if (mapped.itemTypeName && !selection.selectionSet) {
      throw new CompilerError(`object field ${key} requires a selection set`)
    }
  }
  if (children.length === 0) {
    throw new CompilerError(`empty selection set under ${typeName}`)
  }
  return children
}

/**
 * D7 groundwork: values are *bound*, never interpolated. Variable nodes become
 * `{ variable }` references; literals become themselves. List/object/enum
 * arguments are rejected loudly in v0 — enums later compile to IN-bindings
 * over declared values (docs/06), never to inline text.
 */
/**
 * Read @requireGroup stamps off the schema's type definitions into IR
 * constraint IDs. The SDL is the stamped artifact; parsing the *request* can
 * never add or satisfy a registry directive (walkDocumentNode rejects them).
 */
function directivesToConstraints(astNode: { directives?: readonly { name: { value: string }; arguments?: readonly { name: { value: string }; value: { kind: string; value?: unknown } }[] }[] } | undefined | null): string[] {
  const out: string[] = []
  for (const directive of astNode?.directives ?? []) {
    if (directive.name.value !== 'requireGroup' && directive.name.value !== 'traversalScope') continue
    const groupArg = directive.arguments?.find((a) => a.name.value === 'group')
    const group = groupArg && 'value' in groupArg.value ? String(groupArg.value.value ?? '') : ''
    if (group === '') {
      throw new CompilerError(`stamped @${directive.name.value} without a group argument — build drift, refusing`)
    }
    // prefix = the enforcement track: visible denial vs existence-blind edge
    const prefix = directive.name.value === 'traversalScope' ? 'traversal:' : 'group:'
    out.push(`${prefix}${group}`)
  }
  return out
}

function typeLevelConstraints(module: VeraxModule, typeName: string): string[] {
  const type = module.schema.getType(typeName)
  const astNode = type?.astNode
  if (!astNode) return []
  return directivesToConstraints(astNode)
}

function fieldLevelConstraints(module: VeraxModule, typeName: string, fieldName: string): string[] {
  const type = module.schema.getType(typeName)
  const field = type && 'getFields' in type ? type.getFields()[fieldName] : undefined
  if (!field?.astNode) return []
  return directivesToConstraints(field.astNode)
}

function collectArgs(field: FieldNode): Record<string, Binding> {
  const out: Record<string, Binding> = {}
  for (const arg of field.arguments ?? []) {
    out[arg.name.value] = valueToBinding(arg.value, `${field.name.value}(${arg.name.value}: …)`)
  }
  return out
}

function valueToBinding(value: ValueNode, where: string): Binding {
  switch (value.kind) {
    case 'StringValue':
      return value.value
    case 'IntValue':
      return Number.parseInt(value.value, 10)
    case 'FloatValue':
      return Number.parseFloat(value.value)
    case 'BooleanValue':
      return value.value
    case 'NullValue':
      return null
    case 'Variable':
      return { variable: value.name.value }
    case 'EnumValue':
      throw new CompilerError(`enum arguments compile to IN-bindings in a later milestone — unsupported in v0 (${where})`)
    case 'ListValue':
    case 'ObjectValue':
      throw new CompilerError(`list/object arguments are unsupported in v0 (${where})`)
    default:
      throw new CompilerError(`unsupported argument value node (${where})`)
  }
}

/** docs/08 v0: Σ fieldWeight × (1 + 0.3 × compoundingBelow) × listFactor × filterFactor. */
function sumCost(nodes: readonly AlgebraNode[]): number {
  let total = 0
  const visit = (node: AlgebraNode): void => {
    total += nodeCost(node)
    for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return total
}

function nodeCost(node: AlgebraNode): number {
  const listFactor =
    (node.kind === 'EntityLookup' && node.mode === 'scan') ||
    (node.kind === 'FieldExpansion' && node.cardinality === 'list')
      ? LIST_FACTOR
      : 1
  const filterFactor =
    node.kind === 'EntityLookup' ? 1 + FILTER_FACTOR_PER_ARG * node.argumentCount : 1
  return rounded(FIELD_WEIGHT * (1 + HOPS_COMPOUNDING * compoundingBelow(node)) * listFactor * filterFactor)
}

/** Cost is a contract number: round to a fixed precision so snapshots never wobble on float printing. */
function rounded(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
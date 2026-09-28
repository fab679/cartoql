/**
 * Schema-aware autocomplete: the graphql parser resolves the caret's innermost
 * context; a type-stack walks it. Provide: field names at the caret's parent
 * type, argument names inside a call, enum members for orderBy-style args, and
 * fragment-condition types within a polymorphic field. If the document doesn't
 * fully parse (mid-typing), a brace-depth fallback keeps the popup alive.
 */
import { buildSchema, parse, visit, type GraphQLSchema, type DocumentNode } from 'graphql'

export interface Suggestion {
  readonly label: string
  readonly detail: string
  readonly kind: 'field' | 'argument' | 'enum' | 'fragment'
}

let cachedSchemaText: string | null = null
let cachedSchema: GraphQLSchema | null = null

export function schemaFrom(sdl: string): GraphQLSchema | null {
  if (sdl === cachedSchemaText) return cachedSchema
  try {
    cachedSchema = buildSchema(sdl)
    cachedSchemaText = sdl
    return cachedSchema
  } catch {
    return null
  }
}

function namedTypeName(s: string): string {
  return s.replace(/[[\]!]/g, '').replace(/^/, '')
}

function fieldsOf(schema: GraphQLSchema, typeName: string): Suggestion[] {
  const type = schema.getType(typeName)
  if (type === undefined || !('getFields' in type)) return []
  const fields = Object.values((type as unknown as { getFields(): Record<string, { name: string; type: { toString(): string }; args: unknown[] }> }).getFields())
  const suggestions: Suggestion[] = fields.map((field) => ({
    label: field.name,
    detail: String(field.type),
    kind: 'field' as const,
  }))
  suggestions.push({ label: '__typename', detail: 'computed discriminator', kind: 'field' })
  const maybeUnion = type as unknown as { getTypes?: () => Array<{ name: string }> }
  if (typeof maybeUnion.getTypes === 'function') {
    for (const t of maybeUnion.getTypes()) {
      suggestions.push({ label: `...on ${t.name}`, detail: 'typed fragment', kind: 'fragment' })
    }
  }
  return suggestions
}

function argumentsOf(schema: GraphQLSchema, parentTypeName: string, fieldName: string): Suggestion[] {
  const type = schema.getType(parentTypeName)
  if (type === undefined || !('getFields' in type)) return []
  const field = (type as unknown as { getFields(): Record<string, { args: Array<{ name: string; type: { toString(): string } }> }> }).getFields()[fieldName]
  if (field === undefined) return []
  return field.args.map((arg) => ({ label: `${arg.name}: `, detail: String(arg.type), kind: 'argument' as const }))
}

function enumMembersOf(schema: GraphQLSchema, typeName: string): Suggestion[] {
  const type = schema.getType(typeName)
  if (type === undefined || !('getValues' in type)) return []
  const values = (type as unknown as { getValues(): Array<{ name: string; description?: string | null }> }).getValues()
  return values.map((value) => ({ label: value.name, detail: value.description ?? 'enum member', kind: 'enum' as const }))
}

function enumTypeForArg(schema: GraphQLSchema, parentTypeName: string, fieldName: string, argName: string): string | null {
  const type = schema.getType(parentTypeName)
  if (type === undefined || !('getFields' in type)) return null
  const field = (type as unknown as { getFields(): Record<string, { args: Array<{ name: string; type: { toString(): string } }> }> }).getFields()[fieldName]
  if (field === undefined) return null
  for (const arg of field.args) {
    if (arg.name === argName) return namedTypeName(String(arg.type))
  }
  return null
}

export function suggestionsAt(
  document: string,
  caretIndex: number,
  schema: GraphQLSchema | null,
): readonly Suggestion[] {
  if (schema === null) return []
  const rootType = schema.getQueryType()
  const rootFields: Suggestion[] = rootType
    ? Object.values(rootType.getFields()).map((f) => ({ label: f.name, detail: String(f.type), kind: 'field' as const }))
    : []

  const head = document.slice(0, caretIndex)
  // explicit enum member context: "orderBy: NAME_..."
  const enumArgMatch = /orderBy:\s*([A-Za-z_]*)$/.exec(head)
  if (enumArgMatch !== null) {
    const entityMatch = /([A-Za-z][A-Za-z0-9_]*)\(/.exec(head.slice(0, enumArgMatch.index))
    const entityName = entityMatch?.[1]
    if (entityName !== undefined) {
      const enumTypeName = `${entityName}OrderBy`
      const members = enumMembersOf(schema, enumTypeName)
      if (members.length > 0) return members
    }
  }

  let parsed: DocumentNode
  try {
    parsed = parse(document)
  } catch {
    return fuzzyFallback(document, caretIndex, schema, rootFields)
  }

  let candidates: Suggestion[] = rootFields
  // a stack of type names; root document runs against the Query type
  const typeStack: string[] = rootType ? [rootType.name] : []
  let currentField: string | null = null
  let currentFieldParent: string | null = null

  visit(parsed, {
    Field: {
      enter: (node) => {
        currentField = node.name.value
        currentFieldParent = typeStack[typeStack.length - 1] ?? null
        // include: arguments of THIS field may contain the caret
        const fieldArgs = (node as { arguments?: unknown }).arguments
        void fieldArgs
        if (node.selectionSet !== undefined && caretBetween(caretIndex, node.selectionSet.loc)) {
          candidates = fieldsOf(schema, typeStack[typeStack.length - 1] ?? '')
        }
      },
      leave: () => {
        currentField = null
        currentFieldParent = null
      },
    },
    InlineFragment: {
      enter: (node) => {
        const condition = node.typeCondition?.name.value
        if (condition !== undefined) typeStack.push(condition)
        if (node.selectionSet !== undefined && caretBetween(caretIndex, node.selectionSet.loc)) {
          candidates = fieldsOf(schema, condition ?? typeStack[typeStack.length - 1] ?? '')
        }
      },
      leave: () => { typeStack.pop() },
    },
  })
  // no selectionSet contains the caret → argument names of the innermost field
  if (currentField !== null && currentFieldParent !== null) {
    const args = argumentsOf(schema, currentFieldParent, currentField)
    if (args.length > 0) candidates = args
  }
  return candidates
}

// --

function caretBetween(caretIndex: number, loc: { start: number; end: number } | undefined): boolean {
  return loc !== undefined && caretIndex >= loc.start && caretIndex <= loc.end
}

function resolveOpenFieldName(head: string): string | null {
  // innermost "name(" whose parens have not closed: the call we're typing in
  const opens: string[] = []
  for (const m of head.matchAll(/([A-Za-z][A-Za-z0-9_]*)(\()/g)) opens.push(m[1]!, head.slice(m.index! + m[0].length))
  // find last unclosed "("
  let depth = 0
  for (let i = head.length - 1; i >= 0; i -= 1) {
    const c = head[i]
    if (c === ')') depth += 1
    else if (c === '(') {
      if (depth === 0) {
        const before = head.slice(0, i)
        const nameMatch = /([A-Za-z][A-Za-z0-9_]*)$/.exec(before)
        return nameMatch?.[1] ?? null
      }
      depth -= 1
    }
  }
  return null
}

function fuzzyFallback(document: string, caretIndex: number, schema: GraphQLSchema, rootFields: readonly Suggestion[]): readonly Suggestion[] {
  const head = document.slice(0, caretIndex)
  const typedMatch = /([A-Za-z][A-Za-z0-9_]*)\s*\{/.exec(head)
  const lastTyped = reverseFind(typedMatch?.[1] ?? '', head)
  // typed inline fragment context? "fragment X on T {" or "...on T {"
  const fragMatch = /\.\.\.\s*on\s+([A-Za-z][A-Za-z0-9_]*)\s*\{[^{}]*$/.exec(head)
  if (fragMatch !== null) return fieldsOf(schema, fragMatch[1]!)
  if (typedMatch !== null && lastTyped !== '') {
    const fields = fieldsOf(schema, lastTyped!)
    if (fields.length > 0) return fields
  }
  const openCall = resolveOpenFieldName(head)
  if (openCall !== null) {
    // typing arguments of a root call: first: / after: / orderBy candidates
    const args: Suggestion[] = []
    const known: Array<[string, string, 'argument' | 'enum']> = []
    void known
    // if a known root type field, name its args precisely
    const fieldType = rootFields.find((f) => f.label === openCall)
    if (fieldType !== undefined) {
      const { detail } = fieldType
      const entityName = /([A-Za-z][A-Za-z0-9_]*)!/.exec(detail)?.[1]
      args.push({ label: 'first: ', detail: 'Int — page size', kind: 'argument' })
      args.push({ label: 'after: ', detail: 'String — cursor', kind: 'argument' })
      args.push({ label: 'name: ', detail: 'String — equality filter (single-valued scalar leaves)', kind: 'argument' })
      if (entityName !== undefined) args.push({ label: 'orderBy: ', detail: `${entityName}OrderBy members below`, kind: 'argument' })
    }
    if (args.length > 0) return args
  }
  const braceDepth = (head.match(/\{/g)?.length ?? 0) - (head.match(/\}/g)?.length ?? 0)
  if (braceDepth <= 1) return rootFields
  return fuzzyFindScopedType(head, schema) ?? rootFields
}

function reverseFind(name: string, _head: string): string {
  void _head
  return name
}

function fuzzyFindScopedType(head: string, schema: GraphQLSchema): readonly Suggestion[] | null {
  const matches: string[] = []
  let i = 0
  for (const m of head.matchAll(/\{|\}/g)) {
    if (m[0] === '{') {
      const before = head.slice(0, m.index!)
      const nameMatch = /([A-Za-z][A-Za-z0-9_]*)(?:\([^)]*\))?\s*\{$/.exec(before)
      if (nameMatch !== null) matches.push(nameMatch[1]!)
      i += 1
    }
  }
  const last = matches[matches.length - 1]
  if (last === undefined) return null
  // drain through: try type names and field names (any type containing that field)
  const fields = fieldsOf(schema, last)
  if (fields.length > 0) return fields
  for (const typeName of Object.keys(schema.getTypeMap())) {
    const type = schema.getType(typeName)
    if (type === undefined || !('getFields' in type)) continue
    const map = (type as { getFields(): Record<string, unknown> }).getFields()
    if (last in map) {
      const resolved = fieldsOf(schema, typeName)
      if (resolved.length > 0) return resolved
    }
  }
  return null
}

import type { GraphQLSchema } from 'graphql'

/**
 * Schema-aware query skeletons for the rail 'use' buttons — what lands in the
 * editor PARSES on the first try and answers the discovery question directly:
 * connection roots scaffold `edges { node { iri … } }` so the listing SHOWS
 * entity IRIs; single-entity roots take the IRI you copied from a listing.
 */
export function buildQuerySkeleton(schema: GraphQLSchema | null, fieldLine: string): string {
  const line = fieldLine.trim()
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9_]*)/.exec(line)
  if (nameMatch === null) return `query {\n  \n}`
  const name = nameMatch[1]!

  // required args only, typed placeholders
  const argsTextMatch = /\(([^)]*)\)/.exec(line)
  const args: string[] = []
  if (argsTextMatch !== null) {
    for (const piece of argsTextMatch[1]!.split(',')) {
      const arg = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*([^\s]+)/.exec(piece)
      if (arg === null) continue
      const argName = arg[1]!
      const argType = arg[2]!
      if (!argType.includes('!')) continue
      args.push(argType.startsWith('Int') ? `${argName}: 20` : `${argName}: "…"`)
    }
  }

  const fieldsOf = (type: unknown): Record<string, { name: string; type: { toString(): string } }> | null =>
    type !== null && typeof type === 'object' && 'getFields' in (type as object)
      ? (type as { getFields(): Record<string, { name: string; type: { toString(): string } }> }).getFields()
      : null
  const stripWrappers = (ref: string): string => ref.replace(/[[\]!]/g, '')

  let body = ''
  if (schema !== null && schema.getQueryType() !== null && schema.getQueryType() !== undefined) {
    const field = fieldsOf(schema.getQueryType())?.[name]
    if (field !== undefined) {
      const typeRef = String(field.type)
      const targetType = schema.getType(stripWrappers(typeRef))
      if (typeRef.includes('Connection') && targetType !== undefined) {
        // listing: edges { node { iri NAME } } — resolve the NODE entity's
        // fields (edges.type → EdgeWrap → node.type → entity), not the wrapper
        const entityTypeRef = fieldsOf(targetType)?.['edges']?.type
        const edgeType = entityTypeRef !== undefined ? schema.getType(stripWrappers(String(entityTypeRef))) : undefined
        const nodeTypeRef = edgeType !== undefined ? fieldsOf(edgeType)?.['node']?.type : undefined
        const nodeType = nodeTypeRef !== undefined ? schema.getType(stripWrappers(String(nodeTypeRef))) : undefined
        const prefs = ['name', 'title', 'label']
        const pick = (fieldList: Array<{ name: string; type: { toString(): string } }>): string =>
          fieldList.find((f) => f.name === 'name')?.name
          ?? fieldList.find((f) => prefs.includes(f.name))?.name
          ?? fieldList.find((f) => !String(f.type).includes('[') && f.name !== 'iri' && !String(f.type).includes('Connection'))?.name
          ?? fieldList.find((f) => !String(f.type).includes('['))?.name
          ?? 'iri'
        const nodeFields = nodeType !== undefined ? Object.values(fieldsOf(nodeType) ?? {}) : []
        const selection = nodeFields.length === 0 ? 'iri' : `iri ${pick(nodeFields)}`
        body = `edges {\n    node { ${selection} }\n  }`
      } else if (targetType !== undefined && fieldsOf(targetType) !== null) {
        const targetFields = Object.values(fieldsOf(targetType) ?? {})
        const named = targetFields.find((f) => f.name === 'name')
        const labeled = targetFields.find((f) => f.name === 'label' || f.name === 'title')
        const firstScalar = targetFields.find((f) => !String(f.type).includes('[') && f.name !== 'iri')
        body = named !== undefined ? `iri name` : labeled !== undefined ? `iri ${labeled.name}` : firstScalar !== undefined ? `iri ${firstScalar.name}` : 'iri'
      }
    }
  }

  // selection sets cannot be empty (the reported parse failure): at minimum iri
  if (body === '') body = 'iri'
  const call = args.length === 0 ? name : `${name}(${args.join(', ')})`
  return `query {\n  ${call} {\n    ${body}\n  }\n}`
}

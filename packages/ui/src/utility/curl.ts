/** COPY CURL: the exact wire request as a shell command. */
export function toCurl(endpoint: string, query: string, variables: Record<string, unknown>, principal?: string, bearer?: string): string {
  const headers = ["-H 'content-type: application/json'"]
  if (principal !== undefined && principal !== '') headers.push(`-H 'x-cartoql-principal: ${principal}'`)
  if (bearer !== undefined && bearer !== '') headers.push(`-H 'authorization: Bearer ${bearer}'`)
  const payload = JSON.stringify({ query, variables })
  return `curl -X POST '${endpoint.replace(/\/+$/, '')}' ${headers.join(' ')} -d '${payload.replace(/'/g, `'\\''`)}'`
}

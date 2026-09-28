/** Field-line to the gateway. Errors carry typed CQL_* codes — never parse messages. */

export interface GraphQLErrorEntry {
  readonly message: string
  readonly path?: string
  readonly extensions?: { readonly code?: string } & Record<string, unknown>
}

export interface GraphQLErrorResponse {
  readonly errors?: readonly GraphQLErrorEntry[]
  readonly data?: unknown
}

export interface Health {
  readonly status?: string
  readonly adapter?: string
  readonly auth?: string
  readonly schemaHash?: string
  readonly aclGraph?: string | null
}

export interface Explain {
  readonly planId: string
  readonly cost: number
  readonly depth: number
  readonly nodeCount: number
  readonly budgets?: { readonly maxCost?: number; readonly maxDepth?: number; readonly maxNodes?: number }
  readonly withinBudget: boolean
}

export interface RunResult {
  readonly body: unknown
  readonly status: number
  readonly ms: number
}

async function request(
  endpoint: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  // same-origin serving (the gateway --ui mode): an empty endpoint means
  // RELATIVE fetches — the console works out of the box wherever it's served
  const trimmed = endpoint.replace(/\/+$/, '')
  const response = await fetch(trimmed === '' ? path : `${trimmed}${path}`, init)
  if (!response.ok && response.status !== 400) {
    throw new Error(`gateway answered ${response.status} — is it running?`)
  }
  return response
}

export async function runQuery(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  principal?: string,
  bearer?: string,
): Promise<RunResult> {
  const started = performance.now()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (principal) headers['x-cartoql-principal'] = principal
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const response = await request(endpoint, '/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })
  return { body: await response.json(), status: response.status, ms: performance.now() - started }
}

export async function explain(endpoint: string, query: string): Promise<Explain> {
  const response = await request(endpoint, '/explain', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  return (await response.json()) as Explain
}

export async function health(endpoint: string): Promise<Health> {
  return (await (await request(endpoint, '/health', { method: 'GET' })).json()) as Health
}

export async function sdl(endpoint: string): Promise<string> {
  return await (await request(endpoint, '/sdl', { method: 'GET' })).text()
}

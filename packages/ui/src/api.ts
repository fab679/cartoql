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
  const url = trimmed === '' ? path : `${trimmed}${path}`
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    // refused connection / CORS network error: nothing answered at the URL
    throw new Error(`cannot reach ${url} — no gateway is listening there; check the endpoint port (or clear it for same-origin)`)
  }
  if (!response.ok && response.status !== 400) {
    let detail = ''
    try {
      const body = (await response.json()) as { errors?: Array<{ message?: string }> }
      detail = body.errors?.[0]?.message ? `: ${body.errors[0].message.slice(0, 120)}` : ''
    } catch { /* body wasn't json */ }
    throw new Error(`gateway answered ${response.status}${detail}`)
  }
  return response
}

export async function runQuery(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  principal?: string,
  bearer?: string,
  /** 'json-ld' negotiates Accept: application/ld+json (gateway response representation, docs/04). */
  output: 'json' | 'json-ld' = 'json',
): Promise<RunResult> {
  const started = performance.now()
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (output === 'json-ld') headers['accept'] = 'application/ld+json'
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

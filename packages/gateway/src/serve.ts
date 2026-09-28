/**
 * @verax/gateway — `serve`: the HTTP surface (docs/04 Path 1).
 *
 * v0 runtime modes:
 *  - `--data file.ttl` → reference adapter (in-memory store) — the zero-store
 *    quickstart path; fully green end to end
 *  - `--sparql URL` → SPARQL 1.1 HTTP adapter, live end to end — L0
 *    response-equivalence proven against Oxigraph via the parity suite
 *    (`VERAX_TEST_SPARQL_ENDPOINT`, packages/adapters/sparql-http/parity.test.ts)
 *
 * Endpoints:
 *  - POST /graphql      { query, variables } → compile+execute, { data, errors }
 *  - GET  /playground   minimal HTML console (no build step, no CDN deps)
 *  - GET  /health       operator posture: adapter, schema hash, SDL version
 *
 * v0 errors carry `extensions.name` (CompilerError/ExecutorError); the typed
 * `VX_*` error-code surface (docs/03 Part II) lands with M2's directive pass —
 * the gateway never invents codes before the contract does.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { buildSchema, parse, validate } from 'graphql'
import { generateSdl } from '../../generator/src/index.js'
import { compileDocument, CompilerError, type VeraxModule } from '../../core/src/compiler.js'
import { ExecutorError, type ResponseData, type SecurityContext } from '../../core/src/executor.js'
import {
  OpenResolver,
  resolveView,
  StaticResolver,
  type PermissionResolver,
} from '../../core/src/security.js'
import { jwtGroupsResolver } from '../../core/src/providers.js'
import { BudgetError, enforceBudgets, DEFAULT_BUDGETS, type BudgetLimits } from '../../core/src/budgets.js'
import type { Plan } from '../../core/src/ir.js'
import { loadConfig, type VeraxConfig } from '../../core/src/config.js'
import { planDepth, planNodeCount } from '../../core/src/ir.js'
import { Metrics, logLine, type MetricFamily } from '../../core/src/metrics.js'
import { ReferenceAdapter } from '../../adapters/reference/src/index.js'
import { SparqlHttpAdapter } from '../../adapters/sparql-http/src/index.js'

export interface ServeOptions {
  ontologyFile: string
  shapesFile: string
  dataFile?: string
  sparqlEndpoint?: string
  port?: number
  moduleId?: string
  /** D10: the executed module's explicit graph scope. Must match where the store holds the data. */
  datasetGraphs?: readonly string[]
  /** CLI convenience: single --graph IRI fills datasetGraphs. */
  graphFlag?: string
  /**
   * Static claims file (docs/04 Path 2): `{ "alice": ["hr-comp", "legal"] }`.
   * Absent → OpenResolver: the documented no-security posture; health says so.
   */
  authFile?: string
  /** jwt-groups provider: HS256 shared secret (production: jwksUrl via the SPI). */
  jwtSecret?: string
  jwtPrincipalClaim?: string
  jwtGroupsClaim?: string
  /** ACL graph scope for store-side enforcement of stamped modules (M2 slice 2). */
  aclGraph?: string
  /**
   * Stamps file (docs/03: generator-stamped security): the module is only
   * security-relevant if its stamps were part of generation. Without this the
   * gateway serves an unstamped schema — open by module, not by accident.
   */
  stampsFile?: string
  /** Budget gates (docs/08; threat T3's mitigation, now live): VX_QUERY_TOO_COMPLEX. */
  budgets?: BudgetLimits
  /** verax.json path (docs/10): file values apply, explicit flags override. */
  configFile?: string
  /** Metrics families to record (docs/10: absent = never recorded). */
  metricsFamilies?: readonly MetricFamily[] | null
}

export interface RunningGateway {
  readonly server: Server
  readonly url: string
  readonly close: () => Promise<void>
}

export function startGateway(options: ServeOptions): RunningGateway {
  if (options.sparqlEndpoint && options.dataFile) {
    throw new Error('pass either --sparql or --data, not both')
  }
  if (!options.sparqlEndpoint && !options.dataFile) {
    throw new Error('no store configured: pass --data file.ttl (reference mode) or --sparql URL (once landing)')
  }

  // verax.json loads AT BOOT (docs/10: operator surprises are support debt):
  // invalid files refuse the process, not the request
  let fileConfig: VeraxConfig = {}
  if (options.configFile !== undefined) {
    fileConfig = loadConfig(readFileSync(options.configFile, 'utf-8'))
  }
  const budgets: BudgetLimits = options.budgets ?? fileConfig.budgets ?? DEFAULT_BUDGETS
  const metrics = new Metrics({
    families:
      options.metricsFamilies === null
        ? []
        : (options.metricsFamilies ?? fileConfig.observability?.metricsFamilies),
  })

  const ontology = readFileSync(options.ontologyFile, 'utf-8')
  const shapes = readFileSync(options.shapesFile, 'utf-8')
  const datasetGraphs = options.datasetGraphs ?? (options.graphFlag ? [options.graphFlag] : undefined)
  const generated = generateSdl(
    { ontology, shapes },
    options.moduleId ?? 'module',
    {
      ...(datasetGraphs ? { datasetGraphs } : {}),
      ...(options.stampsFile
        ? { stamps: JSON.parse(readFileSync(options.stampsFile, 'utf-8')) as never }
        : {}),
    },
  )

  // Auth posture (docs/04 Path 2): static fixture for tests/demos; oidc/jwt
  // providers slot behind the same PermissionResolver SPI.
  const resolver: PermissionResolver =
    options.jwtSecret !== undefined
      ? jwtGroupsResolver({
          secret: options.jwtSecret,
          ...(options.jwtPrincipalClaim ? { principalClaim: options.jwtPrincipalClaim } : {}),
          ...(options.jwtGroupsClaim ? { groupsClaim: options.jwtGroupsClaim } : {}),
        })
      : options.authFile
        ? new StaticResolver(JSON.parse(readFileSync(options.authFile, 'utf-8')) as Record<string, string[]>)
        : new OpenResolver()
  const module: VeraxModule = {
    moduleId: generated.moduleId,
    schemaHash: generated.schemaHash,
    schema: buildSchema(generated.sdl),
    semanticMap: generated.semanticMap,
    datasetGraphs: generated.datasetGraphs,
    aclGraph: options.aclGraph,
  }

  let adapterName: string
  let run: (plan: ReturnType<typeof compileDocument>, vars: Record<string, string | number | boolean | null>, security: SecurityContext) => ResponseData | Promise<ResponseData>
  if (options.dataFile) {
    const adapter = ReferenceAdapter.fromTurtle(readFileSync(options.dataFile, 'utf-8'), module.datasetGraphs)
    adapterName = `reference (${options.dataFile})`
    run = (plan, vars, security) => adapter.run(plan, module, vars, security)
  } else {
    // SPARQL mode: live since the parity suite — protocol/VALUES transports are
    // auto-selected against the endpoint (docs/09 L0 parity, live-tested on Oxigraph).
    const adapter = new SparqlHttpAdapter({ endpoint: options.sparqlEndpoint! })
    adapterName = `sparql-http (${options.sparqlEndpoint})`
    run = (plan, vars, security) => adapter.run(plan, module, vars, security)
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res)
  })

  // Plan cache (docs/10): compile is pure (document + module), so source+schema
  // is a sound key; size-capped with insertion-order eviction. viewVersion never
  // keys this cache — enforcement happens at run time against the live view, so
  // a cached plan cannot stale-serve security.
  const planCache = new Map<string, Plan>()
  const PLAN_CACHE_MAX = fileConfig.caching?.planCacheMax ?? 512
  const compileCached = (source: string): Plan => {
    const key = `${module.schemaHash}:${source}`
    const hit = planCache.get(key)
    if (hit !== undefined) {
      metrics.inc('plan_cache', 'plan_cache_hits_total')
      return hit
    }
    metrics.inc('plan_cache', 'plan_cache_misses_total')
    const compileTimer = metrics.timer('compile')
    const plan = compileDocument(source, module)
    compileTimer()
    metrics.inc('compile', 'compile_cost_total', {}, plan.cost)
    enforceBudgets(plan, budgets) // reject pre-execution
    if (planCache.size >= PLAN_CACHE_MAX) {
      planCache.delete(planCache.keys().next().value as string)
      metrics.inc('plan_cache', 'plan_cache_evictions_total')
    }
    planCache.set(key, plan)
    return plan
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown, contentType = 'application/json'): void => {
      res.writeHead(status, { 'content-type': contentType })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }

    try {
      if (req.method === 'GET' && req.url === '/metrics') {
        // docs/10 Prometheus exposition; gated by family toggles at the collector
        return send(200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8')
      }
      if (req.method === 'POST' && req.url === '/explain') {
        // threat T3's client-side mitigation: the cost PREVIEW operators and
        // clients use to self-fix before rejection (no data leaves this path)
        const body = await readBody(req)
        let parsed: { query?: unknown }
        try {
          parsed = JSON.parse(body) as typeof parsed
        } catch {
          return send(400, { errors: [{ message: 'request body must be JSON' }] })
        }
        if (typeof parsed.query !== 'string') return send(400, { errors: [{ message: 'missing "query" string' }] })
        try {
          const plan = compileDocument(parsed.query, module)
          return send(200, {
            planId: plan.planId,
            cost: plan.cost,
            depth: (planDepth(plan)),
            nodeCount: (planNodeCount(plan)),
            budgets,
            withinBudget: (() => { try { enforceBudgets(plan, budgets); return true } catch { return false } })(),
          })
        } catch (err) {
          return send(400, { errors: [{ message: (err as Error).message }] })
        }
      }
      if (req.method === 'GET' && req.url === '/health') {
        // docs/10: operators must never discover security posture by accident
        return send(200, {
          status: 'ok',
          adapter: adapterName,
          moduleId: module.moduleId,
          schemaHash: module.schemaHash,
          auth: resolver.provider,
          aclGraph: module.aclGraph ?? null,
          provenance: 'off (M3)',
        })
      }
      if (req.method === 'GET' && (req.url === '/playground' || req.url === '/')) {
        return send(200, playgroundHtml(), 'text/html; charset=utf-8')
      }
      if (req.method === 'POST' && req.url === '/graphql') {
        const requestId = crypto.randomUUID()
        const requestTimer = metrics.timer('requests', { surface: 'graphql' })
        const finish = (status: number): void => {
          requestTimer()
          metrics.inc('requests', 'requests_total', { surface: 'graphql', code: String(status) })
          // docs/10 structured log: fields never free text; never result data,
          // never principal identities (audit channel owns attribution)
          console.log(logLine('graphql_request', { requestId, status, schemaHash: module.schemaHash.slice(0, 12) }))
        }
        const body = await readBody(req)
        let parsed: { query?: unknown; variables?: unknown }
        try {
          parsed = JSON.parse(body) as typeof parsed
        } catch {
          return send(400, { errors: [{ message: 'request body must be JSON' }] })
        }
        if (typeof parsed.query !== 'string') {
          return send(400, { errors: [{ message: 'missing "query" string in request body' }] })
        }
        const variables = normalizeVariables(parsed.variables)

        // Schema validation first (docs/02 gateway step 1–2); then the compile.
        const document = parse(parsed.query)
        const validationErrors = validate(module.schema, document)
        if (validationErrors.length > 0) {
          return send(400, { errors: validationErrors.map((e) => ({ message: e.message })) })
        }
        let plan: Plan
        try {
          plan = compileCached(parsed.query)
        } catch (err) {
          finish(400) // budget rejection counts as a compile rejection (not served)
          if (err instanceof BudgetError) {
            // typed pre-execution rejection — the limits ride in extensions so
            // clients can self-fix instead of guessing
            return send(400, {
              errors: [{
                message: err.message,
                extensions: { code: err.code, metric: err.metric, value: err.value, limit: err.limit },
              }],
            })
          }
          throw err
        }
        // agents run as the human: the principal is per-request (header), the
        // view resolves once per request and failures collapse fail-closed
        const principalId = typeof req.headers['x-verax-principal'] === 'string'
          ? (req.headers['x-verax-principal'] as string)
          : 'anonymous'
        // bearer credentials ride PrincipalContext for jwt/oidc resolvers (docs/04)
        const authz = typeof req.headers['authorization'] === 'string'
          ? (req.headers['authorization'] as string)
          : undefined
        const bearer = authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length) : undefined
        const view = await resolveView(resolver, { principalId, credentials: { bearer } })
        const response = await run(plan, variables, { view, principalId })
        finish(200)
        return send(200, response)
      }
      return send(404, { errors: [{ message: 'not found; try POST /graphql, GET /playground, GET /health' }] })
    } catch (err) {
      if (err instanceof CompilerError || err instanceof ExecutorError) {
        return send(400, { errors: [{ message: err.message, extensions: { name: err.name } }] })
      }
      const message = err instanceof Error ? err.message : 'unknown error'
      return send(500, { errors: [{ message }] })
    }
  }

  const port = options.port ?? 0
  return {
    server,
    get url() {
      const addr = server.address()
      return typeof addr === 'object' && addr ? `http://localhost:${addr.port}` : ''
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function normalizeVariables(raw: unknown): Record<string, string | number | boolean | null> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CompilerError('"variables" must be a JSON object of scalars')
  }
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(raw)) {
    const t = typeof value
    if (value === null || t === 'string' || t === 'number' || t === 'boolean') {
      out[key] = value
    } else {
      throw new CompilerError(`variable $${key} has non-scalar type (${t}) — v0 accepts scalars only`)
    }
  }
  return out
}

function playgroundHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>verax playground</title>
<style>body{font-family:ui-monospace,monospace;max-width:820px;margin:2rem auto;padding:0 1rem}
textarea{width:100%;height:11rem}pre{background:#111;color:#eee;padding:1rem;overflow:auto}</style>
</head><body><h1>verax playground</h1>
<p>POST a GraphQL query with variables (scalars only) to <code>/graphql</code>.</p>
<p><label>variables (JSON):</label><br><input id="vars" size="60" value='{"iri": "…"}' /></p>
<p><textarea id="q"></textarea></p>
<p><button onclick="go()">run</button></p>
<pre id="out">—</pre>
<script>
async function go(){
  const out = document.getElementById('out')
  try {
    const variables = JSON.parse(document.getElementById('vars').value || '{}')
    const r = await fetch('/graphql', {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({query: document.getElementById('q').value, variables})})
    out.textContent = JSON.stringify(await r.json(), null, 2)
  } catch(e){ out.textContent = String(e) }
}
</script></body></html>
`
}
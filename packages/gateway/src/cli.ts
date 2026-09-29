/**
 * `cartoql-gateway serve` — CLI entrypoint (docs/04 Path 1: the 5-minute quickstart).
 *
 * Flags (v0):
 *   --ontology FILE   required. module classes/properties (.ttl)
 *   --shapes   FILE   required. SHACL node shapes (.ttl)
 *   --data     FILE   reference mode: in-memory store over this .ttl
 *   --sparql   URL    SPARQL 1.1 query endpoint (protocol/VALUES transports auto-selected)
 *   --stamps  FILE  security stamps config (docs/03 — @requireGroup rules);
 *                    without it the module is unstamped (open by module)
 *   --auth-file FILE static claims fixture: {"alice": ["hr-comp","legal"]}
 *                     (absent → documented open posture, no security claims)
 *   --acl-graph IRI  ACL graph scope for stamped modules (store-side gates)
 *   --graph    IRI    dataset graph scope (D10 — e.g. urn:cartoql:shard:core).
 *                     Default: urn:cartoql:dataset:default. The store must hold
 *                     the data in this named graph in SPARQL mode.
 *   --config FILE    cartoql.json path (docs/10; explicit flags override file values)
 *   --ui DIR          serve a built UI (packages/ui/dist) statically at /
 *   --metrics off    disable ALL metric families (docs/10 toggle; default: all on)
 *   --port     N      bind port (default: ephemeral, printed on startup)
 */
import { startGateway } from './serve.js'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const value = process.argv[i + 1]
  // a value-less flag must be a usage error, not a swallowed argument — a
  // wrapped/lost token used to cascade into "no store configured" far from the
  // real mistake
  if (value === undefined || value.startsWith('--')) {
    console.error(`error: --${name} needs a value on the same line (was ${value === undefined ? 'missing' : `'${value}'`})`)
    process.exit(2)
  }
  return value
}

const ontologyFile = flag('ontology')
const shapesFile = flag('shapes')
if (!ontologyFile || !shapesFile) {
  console.error('usage: cartoql-gateway serve --ontology ONTO.ttl --shapes SHAPES.ttl --data DATA.ttl [--port N]')
  process.exit(2)
}

const port = flag('port') ? Number.parseInt(flag('port')!, 10) : 0
const gateway = startGateway({
  ontologyFile,
  shapesFile,
  dataFile: flag('data'),
  sparqlEndpoint: flag('sparql'),
  graphFlag: flag('graph'),
  authFile: flag('auth-file'),
  jwtSecret: flag('jwt-secret'),
  jwtPrincipalClaim: flag('jwt-principal-claim'),
  jwtGroupsClaim: flag('jwt-groups-claim'),
  aclGraph: flag('acl-graph'),
  stampsFile: flag('stamps'),
  configFile: flag('config'),
  uiDir: flag('ui'),
  metricsFamilies: flag('metrics') === 'off' ? null : undefined,
  budgets: {
    ...(flag('max-cost') ? { maxCost: Number.parseInt(flag('max-cost')!, 10) } : {}),
    ...(flag('max-depth') ? { maxDepth: Number.parseInt(flag('max-depth')!, 10) } : {}),
  },
  port,
})

gateway.server.listen(port, () => {
  console.log(`cartoql gateway listening on ${gateway.url}`)
  if (flag('ui')) {
    console.log(`  console:    ${gateway.url}/`)
  } else {
    console.log('  console:    build it and serve it — npm --prefix packages/ui run build, then --ui packages/ui/dist')
  }
  console.log(`  graphql:    POST ${gateway.url}/graphql`)
  console.log(`  health:     ${gateway.url}/health`)
})

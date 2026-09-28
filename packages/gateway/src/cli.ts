/**
 * `verax-gateway serve` — CLI entrypoint (docs/04 Path 1: the 5-minute quickstart).
 *
 * Flags (v0):
 *   --ontology FILE   required. module classes/properties (.ttl)
 *   --shapes   FILE   required. SHACL node shapes (.ttl)
 *   --data     FILE   reference mode: in-memory store over this .ttl
 *   --sparql   URL    SPARQL 1.1 query endpoint (protocol/VALUES transports auto-selected)
 *   --graph    IRI    dataset graph scope (D10 — e.g. urn:verax:shard:core).
 *                     Default: urn:verax:dataset:default. The store must hold
 *                     the data in this named graph in SPARQL mode.
 *   --port     N      bind port (default: ephemeral, printed on startup)
 */
import { startGateway } from './serve.js'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const ontologyFile = flag('ontology')
const shapesFile = flag('shapes')
if (!ontologyFile || !shapesFile) {
  console.error('usage: verax-gateway serve --ontology ONTO.ttl --shapes SHAPES.ttl --data DATA.ttl [--port N]')
  process.exit(2)
}

const port = flag('port') ? Number.parseInt(flag('port')!, 10) : 0
const gateway = startGateway({
  ontologyFile,
  shapesFile,
  dataFile: flag('data'),
  sparqlEndpoint: flag('sparql'),
  graphFlag: flag('graph'),
  port,
})

gateway.server.listen(port, () => {
  console.log(`verax gateway listening on ${gateway.url}`)
  console.log(`  playground: ${gateway.url}/playground`)
  console.log(`  graphql:    POST ${gateway.url}/graphql`)
  console.log(`  health:     ${gateway.url}/health`)
})

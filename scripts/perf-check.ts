/**
 * docs/08 SLO band measurement (manual, release-tag discipline): generates the
 * perf shard, loads it into the endpoint under test (or the reference adapter),
 * runs the three representative workloads, and reports p50/p95 from N samples
 * against the reference bands. CI does NOT gate on these (shared runners vary);
 * the numbers land in the release log per docs/08's >15% rule.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSchema } from 'graphql'
import { generateSdl } from '../packages/generator/src/index.js'
import { compileDocument } from '../packages/core/src/compiler.js'
import { ReferenceAdapter } from '../packages/adapters/reference/src/index.js'
import { SparqlHttpAdapter } from '../packages/adapters/sparql-http/src/index.js'
import { loadConfig } from '../packages/core/src/config.js'

const SHARD = process.env['VERAX_PERF_SHARD'] ?? '/tmp/verax-perf-shard'
const ENDPOINT = process.env['VERAX_PERF_ENDPOINT']
const SAMPLES = Number(process.env['VERAX_PERF_SAMPLES'] ?? 20)

execSync(`npx tsx scripts/gen-perf-shard.ts ${SHARD}`, { stdio: 'inherit' })

const shard = 'corpus/shards/core/'
const generated = generateSdl(
  { ontology: readFileSync(shard + 'ontology.ttl', 'utf-8'), shapes: readFileSync(shard + 'shapes.ttl', 'utf-8') },
  'perf',
  { datasetGraphs: ['urn:verax:shard:perf'] },
)
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}

const WORKLOADS: Array<[string, string, Record<string, unknown>]> = [
  ['single-entity + 2 levels', 'query { person(iri: "https://verax.example/corpus/core/data#person-10") { name worksFor { name } } }', {}],
  ['paginated list (20)', 'query { people(first: 20) { edges { node { name } } pageInfo { hasNextPage } } }', {}],
  ['3-level nested', 'query { people(first: 5) { edges { node { name authored { name } worksFor { name } } } } }', {}],
]

const BANDS: Record<string, { p50: number; p99: number }> = JSON.parse(
  readFileSync('corpus/PERF-BANDS.json', 'utf-8'),
) as never

const stats = (samples: number[]): { p50: number; p99: number } => {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { p50: at(0.5), p99: at(0.99) }
}

const fmt = (ms: number): string => `${ms.toFixed(1)}ms`

async function runAgainst(adapter: 'reference' | 'endpoint'): Promise<void> {
  console.error(`\n=== ${adapter === 'reference' ? 'reference adapter (in-memory)' : `sparql-http @ ${ENDPOINT}`} ===`)
  for (const [label, query, variables] of WORKLOADS) {
    const plan = compileDocument(query, module_)
    const samples: number[] = []
    let failure: string | undefined
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = performance.now()
      try {
        if (adapter === 'reference') {
          await reference.run(plan, module_, variables)
        } else {
          await endpointAdapter.run(plan, module_, variables)
        }
      } catch (err) {
        failure = (err as Error).message.split('\n')[0]!.slice(0, 120)
        break
      }
      samples.push(performance.now() - started)
    }
    if (failure !== undefined) {
      console.error(`${label.padEnd(28)} FAILED — ${failure}`)
      continue
    }
    const { p50, p99 } = stats(samples)
    const band = BANDS[label]!
    const verdictP50 = p50 <= band.p50 ? 'OK' : `OVER (band ${fmt(band.p50)})`
    const verdictP99 = p99 <= band.p99 ? 'OK' : `OVER (band ${fmt(band.p99)})`
    console.error(`${label.padEnd(28)} p50 ${fmt(p50).padStart(8)} ${verdictP50.padEnd(18)} p99 ${fmt(p99).padStart(8)} ${verdictP99}`)
  }
}

const reference = ReferenceAdapter.fromTurtle(readFileSync(join(SHARD, 'data.ttl'), 'utf-8'), module_.datasetGraphs)
const endpointAdapter = ENDPOINT
  ? new SparqlHttpAdapter({ endpoint: ENDPOINT, timeoutMs: 10_000 })
  : undefined

await runAgainst('reference')
if (endpointAdapter !== undefined) await runAgainst('endpoint')
void loadConfig

/**
 * L0 parity across STORES (docs/02 §5, docs/09): the conformance matrix.
 *
 * Every endpoint listed in CARTOQL_TEST_SPARQL_ENDPOINTS (comma-separated) runs
 * the gold-shard documents through the sparql-http adapter and deep-compares
 * against the reference adapter's semantics — same plan, same corpus, different
 * engine. Oxigraph and Jena Fuseki both validate sample-queries differently;
 * engine quirk surfacing is exactly what this suite exists to catch.
 *
 * Auth note: adapters include no credentials — test stores must serve anonymous
 * query access (both our fixtures do: Fuseki dataset is public-read).
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../../generator/src/index.js'
import { compileDocument } from '../../../core/src/compiler.js'
import { ReferenceAdapter } from '../../reference/src/index.js'
import { SparqlHttpAdapter } from './index.js'

const endpoints = (process.env['CARTOQL_TEST_SPARQL_ENDPOINTS'] ?? '')
  .split(',')
  .map((e) => e.trim())
  .filter((e) => e !== '')

const shardRoot = fileURLToPath(new URL('../../../../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shardRoot, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shardRoot, 'shapes.ttl'), 'utf-8')
const data = readFileSync(join(shardRoot, 'data.ttl'), 'utf-8')

const generated = generateSdl(
  { ontology, shapes },
  'corpus/shards/core',
  { datasetGraphs: ['urn:cartoql:shard:core'] },
)
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}
const reference = ReferenceAdapter.fromTurtle(data, module_.datasetGraphs)

const docNames = readdirSync(join(shardRoot, 'documents'))
  .filter((f) => f.endsWith('.graphql'))
  .sort()

describe.skipIf(endpoints.length === 0)('L0 parity across stores (docs/09 conformance matrix)', () => {
  const adapters: Array<[string, SparqlHttpAdapter]> = []

  beforeAll(async () => {
    for (const endpoint of endpoints) {
      const adapter = new SparqlHttpAdapter({ endpoint })
      // warm the transport probe per store (auto mode)
      await adapter.run(
        compileDocument('query { person(iri: "https://cartoql.example/corpus/core/data#person-ada") { name } }', module_),
        module_,
        { iri: 'https://cartoql.example/corpus/core/data#person-ada' },
      )
      adapters.push([endpoint, adapter])
    }
  })

  it.each(docNames)('%s: response-equivalent through EVERY store', async (doc) => {
    const source = readFileSync(join(shardRoot, 'documents', doc), 'utf-8')
    const variables = JSON.parse(
      readFileSync(join(shardRoot, 'documents', doc.replace(/\.graphql$/, '.vars.json')), 'utf-8'),
    )
    const plan = compileDocument(source, module_)
    const expected = await reference.run(plan, module_, variables)
    for (const [endpoint, adapter] of adapters) {
      const actual = await adapter.run(plan, module_, variables)
      expect(actual.errors, `${doc} @ ${endpoint} errors`).toEqual(expected.errors)
      expect(actual.data, `${doc} @ ${endpoint} data`).toEqual(expected.data)
    }
  })
})

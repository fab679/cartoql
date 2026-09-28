/** Cost-scaled fetch timeout (docs/08): a hung store hangs nothing. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../../generator/src/index.js'
import { compileDocument } from '../../../core/src/compiler.js'
import { ExecutorError } from '../../../core/src/executor.js'
import { SparqlHttpAdapter } from './index.js'

const shard = fileURLToPath(new URL('../../../../corpus/shards/core/', import.meta.url))
const generated = generateSdl(
  {
    ontology: readFileSync(join(shard, 'ontology.ttl'), 'utf-8'),
    shapes: readFileSync(join(shard, 'shapes.ttl'), 'utf-8'),
  },
  'corpus/shards/core',
  { datasetGraphs: ['urn:verax:shard:core'] },
)
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}

describe('sparql-http: request timeout', () => {
  it('aborts a hung endpoint at the budget and refuses partial answers', async () => {
    // a hung *real* endpoint never responds but DOES reject on abort — the mock
    // mirrors that (an abort-ignoring promise would be a lie about fetch)
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }) as Promise<Response> as unknown as typeof fetch
    const adapter = new SparqlHttpAdapter({
      endpoint: 'http://hang.test/sparql',
      timeoutMs: 30,
      fetcher: hang,
    })
    const plan = compileDocument(
      readFileSync(join(shard, 'documents/person-detail.graphql'), 'utf-8'),
      module_,
    )
    await expect(adapter.run(plan, module_, { iri: 'https://verax.example/corpus/core/data#person-ada' })).rejects.toThrow(
      /exceeded its 30ms budget/,
    )
  })

  it('network failures report as executor errors, distinct from timeouts', async () => {
    const adapter = new SparqlHttpAdapter({
      endpoint: 'http://unreachable.test/sparql',
      timeoutMs: 1_000,
      fetcher: async () => {
        throw new Error('ECONNREFUSED (simulated)')
      },
    })
    const plan = compileDocument(
      readFileSync(join(shard, 'documents/person-detail.graphql'), 'utf-8'),
      module_,
    )
    await expect(adapter.run(plan, module_, { iri: 'https://x.example/p1' })).rejects.toThrow(ExecutorError)
  })
})

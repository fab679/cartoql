import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../../generator/src/index.js'
import { canonicalJson } from '../../../core/src/ir.js'
import { compileDocument } from '../../../core/src/compiler.js'
import {
  encodeCursor,
  ExecutorError,
  ORDER_BY_IRI,
  graphScopeHash,
  type ResponseData,
} from '../../../core/src/executor.js'
import { ReferenceAdapter } from './index.js'

const shardRoot = fileURLToPath(new URL('../../../../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shardRoot, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shardRoot, 'shapes.ttl'), 'utf-8')
const data = readFileSync(join(shardRoot, 'data.ttl'), 'utf-8')

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/core', {
  datasetGraphs: ['urn:verax:shard:core'],
})
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}
const adapter = ReferenceAdapter.fromTurtle(data, module_.datasetGraphs)

const docNames = readdirSync(join(shardRoot, 'documents')).filter((f) => f.endsWith('.graphql')).sort()

async function runDoc(name: string, variables: Record<string, string | number> = {}): Promise<ResponseData> {
  const source = readFileSync(join(shardRoot, 'documents', name), 'utf-8')
  return adapter.run(compileDocument(source, module_), module_, variables)
}

describe('reference adapter: gold-shard response snapshots (docs/09)', () => {
  it.each(docNames)('%s matches the reviewed response snapshot', async (name) => {
    const variables = JSON.parse(readFileSync(join(shardRoot, 'documents', name.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
    const response = await runDoc(name, variables)
    const expected = readFileSync(join(shardRoot, 'expected/responses', name.replace(/\.graphql$/, '.json')), 'utf-8')
    expect(canonicalJson({ variables, response })).toBe(expected.trim())
  })
})

describe('reference adapter: pagination contract (docs/06 D2/D6)', () => {
  const pageQuery = 'query Page($first: Int, $after: String) { people(first: $first, after: $after) { edges { node { name } cursor } pageInfo { hasNextPage endCursor } } }'

  it('pages through in canonical IRI order with disjoint windows', async () => {
    const seen: string[] = []
    let after: string | null = null
    let hasNext = true
    while (hasNext) {
      const res = (await adapter.run(compileDocument(pageQuery, module_), module_, { first: 2, after })) as ResponseData
      const conn = (res.data['people'] as { edges: Array<{ node: { name: string }; cursor: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } })
      conn.edges.forEach((e) => seen.push(e.node.name))
      hasNext = conn.pageInfo.hasNextPage
      after = conn.pageInfo.endCursor
    }
    expect(seen).toEqual(['Ada Ionescu', 'Brin Okafor', 'Cleo Marchetti', 'Dov Lindqvist', 'Emi Sato'])
  })

  it('rejects cursors minted against a different graph scope', async () => {
    const foreign = encodeCursor({
      orderByKey: ORDER_BY_IRI,
      lastValue: 'https://verax.example/x#p',
      lastIRI: 'https://verax.example/x#p',
      graphHash: graphScopeHash(['urn:verax:some-other-graph']),
    })
    await expect(
      adapter.run(compileDocument(pageQuery, module_), module_, { first: 2, after: foreign }),
    ).rejects.toThrow(/different graph scope/)
  })
})

describe('reference adapter: runtime honesty', () => {
  it('absent entities resolve null with zero error entries (absence and invisibility share a shape)', async () => {
    const res = await runDoc('person-detail.graphql', { iri: 'https://verax.example/corpus/core/data#does-not-exist' })
    expect(res.data['person']).toBeNull()
    expect(res.errors).toHaveLength(0)
  })

  it('fails loud on missing variables — never executes on a guess', async () => {
    await expect(runDoc('person-detail.graphql', {})).rejects.toThrow(ExecutorError)
  })

  it('fails loud on malformed cursors', async () => {
    const pageQuery = 'query Page($after: String) { people(after: $after) { edges { node { name } cursor } pageInfo { hasNextPage endCursor } } }'
    await expect(
      adapter.run(compileDocument(pageQuery, module_), module_, { after: '%%%-not-base64-*' }),
    ).rejects.toThrow(/malformed cursor/)
  })

  it('fails loud when the plan graph scope does not match the adapter scope (D10)', async () => {
    const foreignAdapter = ReferenceAdapter.fromTurtle(data, ['urn:verax:shard:other'])
    await expect(foreignAdapter.run(compileDocument(readFileSync(join(shardRoot, 'documents/person-detail.graphql'), 'utf-8'), module_), module_, { iri: 'https://verax.example/corpus/core/data#person-ada' })).rejects.toThrow(/graph scope/)
  })
})

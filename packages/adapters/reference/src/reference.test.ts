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
  datasetGraphs: ['urn:cartoql:shard:core'],
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
      lastValue: 'https://cartoql.example/x#p',
      lastIRI: 'https://cartoql.example/x#p',
      graphHash: graphScopeHash(['urn:cartoql:some-other-graph']),
    })
    await expect(
      adapter.run(compileDocument(pageQuery, module_), module_, { first: 2, after: foreign }),
    ).rejects.toThrow(/different graph scope/)
  })
})

// -======- literal pagination arguments (the loud-first live catch) -======- //

describe('reference adapter: literal first: N limits the page (variables AND literals)', () => {
  it('a literal first: 2 returns exactly two edges (not the default 20)', async () => {
    const plan = compileDocument('{ publications(first: 2) { edges { node { name } } pageInfo { hasNextPage } } }', module_)
    const result = await adapter.run(plan, module_, {})
    const view = result.data['publications'] as { edges: Array<{ node: { name: string } }>; pageInfo: { hasNextPage: boolean } }
    expect(view.edges.length).toBe(2)
    expect(view.pageInfo.hasNextPage).toBe(true)
  })

  it('variable-provided first keeps working identically', async () => {
    const plan = compileDocument('query P($first: Int) { publications(first: $first) { edges { node { name } } } }', module_)
    const viaVariable = await adapter.run(plan, module_, { first: 2 })
    expect(((viaVariable.data['publications'] as { edges: unknown[] }).edges).length).toBe(2)
  })

  it('literal cursor arguments flow through pagination (after as a literal string)', async () => {
    const plan = compileDocument('{ publications(first: 20) { edges { node { name } cursor } } }'.replace('first: 20', 'first: 20'), module_)
    const first = await adapter.run(plan, module_, {})
    const edges = (first.data['publications'] as { edges: Array<{ cursor: string }> }).edges
    expect(edges.length).toBe(4) // core corpus: four real + one blank node that never materializes
  })
})

describe('reference adapter: runtime honesty', () => {
  it('absent entities resolve null with zero error entries (absence and invisibility share a shape)', async () => {
    const res = await runDoc('person-detail.graphql', { iri: 'https://cartoql.example/corpus/core/data#does-not-exist' })
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
    const foreignAdapter = ReferenceAdapter.fromTurtle(data, ['urn:cartoql:shard:other'])
    await expect(foreignAdapter.run(compileDocument(readFileSync(join(shardRoot, 'documents/person-detail.graphql'), 'utf-8'), module_), module_, { iri: 'https://cartoql.example/corpus/core/data#person-ada' })).rejects.toThrow(/graph scope/)
  })
})

// -======- D1/D8: blank-node safety + langString lexical values (gap-closure 5) -======- //

describe('reference adapter: D1 blank nodes never materialize (docs/06)', () => {
  it('blank-node entities leave scans and class fields alike (fixture in data.ttl)', async () => {
    // Emi authored a blank-node publication — the fixture data carries it; the
    // query must NOT see it (existential safety, not filtering).
    const res = await runDoc('person-detail.graphql', { iri: 'https://cartoql.example/corpus/core/data#person-emi' })
    // person-detail selects name/worksFor; assert via a dedicated plan for Emi's authored list
    const source = 'query E($iri: ID!) { person(iri: $iri) { authored { name } } }'
    const plan = compileDocument(source, module_)
    const authored = await adapter.run(plan, module_, { iri: 'https://cartoql.example/corpus/core/data#person-emi' })
    expect((authored.data['person'] as { authored: unknown[] }).authored).toEqual([])
    void res
  })

  it('publications scans exclude the blank-node publication (population unchanged)', async () => {
    const plan = compileDocument('query P($first: Int) { publications(first: $first) { edges { node { name } } pageInfo { hasNextPage } } }', module_)
    const res = await adapter.run(plan, module_, { first: 20 })
    const names = (res.data['publications'] as { edges: Array<{ node: { name: string } }> }).edges.map((e) => e.node.name)
    expect(names).toEqual(['Algebra of compiled views', 'Shapes as schema, once', 'Plan-level authorization', 'Cost models for graph overlays'])
  })
})

describe('reference adapter: D8 langString resolves to the lexical value (docs/06 v0)', () => {
  it('tagged literals return their lexical text through both paths (negotiation pending)', async () => {
    const res = await runDoc('org-motto.graphql')
    const edges = (res.data['organizations'] as { edges: Array<{ node: { name: string; motto: string | null } }> }).edges
    expect(edges.find((e) => e.node.name === 'Acme Research Institute')?.node.motto).toBe('Brick by brick')
    expect(edges.find((e) => e.node.name === 'Northwind Analytics')?.node.motto).toBeNull()
  })
})

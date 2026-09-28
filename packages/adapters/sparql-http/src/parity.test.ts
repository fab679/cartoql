/**
 * L0 parity suite (docs/09): the SPARQL HTTP adapter must be response-equivalent
 * to the reference adapter over the gold shard — run when
 * CARTOQL_TEST_SPARQL_ENDPOINT points at a live SPARQL 1.1 endpoint that has the
 * shard loaded into named graph `urn:cartoql:shard:core`.
 *
 * Skipped with a visible log otherwise (CI has no store; the projection
 * snapshots and reference suite still run).
 *
 * Live-tested against Oxigraph 0.5.10 — which ignores SPARQL 1.1 Protocol
 * variable bindings, exercising the VALUES fallback transport end to end.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../../generator/src/index.js'
import { compileDocument } from '../../../core/src/compiler.js'
import { ReferenceAdapter } from '../../reference/src/index.js'
import { probeProtocolBinding, SparqlHttpAdapter } from './index.js'

const endpoint = process.env['CARTOQL_TEST_SPARQL_ENDPOINT']

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
const reference = ReferenceAdapter.fromTurtle(data, module_.datasetGraphs)

const docNames = readdirScan(join(shardRoot, 'documents'))
function readdirScan(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.graphql')).sort()
}

const suite = describe.skipIf(!endpoint)('L0 parity: sparql-http vs reference (live Oxigraph)', () => {
  let adapter: SparqlHttpAdapter

  beforeAll(async () => {
    adapter = new SparqlHttpAdapter({ endpoint: endpoint! })
  })

  it.each(docNames)('%s: response-equivalent to the reference adapter', async (name) => {
    const source = readFileSync(join(shardRoot, 'documents', name), 'utf-8')
    const variables = JSON.parse(readFileSync(join(shardRoot, 'documents', name.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
    const plan = compileDocument(source, module_)
    const expected = await reference.run(plan, module_, variables)
    const actual = await adapter.run(plan, module_, variables)
    expect(actual.data).toEqual(expected.data) // deep response-equivalence, cursors included
  })

  it('page-through parity: identical entity sequence and pageInfo transitions', async () => {
    const pageQuery = 'query Page($first: Int, $after: String) { people(first: $first, after: $after) { edges { node { name } cursor } pageInfo { hasNextPage endCursor } } }'
    const paginate = async (adapter: { run: (plan: ReturnType<typeof compileDocument>, m: typeof module_, v: Record<string, string | number | null>) => Promise<{ data: Record<string, unknown> }> }) => {
      const names: string[] = []
      let after: string | null = null
      let hasNext = true
      while (hasNext) {
        const res = await adapter.run(compileDocument(pageQuery, module_), module_, { first: 2, after })
        const conn = res.data['people'] as { edges: Array<{ node: { name: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
        names.push(...conn.edges.map((e) => e.node.name))
        hasNext = conn.pageInfo.hasNextPage
        after = conn.pageInfo.endCursor
      }
      return names
    }
    expect(await paginate(adapter)).toEqual(await paginate(reference))
    expect(await paginate(adapter)).toEqual(['Ada Ionescu', 'Brin Okafor', 'Cleo Marchetti', 'Dov Lindqvist', 'Emi Sato'])
  })

  it('absent entity: null, zero errors — same shape as reference', async () => {
    const source = readFileSync(join(shardRoot, 'documents/person-detail.graphql'), 'utf-8')
    const plan = compileDocument(source, module_)
    const actual = await adapter.run(plan, module_, { iri: 'https://cartoql.example/corpus/core/data#nope' })
    const expected = await reference.run(plan, module_, { iri: 'https://cartoql.example/corpus/core/data#nope' })
    expect(actual.data['person']).toBeNull()
    expect(actual.data).toEqual(expected.data)
  })
})

runWhen(endpoint, async () => {
  // capability log — visible in test output, documents which transport ran
  const honors = await probeProtocolBinding(endpoint!)
  if (!honors) {
    console.log(`[parity] endpoint ignores SPARQL protocol variable bindings — VALUES fallback transport exercised`)
  }
})

function runWhen(cond: string | undefined, fn: () => unknown): void {
  if (cond) void fn()
}
void suite

// -======- Security parity: constraint pushdown vs reference, live -======- //
// The sec shard must respond identically through BOTH enforcement paths:
// reference (view-evaluated) and sparql-http (ACL-graph joins in-store) —
// including error entries, which are view-derived on both sides.

const secShard = fileURLToPath(new URL('../../../../corpus/shards/sec/', import.meta.url))
const secOntology = readFileSync(join(secShard, 'ontology.ttl'), 'utf-8')
const secShapes = readFileSync(join(secShard, 'shapes.ttl'), 'utf-8')
const secData = readFileSync(join(secShard, 'data.ttl'), 'utf-8')
const secStamps = JSON.parse(readFileSync(join(secShard, 'stamps.json'), 'utf-8'))

const secGenerated = generateSdl(
  { ontology: secOntology, shapes: secShapes },
  'corpus/shards/sec',
  { datasetGraphs: ['urn:cartoql:shard:sec'], stamps: secStamps },
)
const secModule = {
  moduleId: secGenerated.moduleId,
  schemaHash: secGenerated.schemaHash,
  schema: buildSchema(secGenerated.sdl),
  semanticMap: secGenerated.semanticMap,
  datasetGraphs: secGenerated.datasetGraphs,
  aclGraph: 'urn:cartoql:shard:sec-acl',
}
const secReference = ReferenceAdapter.fromTurtle(secData, secModule.datasetGraphs)

const secCtx = (principalId: string, groups: readonly string[]) => ({
  principalId,
  view: { groups: new Set(groups), viewVersion: 'static-1' },
})
const SEC_PRINCIPALS = [
  ['alice', ['hr-comp', 'legal']],
  ['bob', []],
  ['stranger', []],
] as const

describe.skipIf(!endpoint)('L0 security parity: constraint pushdown vs reference (live Oxigraph)', () => {
  let secAdapter: SparqlHttpAdapter
  beforeAll(async () => {
    secAdapter = new SparqlHttpAdapter({ endpoint: endpoint! })
  })

  const secDocs = readdirSync(join(secShard, 'documents')).filter((f) => f.endsWith('.graphql')).sort()

  it.each(secDocs)('%s: field/entity gating identical through both enforcement paths', async (doc) => {
    const source = readFileSync(join(secShard, 'documents', doc), 'utf-8')
    const variables = JSON.parse(readFileSync(join(secShard, 'documents', doc.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
    const plan = compileDocument(source, secModule)
    for (const [principalId, groups] of SEC_PRINCIPALS) {
      const ctx = secCtx(principalId, groups)
      const throughStore = await secAdapter.run(plan, secModule, variables, ctx)
      const throughKernel = await secReference.run(plan, secModule, variables, ctx)
      // errors TOO — the visible track must match, not just data
      expect(throughStore.errors, `${doc}/${principalId} errors`).toEqual(throughKernel.errors)
      expect(throughStore.data, `${doc}/${principalId} data`).toEqual(throughKernel.data)
    }
  })

  it('gated entities are existence-blind THROUGH the store: windows never include them', async () => {
    const source = readFileSync(join(secShard, 'documents/notes-scan.graphql'), 'utf-8')
    const plan = compileDocument(source, secModule)
    const ctx = secCtx('bob', [])
    const result = await secAdapter.run(plan, secModule, {}, ctx)
    const conn = result.data['sensitiveNotes'] as { edges: unknown[]; pageInfo: { hasNextPage: boolean } }
    expect(conn.edges).toEqual([])
    expect(conn.pageInfo.hasNextPage).toBe(false)
    // and no error entry anywhere — invisibility, not denial
    expect(result.errors).toEqual([])
  })
})


// -======- D4 parity: polymorphic resolution through BOTH enforcement paths -======- //

const typingShard = fileURLToPath(new URL('../../../../corpus/shards/typing/', import.meta.url))
const typingOntology = readFileSync(join(typingShard, 'ontology.ttl'), 'utf-8')
const typingShapes = readFileSync(join(typingShard, 'shapes.ttl'), 'utf-8')
const typingData = readFileSync(join(typingShard, 'data.ttl'), 'utf-8')

const typingGenerated = generateSdl(
  { ontology: typingOntology, shapes: typingShapes },
  'corpus/shards/typing',
  { datasetGraphs: ['urn:cartoql:shard:typing'] },
)
const typingModule = {
  moduleId: typingGenerated.moduleId,
  schemaHash: typingGenerated.schemaHash,
  schema: buildSchema(typingGenerated.sdl),
  semanticMap: typingGenerated.semanticMap,
  datasetGraphs: typingGenerated.datasetGraphs,
}
const typingReference = ReferenceAdapter.fromTurtle(typingData, typingModule.datasetGraphs)

describe.skipIf(!endpoint)('L0 D4 parity: polymorphic entities through both paths (live Oxigraph)', () => {
  let typingAdapter: SparqlHttpAdapter
  beforeAll(async () => {
    typingAdapter = new SparqlHttpAdapter({ endpoint: endpoint! })
  })

  const typingDocs = readdirScan(join(typingShard, 'documents'))

  it.each(typingDocs)('%s: interface resolution identical in-store vs in-kernel', async (doc) => {
    const source = readFileSync(join(typingShard, 'documents', doc), 'utf-8')
    const variables = JSON.parse(readFileSync(join(typingShard, 'documents', doc.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
    const plan = compileDocument(source, typingModule)
    const throughStore = await typingAdapter.run(plan, typingModule, variables)
    const throughKernel = await typingReference.run(plan, typingModule, variables)
    expect(throughStore.errors).toEqual(throughKernel.errors)
    expect(throughStore.data).toEqual(throughKernel.data) // __typename + conditioned fields included
  })
})

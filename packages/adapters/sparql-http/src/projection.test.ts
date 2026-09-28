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
  graphScopeHash,
  ORDER_BY_IRI,
  ExecutorError,
} from '../../../core/src/executor.js'
import { MAX_PAGE, projectRoot } from './index.js'

const shardRoot = fileURLToPath(new URL('../../../../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shardRoot, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shardRoot, 'shapes.ttl'), 'utf-8')

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

const docNames = readdirScan(join(shardRoot, 'documents'))
function readdirScan(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.graphql')).sort()
}

function projectDoc(name: string, variables: Record<string, string | number> = {}) {
  const source = readFileSync(join(shardRoot, 'documents', name), 'utf-8')
  const plan = compileDocument(source, module_)
  return plan.roots.map((root, i) => {
    if (root.kind !== 'EntityLookup') throw new Error('unexpected root kind')
    return projectRoot(root, i, variables)
  })
}

describe('sparql-http projection: gold-shard snapshots (docs/09)', () => {
  it.each(docNames)('%s matches the reviewed .rq + .bind.json snapshots', (name) => {
    const requests = projectDoc(name, JSON.parse(readFileSync(join(shardRoot, 'documents', name.replace(/\.graphql$/, '.vars.json')), 'utf-8')))
    const base = name.replace(/\.graphql$/, '')
    expect(requests.map((r) => r.query).join('\n')).toBe(readFileSync(join(shardRoot, 'expected/sparql', `${base}.rq`), 'utf-8').trimEnd() + '\n')
    expect(canonicalJson(requests.map((r) => r.bindings))).toBe(readFileSync(join(shardRoot, 'expected/sparql', `${base}.bind.json`), 'utf-8').trim())
  })

  it('is deterministic — same inputs, byte-identical projection', () => {
    const vars = JSON.parse(readFileSync(join(shardRoot, 'documents/person-detail.vars.json'), 'utf-8'))
    expect(projectDoc('person-detail.graphql', vars)).toEqual(projectDoc('person-detail.graphql', vars))
  })
})

describe('sparql-http projection: D7/T1 injection purity', () => {
  it('query text carries no client values — they travel only in protocol bindings', () => {
    const vars = JSON.parse(readFileSync(join(shardRoot, 'documents/person-detail.vars.json'), 'utf-8'))
    const [request] = projectDoc('person-detail.graphql', vars)
    // the client's entity IRI must not appear anywhere in query text
    expect(request!.query).not.toContain('person-ada')
    // it must appear exactly once, as the term binding for the root variable
    expect(request!.bindings['v0_e']).toBe('<https://verax.example/corpus/core/data#person-ada>')
  })

  it('refuses IRIs that cannot be represented as absolute IRI terms', () => {
    expect(() => projectDoc('person-detail.graphql', { iri: 'https://x.example/a b' })).toThrow(ExecutorError)
    expect(() => projectDoc('person-detail.graphql', { iri: 'https://x.example/a"b' })).toThrow(ExecutorError)
  })
})

describe('sparql-http projection: D10/D6/D2 contract lines', () => {
  it('wraps every pattern tree in the explicit GRAPH scope', () => {
    for (const name of docNames) {
      const vars = JSON.parse(readFileSync(join(shardRoot, 'documents', name.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
      for (const request of projectDoc(name, vars)) {
        expect(request!.query, name).toContain('GRAPH <urn:verax:shard:core>')
      }
    }
  })

  it('emits the inverse-path arrow for inverse fields', () => {
    const [request] = projectDoc('publication-authors.graphql', { iri: 'https://verax.example/corpus/core/data#pub-b1' })
    expect(request!.query).toContain('^<https://verax.example/corpus/core#authored>')
  })

  it('LIMIT is first+1 (hasNextPage in the same round trip), validated and clamped', () => {
    expect(projectDoc('people-page.graphql', { first: 2 })[0]!.query).toMatch(/LIMIT 3/)
    expect(projectDoc('people-page.graphql', { first: 0 })[0]!.query).toMatch(/LIMIT 1/)
    expect(projectDoc('people-page.graphql', { first: MAX_PAGE })[0]!.query).toMatch(new RegExp(`LIMIT ${MAX_PAGE + 1}`))
    expect(() => projectDoc('people-page.graphql', { first: -1 })[0]).toThrow(ExecutorError)
    expect(() => projectDoc('people-page.graphql', { first: MAX_PAGE + 1 })[0]).toThrow(ExecutorError)
    expect(() => projectDoc('people-page.graphql', { first: 2.5 })[0]).toThrow(ExecutorError)
  })

  it('after-cursors become a protocol-bound FILTER, foreign-scope cursors refused', () => {
    const cursor = encodeCursor({
      orderByKey: ORDER_BY_IRI,
      lastValue: 'https://verax.example/corpus/core/data#person-brin',
      lastIRI: 'https://verax.example/corpus/core/data#person-brin',
      graphHash: graphScopeHash(['urn:verax:shard:core']),
    })
    // the reference document doesn't forward `after`; compile a page query that does
    const pageQuery = 'query Page($first: Int, $after: String) { people(first: $first, after: $after) { edges { node { name } cursor } pageInfo { hasNextPage endCursor } } }'
    const plan = compileDocument(pageQuery, module_)
    const [request] = plan.roots.map((root, i) => {
      if (root.kind !== 'EntityLookup') throw new Error('unexpected root kind')
      return projectRoot(root, i, { first: 2, after: cursor })
    })
    expect(request!.query).toContain('FILTER(?v0_e > $v0_e_after)')
    expect(request!.bindings['v0_e_after']).toBe('<https://verax.example/corpus/core/data#person-brin>')

    const foreignCursor = encodeCursor({
      orderByKey: ORDER_BY_IRI,
      lastValue: 'x', lastIRI: 'x',
      graphHash: graphScopeHash(['urn:verax:some-other-graph']),
    })
    const foreignPlan = compileDocument(pageQuery, module_)
    expect(() => foreignPlan.roots.map((root, i) => {
      if (root.kind !== 'EntityLookup') throw new Error('unexpected root kind')
      return projectRoot(root, i, { first: 2, after: foreignCursor })
    })[0]).toThrow(/different graph scope/)
  })
})

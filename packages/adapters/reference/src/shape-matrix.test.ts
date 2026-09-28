/**
 * The SHAPE MATRIX: the literal-first bug class — the same concept arriving in
 * multiple shapes (literal | variable | absent; ASC | DESC; aliased |
 * un-aliased) with only one shape ever exercised — caused a silent page-size
 * bug. This suite asserts the WHOLE grid against the contract rows of docs/06
 * so a future asymmetry can't survive one CI run.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../../generator/src/index.js'
import { encodeCursor, ORDER_BY_IRI } from '../../../core/src/executor.js'
import { graphScopeHash } from '../../../core/src/executor.js'
import { compileDocument } from '../../../core/src/compiler.js'
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

async function ask(document: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const plan = compileDocument(document, module_)
  const response = await adapter.run(plan, module_, variables)
  return response.data as unknown as Record<string, unknown>
}

const namesFrom = (data: unknown): string[] => {
  const container = data as Record<string, { edges: Array<{ node: { name: string } }> }>
  const connection = Object.values(container)[0]!
  return connection.edges.map((e) => e.node.name)
}

describe('shape matrix: pagination first × {literal, variable, absent, null}', () => {
  it('literal first: 1 → 1 edge', async () => {
    const d = await ask('{ publications(first: 1) { edges { node { name } } } }')
    expect(namesFrom(d)).toEqual(['Algebra of compiled views'])
  })

  it('literal first: 2 → 2 edges (the reported bug regression)', async () => {
    const d = await ask('{ publications(first: 2) { edges { node { name } } } }')
    const names = namesFrom(d)
    expect(names.length).toBe(2)
    expect(names.length).not.toBe(4)
  })
  it('literal first: 0 → empty page, hasNextPage true (population exists past the window)', async () => {
    const d = await ask('{ publications(first: 0) { edges { node { name } } pageInfo { hasNextPage endCursor } } }')
    expect(namesFrom(d)).toEqual([])
    const c = Object.values(d)[0] as { pageInfo: { hasNextPage: boolean; endCursor: string | null } }
    expect(c.pageInfo.hasNextPage).toBe(true)
    expect(c.pageInfo.endCursor).toBeNull()
  })

  it('VARIABLE first: 3 → 3 edges (the always-tested shape — kept in the grid)', async () => {
    const d = await ask('query P($first: Int) { publications(first: $first) { edges { node { name } } } }', { first: 3 })
    expect(namesFrom(d).length).toBe(3)
  })

  it('absent first → default 20 (whole core population fits → 4 real publications)', async () => {
    const d = await ask('{ publications { edges { node { name } } } }')
    expect(namesFrom(d).length).toBe(4)
  })

  it('variable provided as null → same as absent (default)', async () => {
    const d = await ask('query P($first: Int) { publications(first: $first) { edges { node { name } } } }', { first: null })
    expect(namesFrom(d).length).toBe(4)
  })

  it('out-of-band literals refuse identically: -1, 501, 2.5', async () => {
    for (const bad of ['{ publications(first: -1) { edges { node { name } } } }',
                        '{ publications(first: 501) { edges { node { name } } } }',
                        '{ publications(first: 2.5) { edges { node { name } } } }']) {
      await expect(ask(bad)).rejects.toThrow(/first must be/)
    }
  })

  it('exact-fit window: first equals population → hasNextPage false', async () => {
    const d = await ask('{ organizations(first: 2) { edges { node { name } } pageInfo { hasNextPage } } }')
    const c = Object.values(d)[0] as { pageInfo: { hasNextPage: boolean } }
    expect(c.pageInfo.hasNextPage).toBe(false)
  })
})

describe('shape matrix: cursors × {literal, variable, garbage, foreign}', () => {
  it('literal + variable after-cursors page identically', async () => {
    const d1 = await ask('{ publications(first: 2) { edges { node { name } } pageInfo { endCursor } } }')
    const cursor = (Object.values(d1)[0] as { pageInfo: { endCursor: string } }).pageInfo.endCursor
    const literalNext = await ask(`{ publications(first: 2, after: "${cursor}") { edges { node { name } } } }`)
    const viaVariable = await ask('query P($after: String) { publications(first: 2, after: $after) { edges { node { name } } } }', { after: cursor })
    const names1 = namesFrom(literalNext)
    expect(names1.length).toBe(2)
    expect(names1).toEqual(namesFrom(viaVariable)) // shapes agree EXACTLY
    expect(names1[0]).not.toBe('Algebra of compiled views') // disjoint window
  })

  it('garbage cursors refuse identically in both shapes', async () => {
    await expect(ask('{ publications(first: 2, after: "garbage") { edges { node { name } } } }')).rejects.toThrow(/malformed cursor|^fetch failed$/)
  })
})

describe('shape matrix: orderBy × {literal ASC, literal DESC, absent} × shapes of pair-cursors', () => {
  it('literal NAME_ASC and NAME_DESC return reversed pages', async () => {
    const up = namesFrom(await ask('{ people(first: 2, orderBy: NAME_ASC) { edges { node { name } } } }'))
    const down = namesFrom(await ask('{ people(first: 2, orderBy: NAME_DESC) { edges { node { name } } } }'))
    expect(up).toEqual(['Ada Ionescu', 'Brin Okafor'])
    expect(down).toEqual(['Emi Sato', 'Dov Lindqvist'])
  })

  it('literal + variable orderBy page 2 agree exactly (pair-resume under ordering)', async () => {
    const page1 = await ask('{ publications(first: 2, orderBy: YEAR_DESC) { edges { node { year } } pageInfo { endCursor } } }')
    const cursor = (Object.values(page1)[0] as { pageInfo: { endCursor: string } }).pageInfo.endCursor
    const literal = namesFrom(await ask(`{ publications(first: 2, orderBy: YEAR_DESC, after: "${cursor}") { edges { node { name } } } }`))
    const viaVariable = namesFrom(await ask('query P($after: String) { publications(first: 2, orderBy: YEAR_DESC, after: $after) { edges { node { name } } } }', { after: cursor }))
    expect(literal).toEqual(viaVariable)
    expect(literal).not.toContain('Plan-level authorization')
  })

  it('absent orderBy → canonical IRI ascending (NAME order ≠ default)', async () => {
    const dflt = namesFrom(await ask('{ people(first: 5) { edges { node { name } } } }'))
    const iriSorted = ['Ada Ionescu', 'Brin Okafor', 'Cleo Marchetti', 'Dov Lindqvist', 'Emi Sato']
    expect(dflt).toEqual(iriSorted)
  })
})

describe('shape matrix: root aliases × {scan, single} × {aliased, un-aliased}', () => {
  it('aliased SCAN research key is the alias (not the field name) — the found bug, pinned', async () => {
    const d = await ask('{ p: people(first: 1) { edges { node { name } } } }')
    expect(Object.keys(d)).toEqual(['p']) // THE contract: data lives under the alias
    expect(namesFrom(d)).toEqual(['Ada Ionescu'])
  })

  it('aliased SINGLE same rule', async () => {
    const d = await ask('{ ada: person(iri: "https://cartoql.example/corpus/core/data#person-ada") { name } }')
    expect(Object.keys(d)).toEqual(['ada'])
  })

  it('UN-aliased roots unchanged', async () => {
    const d = await ask('{ people(first: 1) { edges { node { name } } } }')
    expect(Object.keys(d)).toEqual(['people'])
  })

  it('the SAME root twice under different aliases returns both, isomorphically', async () => {
    const d = await ask('{ a: people(first: 1) { edges { node { name } } } b: people(first: 1) { edges { node { name } } } }')
    expect(Object.keys(d).sort()).toEqual(['a', 'b'])
    expect(namesFrom({ x: d.a })).toEqual(namesFrom({ x: d.b }))
  })
})

describe('shape matrix: constellation checks from the original probe batch', () => {
  it('wrong-type IRI lookup: null + zero errors (existence-blind)', async () => {
    const d = await ask('{ organization(iri: "https://cartoql.example/corpus/core/data#person-ada") { iri name } }')
    expect((d as Record<string, unknown>).organization).toBeNull()
  })

  it('iri survives two levels of nesting', async () => {
    const d = await ask('{ person(iri: "https://cartoql.example/corpus/core/data#person-ada") { worksFor { iri name } } }')
    const persona = (d as { person: { worksFor: { iri: string } } }).person
    expect(persona.worksFor.iri).toBe('https://cartoql.example/corpus/core/data#org-acme')
  })

  it('literals and variables for the LOOKUP IRI behave identically', async () => {
    const literal = await ask('{ person(iri: "https://cartoql.example/corpus/core/data#person-ada") { name } }')
    const viaVariable = await ask('query P($iri: ID!) { person(iri: $iri) { name } }', { iri: 'https://cartoql.example/corpus/core/data#person-ada' })
    expect(literal).toEqual(viaVariable)
  })

  it('literal + variable FILTERS agree exactly', async () => {
    const literal = namesFrom(await ask('{ organizations(name: "Acme Research Institute", first: 5) { edges { node { name } } } }'))
    const viaVariable = namesFrom(await ask('query F($name: String) { organizations(name: $name, first: 5) { edges { node { name } } } }', { name: 'Acme Research Institute' }))
    expect(literal).toEqual(viaVariable).toEqual(['Acme Research Institute'])
  })

  it('known gap, pinned as LOUD: variable orderBy refuses (not silently mis-orders)', async () => {
    expect(() => compileDocument('query O($o: PublicationOrderBy) { publications(first: 2, orderBy: $o) { edges { node { name } } } }', module_)).toThrow(/orderBy must be a enum member/)
  })
})

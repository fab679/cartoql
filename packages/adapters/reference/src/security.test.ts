/**
 * Security corpus suite (M2 slice 1): pins the reviewed two-track evidence in
 * corpus/shards/sec and asserts the semantics the snapshots themselves can't —
 * the indistinguishability properties (docs/03 rule 3, docs/09 leak-probe
 * discipline: every probe is a *pair*, never a single-sided expectation).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../../generator/src/index.js'
import { canonicalJson } from '../../../core/src/ir.js'
import { compileDocument } from '../../../core/src/compiler.js'
import type { SecurityContext } from '../../../core/src/executor.js'
import { ReferenceAdapter } from './index.js'

const shard = fileURLToPath(new URL('../../../../corpus/shards/sec/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')
const data = readFileSync(join(shard, 'data.ttl'), 'utf-8')
const stamps = JSON.parse(readFileSync(join(shard, 'stamps.json'), 'utf-8'))

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/sec', {
  datasetGraphs: ['urn:verax:shard:sec'],
  stamps,
})
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}
const adapter = ReferenceAdapter.fromTurtle(data, module_.datasetGraphs)

const context = (principalId: string, groups: readonly string[]): SecurityContext => ({
  principalId,
  view: { groups: new Set(groups), viewVersion: 'static-1' },
})
const ALICE = () => context('alice', ['hr-comp', 'legal'])
const BOB = () => context('bob', [])

async function run(doc: string, security: SecurityContext) {
  const source = readFileSync(join(shard, 'documents', doc), 'utf-8')
  const variables = JSON.parse(readFileSync(join(shard, 'documents', doc.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
  const plan = compileDocument(source, module_)
  return adapter.run(plan, module_, variables, security)
}

describe('security corpus: reviewed snapshots (docs/09)', () => {
  it('field denial is visible: null plus a typed error per selected denied field', async () => {
    const response = await run('orgs.graphql', BOB())
    const edges = (response.data['organizations'] as { edges: Array<{ node: { name: string; salaryBudget: string | null } }> }).edges
    expect(edges.map((e) => e.node.salaryBudget)).toEqual([null, null, null]) // denial, not absence of data
    expect(response.errors).toEqual([
      {
        message: 'field Organization.salaryBudget requires authorization the principal does not hold',
        path: 'Organization.salaryBudget',
        extensions: { code: 'VX_PERMISSION_DENIED' },
      },
      expect.objectContaining({ path: 'Organization.salaryBudget' }),
      expect.objectContaining({ path: 'Organization.salaryBudget' }),
    ])
    // the entity field denial never expanded to: orgs names still visible
    expect(edges.map((e) => e.node.name)).toEqual(['Alpha GmbH', 'Beta AB', 'Gamma SA'])
  })

  it('field grant resolves normally: alice sees budgets, no errors', async () => {
    const response = await run('orgs.graphql', ALICE())
    const edges = (response.data['organizations'] as { edges: Array<{ node: { salaryBudget: string | null } }> }).edges
    expect(edges.map((e) => e.node.salaryBudget)).toEqual(['1200000', null, '555000'])
    expect(response.errors).toEqual([])
  })
})

describe('security corpus: entity gating is existence-blind (docs/03 rule 3)', () => {
  it('a gated single lookup is indistinguishable from absence — null, zero errors', async () => {
    const gated = await run('note-lookup.graphql', BOB())
    const absent = await adapter.run(
      compileDocument(readFileSync(join(shard, 'documents/note-lookup.graphql'), 'utf-8'), module_),
      module_,
      { iri: 'https://verax.example/corpus/sec/data#does-not-exist' },
      BOB(),
    )
    expect(gated.data['sensitiveNote']).toBeNull()
    expect(gated.errors).toEqual([])
    expect(gated.data).toEqual(absent.data)
    expect(gated.errors).toEqual(absent.errors) // THE pair assertion: invisible ≡ absent
  })

  it('a gated scan is indistinguishable from an empty population', async () => {
    const response = await run('notes-scan.graphql', BOB())
    const conn = response.data['sensitiveNotes'] as { edges: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
    expect(conn.edges).toEqual([])
    expect(conn.pageInfo.hasNextPage).toBe(false)
    expect(conn.pageInfo.endCursor).toBeNull()
    expect(response.errors).toEqual([])
  })

  it('granted principals see the gated population normally', async () => {
    const response = await run('notes-scan.graphql', ALICE())
    const conn = response.data['sensitiveNotes'] as { edges: Array<{ node: { name: string } }> }
    expect(conn.edges.map((e) => e.node.name)).toEqual(['Alpha audit remark', 'Beta compliance check'])
    expect(response.errors).toEqual([])
  })

  it('fail-closed: unknown principals hold no groups and see only the public world', async () => {
    const response = await run('notes-scan.graphql', context('stranger', []))
    const conn = response.data['sensitiveNotes'] as { edges: unknown[] }
    expect(conn.edges).toEqual([])
  })
})

describe('security corpus: @traversalScope — the existence-blind edge track (docs/03)', () => {
  it('a denied traversal never materializes related entities AND reports no error, in the same response where field denials do report errors', async () => {
    const response = await run('org-notes.graphql', BOB())
    const edges = (response.data['organizations'] as { edges: Array<{ node: { name: string; noteOfInverse: unknown[] } }> }).edges
    // indistinguishable from organizations that simply have no notes
    expect(edges.map((e) => e.node.noteOfInverse)).toEqual([[], [], []])
    expect(response.errors).toEqual([])

    // and the contrast, one document family away: salaryBudget denial is VISIBLE
    const orgs = await run('orgs.graphql', BOB())
    expect(orgs.errors.map((e) => e.extensions.code)).toEqual(['VX_PERMISSION_DENIED', 'VX_PERMISSION_DENIED', 'VX_PERMISSION_DENIED'])
  })

  it('an allowed traversal expands normally — even without the related type\'s entity gate (v0: entity gating is root-level, documented)', async () => {
    const carol = await run('org-notes.graphql', createContext('carol', ['hr-comp']))
    const edges = (carol.data['organizations'] as { edges: Array<{ node: { name: string; noteOfInverse: Array<{ name: string }> } }> }).edges
    expect(edges.flatMap((e) => e.node.noteOfInverse.map((n) => n.name)).sort()).toEqual(['Alpha audit remark', 'Beta compliance check'])
    expect(carol.errors).toEqual([])
  })
})

function createContext(principalId: string, groups: readonly string[]): SecurityContext {
  return { principalId, view: { groups: new Set(groups), viewVersion: 'static-1' } }
}

describe('security corpus: snapshot discipline', () => {
  it('every response snapshot matches byte-for-byte after canonical serialization', async () => {
    const { readdirSync } = await import('node:fs')
    for (const file of readdirSync(join(shard, 'documents')).filter((f) => f.endsWith('.graphql')).sort()) {
      const base = file.replace(/\.graphql$/, '')
      for (const ctx of [ALICE(), BOB()]) {
        const response = await run(file, ctx)
        const expected = readFileSync(join(shard, 'expected/responses', `${base}::${ctx.principalId}.json`), 'utf-8')
        expect(canonicalJson({ principalId: ctx.principalId, viewVersion: 'static-1', variables: JSON.parse(readFileSync(join(shard, 'documents', `${base}.vars.json`), 'utf-8')), response })).toBe(expected.trim())
      }
    }
  })
})


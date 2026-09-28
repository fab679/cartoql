/**
 * Gateway security wiring (M2 slice 3): the two-track semantics over real HTTP,
 * per-request principals via header, resolver-driven views, health posture.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startGateway } from './serve.js'

const secShard = fileURLToPath(new URL('../../../corpus/shards/sec/', import.meta.url))
const ontologyFile = join(secShard, 'ontology.ttl')
const shapesFile = join(secShard, 'shapes.ttl')
const dataFile = join(secShard, 'data.ttl')

const authDir = mkdtempSync(join(tmpdir(), 'verax-auth-'))
const authFile = join(authDir, 'claims.json')
writeFileSync(authFile, JSON.stringify({ alice: ['hr-comp', 'legal'] }))

function boot(auth: boolean) {
  const gateway = startGateway({
    ontologyFile,
    shapesFile,
    dataFile,
    moduleId: 'corpus/shards/sec',
    graphFlag: 'urn:verax:shard:sec',
    stampsFile: join(secShard, 'stamps.json'),
    ...(auth ? { authFile } : {}),
  })
  gateway.server.listen(0)
  return { url: gateway.url, close: gateway.close }
}

async function gql(url: string, query: string, principalId?: string, variables?: Record<string, string>) {
  const response = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(principalId ? { 'x-verax-principal': principalId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })
  return { status: response.status, body: (await response.json()) as { data: Record<string, unknown>; errors: Array<{ extensions?: { code?: string } }> } }
}

const ORGS = `query { organizations(first: 10) { edges { node { name salaryBudget } } } }`
const NOTE = `query N($iri: ID!) { sensitiveNote(iri: $iri) { name noteOf { name } } }`

describe('gateway: per-request security over HTTP (docs/07: agents run as the human)', () => {
  const g = boot(true)

  it('field denial rides the standard GraphQL errors channel with VX_* codes', async () => {
    const alice = await gql(g.url, ORGS, 'alice')
    expect(alice.body.errors).toHaveLength(0)
    const edges = ((alice.body.data['organizations'] as { edges: Array<{ node: { salaryBudget: string | null } }> }).edges)
    expect(edges.map((e) => e.node.salaryBudget)).toEqual(['1200000', null, '555000'])

    const bob = await gql(g.url, ORGS, 'bob')
    expect(bob.status).toBe(200)
    const bobEdges = ((bob.body.data['organizations'] as { edges: Array<{ node: { salaryBudget: string | null } }> }).edges)
    expect(bobEdges.map((e) => e.node.salaryBudget)).toEqual([null, null, null])
    expect(bob.body.errors.map((e) => e.extensions?.code)).toEqual(['VX_PERMISSION_DENIED', 'VX_PERMISSION_DENIED', 'VX_PERMISSION_DENIED'])
  })

  it('entity gating is existence-blind over HTTP: null/empty, zero error entries', async () => {
    const bob = await gql(g.url, NOTE, 'bob', { iri: 'https://verax.example/corpus/sec/data#note-1' })
    expect(bob.body.data['sensitiveNote']).toBeNull()
    expect(bob.body.errors).toHaveLength(0)
    const alice = await gql(g.url, NOTE, 'alice', { iri: 'https://verax.example/corpus/sec/data#note-1' })
    expect(alice.body.data['sensitiveNote']).toMatchObject({ name: 'Alpha audit remark' })
  })

  it('unknown principals are fail-closed, not open', async () => {
    const stranger = await gql(g.url, NOTE, 'someone-never-provisioned', { iri: 'https://verax.example/corpus/sec/data#note-1' })
    expect(stranger.body.data['sensitiveNote']).toBeNull()
    expect(stranger.body.errors).toHaveLength(0)
  })

  it('health declares the auth posture (docs/10: no accidental discovery)', async () => {
    const health = await fetch(`${g.url}/health`)
    const body = (await health.json()) as Record<string, unknown>
    expect(body['auth']).toBe('static')
  })

  it('runs without --auth-file as the documented open posture (allowAll, health says so)', async () => {
    const open = boot(false)
    try {
      const anonymous = await gql(open.url, ORGS) // no principal header at all
      expect(anonymous.body.errors).toHaveLength(0)
      const edges = ((anonymous.body.data['organizations'] as { edges: Array<{ node: { salaryBudget: string | null } }> }).edges)
      expect(edges.map((e) => e.node.salaryBudget)).toEqual(['1200000', null, '555000'])
      const health = (await (await fetch(`${open.url}/health`)).json()) as Record<string, unknown>
      expect(health['auth']).toBe('open')
    } finally {
      await open.close()
    }
  })

  afterAll(async () => {
    await g.close()
  })
})

import { afterAll } from 'vitest'

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { startGateway } from './serve.js'

const shardRoot = fileURLToPath(new URL('../../../corpus/shards/core/', import.meta.url))
const ontologyFile = join(shardRoot, 'ontology.ttl')
const shapesFile = join(shardRoot, 'shapes.ttl')
const dataFile = join(shardRoot, 'data.ttl')

function boot() {
  const gateway = startGateway({ ontologyFile, shapesFile, dataFile, moduleId: 'corpus/shards/core' })
  gateway.server.listen(0)
  const url = gateway.url
  return {
    url,
    close: gateway.close,
  }
}

describe('gateway: serve (docs/04 Path 1 quickstart)', () => {
  it('answers a GraphQL POST end to end, matching the reviewed response snapshot', async () => {
    const g = boot()
    try {
      const query = readFileSync(join(shardRoot, 'documents/person-detail.graphql'), 'utf-8')
      const response = await fetch(`${g.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          variables: { iri: 'https://cartoql.example/corpus/core/data#person-ada' },
        }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: Record<string, unknown>; errors: unknown[] }
      expect(body.errors).toStrictEqual([])
      expect(body.data['person']).toEqual({
        name: 'Ada Ionescu',
        worksFor: { name: 'Acme Research Institute' },
      })
    } finally {
      await g.close()
    }
  })

  it('rejects schema-invalid documents at the gateway, 400 with errors', async () => {
    const g = boot()
    try {
      const response = await fetch(`${g.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { nonexistentRoot(iri: "x") { name } }' }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { errors: Array<{ message: string }> }
      expect(body.errors.length).toBeGreaterThan(0)
    } finally {
      await g.close()
    }
  })

  it('surfaces missing-variable failures as 400 with the error class name', async () => {
    const g = boot()
    try {
      const query = readFileSync(join(shardRoot, 'documents/person-detail.graphql'), 'utf-8')
      const response = await fetch(`${g.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: {} }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { errors: Array<{ extensions?: { name?: string } }> }
      expect(body.errors[0]?.extensions?.name).toBe('ExecutorError')
    } finally {
      await g.close()
    }
  })

  it('serves health and the playground', async () => {
    const g = boot()
    try {
      const health = await fetch(`${g.url}/health`)
      expect(health.status).toBe(200)
      const healthBody = (await health.json()) as Record<string, unknown>
      expect(healthBody['status']).toBe('ok')
      expect(String(healthBody['adapter'])).toContain('reference')

      const playground = await fetch(`${g.url}/playground`)
      expect(playground.status).toBe(200)
      expect((await playground.text()).toLowerCase()).toContain('playground')
    } finally {
      await g.close()
    }
  })
})

describe('gateway: budget gate (docs/08, threat T3) — rejection is typed, pre-execution', () => {
  it('over-budget documents get CQL_QUERY_TOO_COMPLEX with the offending metric and limit', async () => {
    const gateway = startGateway({ ontologyFile, shapesFile, dataFile, moduleId: 'corpus/shards/core', budgets: { maxCost: 1 } })
    gateway.server.listen(0)
    try {
      const response = await fetch(`${gateway.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { people(first: 5) { edges { node { name worksFor { name } } } } }' }),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { errors: Array<{ extensions?: { code?: string; metric?: string; limit?: number } }> }
      expect(body.errors[0]?.extensions?.code).toBe('CQL_QUERY_TOO_COMPLEX')
      expect(body.errors[0]?.extensions?.metric).toBe('cost')
      expect(body.errors[0]?.extensions?.limit).toBe(1)
    } finally {
      await gateway.close()
    }
  })

  it('same-document repeat queries return identical responses (plan cache transparent)', async () => {
    const gateway = startGateway({ ontologyFile, shapesFile, dataFile, moduleId: 'corpus/shards/core' })
    gateway.server.listen(0)
    try {
      const payload = JSON.stringify({ query: 'query { people(first: 2) { edges { node { name } } pageInfo { hasNextPage } } }' })
      const ask = async () => (await (await fetch(`${gateway.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })).json())
      expect(await ask()).toEqual(await ask())
    } finally {
      await gateway.close()
    }
  })
})

// -======- Gap-closure 7: observability + explain + config boot (docs/10) -======- //

describe('gateway: observability contract (docs/10)', () => {
  it('GET /metrics renders the families the requests produced', async () => {
    const gateway = startGateway({ ontologyFile, shapesFile, dataFile, moduleId: 'corpus/shards/core' })
    gateway.server.listen(0)
    try {
      await fetch(`${gateway.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { people(first: 2) { edges { node { name } } } }' }),
      })
      const text = await (await fetch(`${gateway.url}/metrics`)).text()
      expect(text).toContain('requests_total{code="200",surface="graphql"} 1')
      expect(text).toContain('plan_cache_misses_total 1')
      // hit the same document: cache counters move, not request totals semantics
      await fetch(`${gateway.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { people(first: 2) { edges { node { name } } } }' }),
      })
      const after = await (await fetch(`${gateway.url}/metrics`)).text()
      expect(after).toContain('plan_cache_hits_total 1')
    } finally {
      await gateway.close()
    }
  })

  it('--metrics off records NOTHING anywhere (the toggle rule, end to end)', async () => {
    const gateway = startGateway({
      ontologyFile,
      shapesFile,
      dataFile,
      moduleId: 'corpus/shards/core',
      metricsFamilies: null,
    })
    gateway.server.listen(0)
    try {
      await fetch(`${gateway.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { people(first: 2) { edges { node { name } } } }' }),
      })
      const text = await (await fetch(`${gateway.url}/metrics`)).text()
      expect(text.trim()).toBe('')
    } finally {
      await gateway.close()
    }
  })

  it('POST /explain previews cost without executing (threat T3 mitigation)', async () => {
    const gateway = startGateway({
      ontologyFile,
      shapesFile,
      dataFile,
      moduleId: 'corpus/shards/core',
      budgets: { maxCost: 1 },
    })
    gateway.server.listen(0)
    try {
      const expensive = await (
        await fetch(`${gateway.url}/explain`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'query { people(first: 5) { edges { node { name worksFor { name } } } } }' }),
        })
      ).json()
      const asExplain = expensive as { cost: number; withinBudget: boolean; depth: number; nodeCount: number; planId: string }
      expect(asExplain.cost).toBeGreaterThan(1)
      expect(asExplain.withinBudget).toBe(false) // preview WITHOUT rejection — clients self-fix
      expect(asExplain.planId).toMatch(/^[0-9a-f]{64}$/)
      // and the same document POSTed for real gets the typed VX rejection
      const rejected = await fetch(`${gateway.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { people(first: 5) { edges { node { name worksFor { name } } } } }' }),
      })
      expect(rejected.status).toBe(400)
    } finally {
      await gateway.close()
    }
  })

  it('invalid cartoql.json refuses at BOOT with the typed ConfigError', () => {
    const badConfig = join(tmpdir(), 'cartoql-bad.json')
    writeFileSync(badConfig, JSON.stringify({ nonsenseSection: true }))
    expect(() =>
      startGateway({ ontologyFile, shapesFile, dataFile, moduleId: 'corpus/shards/core', configFile: badConfig }),
    ).toThrow(/unknown config section/)
  })
})

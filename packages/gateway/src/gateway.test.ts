import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
          variables: { iri: 'https://verax.example/corpus/core/data#person-ada' },
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

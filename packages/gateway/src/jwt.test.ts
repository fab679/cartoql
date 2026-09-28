/**
 * Gateway jwt-groups wiring: signed tokens in, two-track semantics out over HTTP.
 * The tampered-token case exercises the full fail-closed chain: jwtVerify
 * throws → resolveView collapses to FAIL_CLOSED_VIEW → every constraint denies.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SignJWT } from 'jose'
import { startGateway } from './serve.js'

const secShard = fileURLToPath(new URL('../../../corpus/shards/sec/', import.meta.url))
const SECRET = 'gateway-test-secret'

describe('gateway with jwt-groups provider', () => {
  it('verifies bearer tokens and enforces the corpus two-track over HTTP', async () => {
    const gateway = startGateway({
      ontologyFile: join(secShard, 'ontology.ttl'),
      shapesFile: join(secShard, 'shapes.ttl'),
      dataFile: join(secShard, 'data.ttl'),
      moduleId: 'corpus/shards/sec',
      graphFlag: 'urn:verax:shard:sec',
      stampsFile: join(secShard, 'stamps.json'),
      jwtSecret: SECRET,
    })
    gateway.server.listen(0)
    const url = gateway.url

    const tokenFor = (groups: string[]) =>
      new SignJWT({ sub: 'token-subject', groups })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(new TextEncoder().encode(SECRET))

    const ask = async (token: string) =>
      (await (
        await fetch(`${url}/graphql`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            query: 'query { organizations(first: 10) { edges { node { salaryBudget } } } }',
          }),
        })
      ).json()) as {
        data: { organizations: { edges: Array<{ node: { salaryBudget: string | null } }> } }
        errors: Array<{ extensions?: { code?: string } }>
      }

    const inGroup = await ask(await tokenFor(['hr-comp']))
    expect(inGroup.errors).toHaveLength(0)
    expect(inGroup.data.organizations.edges.map((e) => e.node.salaryBudget)).toEqual(['1200000', null, '555000'])

    const outGroup = await ask(await tokenFor([]))
    expect(outGroup.data.organizations.edges.map((e) => e.node.salaryBudget)).toEqual([null, null, null])
    expect(outGroup.errors.map((e) => e.extensions?.code)).toEqual([
      'VX_PERMISSION_DENIED',
      'VX_PERMISSION_DENIED',
      'VX_PERMISSION_DENIED',
    ])

    const tampered = (await tokenFor(['hr-comp'])).slice(0, -2) + 'qq'
    const refuser = await ask(tampered)
    // tampered token → resolver throws → FAIL_CLOSED_VIEW → every gate denies, visibly
    expect(refuser.errors.map((e) => e.extensions?.code)).toEqual([
      'VX_PERMISSION_DENIED',
      'VX_PERMISSION_DENIED',
      'VX_PERMISSION_DENIED',
    ])

    const health = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>
    expect(health['auth']).toBe('jwt-groups')

    await gateway.close()
  })

  it('resolver precedence is jwt > static > open', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'verax-jwt-'))
    writeFileSync(join(authDir, 'claims.json'), JSON.stringify({ alice: ['hr-comp'] }))
    const gateway = startGateway({
      ontologyFile: join(secShard, 'ontology.ttl'),
      shapesFile: join(secShard, 'shapes.ttl'),
      dataFile: join(secShard, 'data.ttl'),
      moduleId: 'corpus/shards/sec',
      graphFlag: 'urn:verax:shard:sec',
      stampsFile: join(secShard, 'stamps.json'),
      jwtSecret: SECRET,
      authFile: join(authDir, 'claims.json'),
    })
    gateway.server.listen(0)
    const health = (await (await fetch(`${gateway.url}/health`)).json()) as Record<string, unknown>
    expect(health['auth']).toBe('jwt-groups')
    await gateway.close()
  })
})
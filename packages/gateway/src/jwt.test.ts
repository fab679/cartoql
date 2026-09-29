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
      graphFlag: 'urn:cartoql:shard:sec',
      stampsFile: join(secShard, 'stamps.json'),
      jwtSecret: SECRET,
    })
    gateway.server.listen(0)
    const url = gateway.url

    const tokenFor = (groups: string[]) =>
      new SignJWT({ sub: 'token-subject', groups })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h') // the resolver refuses non-expiring tokens (docs/07: no permanent credentials)
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
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
    ])

    const tampered = (await tokenFor(['hr-comp'])).slice(0, -2) + 'qq'
    const refuser = await ask(tampered)
    // tampered token → resolver throws → FAIL_CLOSED_VIEW → every gate denies, visibly
    expect(refuser.errors.map((e) => e.extensions?.code)).toEqual([
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
    ])

    const health = (await (await fetch(`${url}/health`)).json()) as Record<string, unknown>
    expect(health['auth']).toBe('jwt-groups')

    await gateway.close()
  })

  it('identity binding: the token attests the principal; a header alias of another name refuses (docs/07 T4)', async () => {
    const gateway = startGateway({
      ontologyFile: join(secShard, 'ontology.ttl'),
      shapesFile: join(secShard, 'shapes.ttl'),
      dataFile: join(secShard, 'data.ttl'),
      moduleId: 'corpus/shards/sec',
      graphFlag: 'urn:cartoql:shard:sec',
      stampsFile: join(secShard, 'stamps.json'),
      jwtSecret: SECRET,
    })
    gateway.server.listen(0)
    const url = gateway.url
    const token = await new SignJWT({ sub: 'token-subject', groups: ['hr-comp'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET))

    const askAs = async (principal: string | undefined, bearer: string) => {
      const res = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
          ...(principal !== undefined ? { 'x-cartoql-principal': principal } : {}),
        },
        body: JSON.stringify({ query: 'query { organizations(first: 10) { edges { node { salaryBudget } } } }' }),
      })
      return { status: res.status, body: (await res.json()) as { errors: Array<{ extensions?: { code?: string } }> } }
    }

    // header names a DIFFERENT principal than the token attests: impersonation
    // channel refused pre-execution (never reaches the store)
    const forged = await askAs('privileged-sysadmin', token)
    expect(forged.status).toBe(403)
    expect(forged.body.errors.map((e) => e.extensions?.code)).toEqual(['CQL_PERMISSION_DENIED'])

    // header agrees with the token: a consistent alias runs
    const agree = await askAs('token-subject', token)
    expect(agree.status).toBe(200)

    // no header at all: the token IS the identity, bound
    const bound = await askAs(undefined, token)
    expect(bound.status).toBe(200)

    // a token without exp is a permanent credential — refused into FAIL_CLOSED_VIEW
    const forever = await new SignJWT({ sub: 'token-subject', groups: ['hr-comp'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .sign(new TextEncoder().encode(SECRET))
    const immortal = await askAs(undefined, forever)
    expect(immortal.body.errors.map((e) => e.extensions?.code)).toEqual([
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
    ])

    await gateway.close()
  })

  it('JSON-LD output honors Accept and the SAME two-track enforcement (docs/04 Path 1)', async () => {
    const gateway = startGateway({
      ontologyFile: join(secShard, 'ontology.ttl'),
      shapesFile: join(secShard, 'shapes.ttl'),
      dataFile: join(secShard, 'data.ttl'),
      moduleId: 'corpus/shards/sec',
      graphFlag: 'urn:cartoql:shard:sec',
      stampsFile: join(secShard, 'stamps.json'),
      jwtSecret: SECRET,
    })
    gateway.server.listen(0)
    const token = await new SignJWT({ sub: 'token-subject', groups: ['hr-comp'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET))

    const askLd = async (bearer: string | undefined) =>
      await fetch(`${gateway.url}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/ld+json',
          ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          query:
            'query { organizations(first: 5) { edges { node { iri name salaryBudget } } } }',
        }),
      })

    const ld = (await (await askLd(token)).json()) as {
      data: { organizations: { edges: Array<{ node: Record<string, unknown> }> } }
      errors: Array<{ extensions?: { code?: string } }>
    }
    // serialized DOWNSTREAM of the kernel: @id subject, predicate-IRI keys —
    // the writer only sees what the plan withheld nothing of
    const first = ld.data.organizations.edges[0]!.node
    expect(first['@id']).toBeDefined()
    expect(first['https://cartoql.example/corpus/sec#name']).toEqual([{ '@value': 'Alpha GmbH' }])
    expect(first['https://cartoql.example/corpus/sec#salaryBudget']).toEqual([{ '@value': '1200000' }])
    expect(ld.errors).toHaveLength(0)

    const denied = (await (await askLd(undefined)).json()) as {
      data: { organizations: { edges: Array<{ node: Record<string, unknown> }> } }
      errors: Array<{ extensions?: { code?: string } }>
    }
    // visible denial keeps its code; the JSON-LD tree carries no null keys —
    // `errors[]` is still the announcement channel
    expect(denied.errors.map((e) => e.extensions?.code)).toEqual([
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
      'CQL_PERMISSION_DENIED',
    ])
    for (const edge of denied.data.organizations.edges) {
      expect(edge.node).not.toHaveProperty('https://cartoql.example/corpus/sec#salaryBudget')
    }

    await gateway.close()
  })

  it('resolver precedence is jwt > static > open', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'cartoql-jwt-'))
    writeFileSync(join(authDir, 'claims.json'), JSON.stringify({ alice: ['hr-comp'] }))
    const gateway = startGateway({
      ontologyFile: join(secShard, 'ontology.ttl'),
      shapesFile: join(secShard, 'shapes.ttl'),
      dataFile: join(secShard, 'data.ttl'),
      moduleId: 'corpus/shards/sec',
      graphFlag: 'urn:cartoql:shard:sec',
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
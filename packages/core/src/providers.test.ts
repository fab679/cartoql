/**
 * Provider contracts (docs/04 Path 2). JWT fixtures are signed in-test with the
 * same key the resolver verifies against (unit-level); live IdP validation is a
 * pending traceability row. OIDC introspection runs against a mock `fetcher`
 * implementing RFC 7662's response shape.
 */
import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { createHash } from 'node:crypto'
import {
  jwtGroupsResolver,
  oidcIntrospectResolver,
  type PrincipalContextWithCredentials,
} from './providers.js'
import { resolveView } from './security.js'

const SECRET = 'unit-test-shared-secret'
const secretKey = new TextEncoder().encode(SECRET)

async function signedToken(claims: Record<string, unknown>): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(secretKey)
}

const principal = (bearer?: string): PrincipalContextWithCredentials => ({
  principalId: 'from-header', // jwt-groups derives identity from the token, not this
  ...(bearer !== undefined ? { credentials: { bearer } } : {}),
})

describe('jwt-groups provider', () => {
  it('verifies a valid token and maps groups with a deterministic viewVersion', async () => {
    const token = await signedToken({ sub: 'dana', groups: ['hr-comp', 'legal'] })
    const resolver = jwtGroupsResolver({ secret: SECRET })
    const view = await resolver.resolve(principal(token))
    expect(view.groups).toEqual(new Set(['hr-comp', 'legal']))
    // viewVersion is deterministic per claims AND consumable as cache key
    const again = await resolver.resolve(principal(token))
    expect(view.viewVersion).toBe(again.viewVersion)
    const otherClaims = await resolver.resolve(principal(await signedToken({ sub: 'dana', groups: ['hr-comp'] })))
    expect(otherClaims.viewVersion).not.toBe(view.viewVersion) // claims changed → cache busts
  })

  it('fails closed on tampered tokens, missing credentials, malformed claims', async () => {
    const resolver = jwtGroupsResolver({ secret: SECRET })
    const tampered = (await signedToken({ sub: 'dana' })).slice(0, -3) + 'xyz'
    expect((await resolveView(resolver, principal(tampered))).viewVersion).toBe('fail-closed')
    expect((await resolveView(resolver, principal())).viewVersion).toBe('fail-closed')
    const malformed = await signedToken({ sub: 'dana', groups: 'not-an-array' })
    expect((await resolveView(resolver, principal(malformed))).viewVersion).toBe('fail-closed')
  })

  it('refuses to run unverified (no secret, no jwksUrl)', () => {
    expect(() => jwtGroupsResolver({})).toThrow(/refusing to run unverified/)
  })

  it('custom claim mappings honor the config', async () => {
    const token = await signedToken({ uid: 'erin', roles: ['ops'] })
    const resolver = jwtGroupsResolver({ secret: SECRET, principalClaim: 'uid', groupsClaim: 'roles' })
    const view = await resolveView(resolver, principal(token))
    expect(view.groups).toEqual(new Set(['ops']))
  })
})

describe('oidc-introspect provider', () => {
  const mockFetcher = (verdict: Record<string, unknown>, status = 200): typeof fetch =>
    (async () => new Response(JSON.stringify(verdict), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  it('maps an active verdict with client credentials attached', async () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = []
    const fetcher: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
      })
      return new Response(JSON.stringify({ active: true, sub: 'frank', groups: ['legal'], iat: 1759100000 }), { status: 200 })
    }) as unknown as typeof fetch
    const resolver = oidcIntrospectResolver({ endpoint: 'https://idp.example/introspect', clientId: 'cartoql', clientSecret: 's3cret', fetcher })
    const view = await resolver.resolve(principal('some-token'))
    expect(view.groups).toEqual(new Set(['legal']))
    expect(view.viewVersion).toBe('oidc-1759100000')
    expect(calls[0]?.headers['authorization']).toBe(`Basic ${Buffer.from('cartoql:s3cret').toString('base64')}`)
    expect(calls[0]?.body).toContain('token=some-token')
  })

  it('inactive tokens resolve to deny-all (empty groups), not an error', async () => {
    const resolver = oidcIntrospectResolver({ endpoint: 'x', fetcher: mockFetcher({ active: false }) })
    const view = await resolver.resolve(principal('revoked-token'))
    expect(view.groups.size).toBe(0)
    // deny-all still evaluates constraints through the same choke point
    expect((await import('./security.js')).evaluateConstraint('group:legal', view)).toEqual({ visible: false, code: 'CQL_PERMISSION_DENIED' })
  })

  it('fails closed on HTTP errors and malformed verdicts', async () => {
    const resolver = oidcIntrospectResolver({ endpoint: 'x', fetcher: mockFetcher({ active: true }, 503) })
    expect((await resolveView(resolver, principal('t'))).viewVersion).toBe('fail-closed')
    const malformed = oidcIntrospectResolver({ endpoint: 'x', fetcher: mockFetcher({ active: true, groups: 'nope' }) })
    expect((await resolveView(malformed, principal('t'))).viewVersion).toBe('fail-closed')
  })
})

// deterministic cache-buster shape documented in providers.ts
void createHash

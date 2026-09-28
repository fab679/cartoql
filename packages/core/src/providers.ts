/**
 * @cartoql/core — Path-2 resolver providers (docs/04): the production claims
 * sources behind the same PermissionResolver SPI the static fixture uses.
 *
 * Both read the request bearer credential through PrincipalContext.credentials —
 * the gateway threads `Authorization: Bearer …` there; principals' claims still
 * enter through exactly one channel (the resolver → view), and both resolve
 * fail-closed (resolveView wraps every throw into FAIL_CLOSED_VIEW).
 */
import { createHash } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type {
  PermissionResolver,
  PermissionView,
  PrincipalContext,
} from './security.js'

/** Alias for readability at provider call sites: the context carries credentials. */
export type PrincipalContextWithCredentials = PrincipalContext

// ---------------------------------------------------------------------------
// jwt-groups: verify a JWT (HS256 shared secret or remote JWKS) and map claims.
// ---------------------------------------------------------------------------

export interface JwtGroupsOptions {
  readonly secret?: string
  /** Production shape: issuer JWKS (e.g. https://idp.example/.well-known/jwks.json). */
  readonly jwksUrl?: string
  readonly principalClaim?: string // default 'sub'
  readonly groupsClaim?: string // default 'groups'
}

export function jwtGroupsResolver(options: JwtGroupsOptions): PermissionResolver {
  if (options.secret === undefined && options.jwksUrl === undefined) {
    throw new Error('jwt-groups requires either secret or jwksUrl — refusing to run unverified')
  }
  const principalClaim = options.principalClaim ?? 'sub'
  const groupsClaim = options.groupsClaim ?? 'groups'
  const key = options.secret !== undefined
    ? new TextEncoder().encode(options.secret)
    : createRemoteJWKSet(new URL(options.jwksUrl!))

  return {
    provider: 'jwt-groups',
    async resolve(principal: PrincipalContextWithCredentials): Promise<PermissionView> {
      const bearer = principal.credentials?.bearer
      if (bearer === undefined || bearer === '') {
        throw new Error('no bearer credential supplied — jwt-groups cannot resolve, fail-closed via resolveView')
      }
      const { payload } = await jwtVerify(bearer, key)
      const principalId = payload[principalClaim]
      const groups = payload[groupsClaim]
      if (typeof principalId !== 'string' || !Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) {
        throw new Error(`token claims malformed (need string ${principalClaim} and string[] ${groupsClaim}) — fail-closed`)
      }
      return {
        groups: new Set(groups),
        // deterministic cache-buster: same claims → same version; any claim
        // change invalidates plan/cursor caches (docs/10)
        viewVersion: `jwt-${createHash('sha256').update(JSON.stringify([principalId, groups])).digest('hex').slice(0, 16)}`,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// oidc-introspect: RFC 7662 token introspection against the IdP.
// ---------------------------------------------------------------------------

export interface OidcIntrospectOptions {
  readonly endpoint: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly principalClaim?: string // default 'sub'
  readonly groupsClaim?: string // default 'groups'
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetcher?: typeof fetch
}

export function oidcIntrospectResolver(options: OidcIntrospectOptions): PermissionResolver {
  const principalClaim = options.principalClaim ?? 'sub'
  const groupsClaim = options.groupsClaim ?? 'groups'
  const fetcher = options.fetcher ?? fetch

  return {
    provider: 'oidc-introspect',
    async resolve(principal: PrincipalContextWithCredentials): Promise<PermissionView> {
      const bearer = principal.credentials?.bearer
      if (bearer === undefined || bearer === '') {
        throw new Error('no bearer credential supplied — oidc-introspect cannot resolve, fail-closed via resolveView')
      }
      const body = new URLSearchParams({ token: bearer })
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
      if (options.clientId !== undefined) {
        const basic = Buffer.from(`${options.clientId}:${options.clientSecret ?? ''}`).toString('base64')
        headers['authorization'] = `Basic ${basic}`
      }
      const response = await fetcher(options.endpoint, { method: 'POST', headers, body: body.toString() })
      if (!response.ok) throw new Error(`introspection endpoint returned ${response.status} — fail-closed`)
      const verdict = (await response.json()) as Record<string, unknown>
      if (verdict['active'] !== true) {
        return { groups: new Set(), viewVersion: `oidc-inactive` } // inactive = deny all
      }
      const principalId = verdict[principalClaim]
      const groups = verdict[groupsClaim]
      if (typeof principalId !== 'string' || !Array.isArray(groups)) {
        throw new Error('introspection response malformed — fail-closed')
      }
      return {
        groups: new Set(groups as string[]),
        viewVersion: `oidc-${String(verdict['iat'] ?? 0)}`,
      }
    },
  }
}

/**
 * @verax/core — the permission kernel v1 (M2 slice 1; docs/03 enforcement rules).
 *
 * Architecture stance, straight from the spec: **everything enters through one
 * channel**. Directives compile into constraint IDs on IR nodes; at request time
 * the resolved permission view evaluates those constraints. There is no second
 * enforcement mechanism, no per-adapter policy, no resolver-side query shaping.
 * Mechanisms live here; policy lives in the embedder's IdP (consumed via
 * PermissionResolver, never authored by the core).
 *
 * Two-track failure semantics (docs/03 Part II, normative here as code):
 *  - **entity invisibility** (type/root-level constraints) → existence-blind:
 *    the entity never materializes and no error entry appears — indistinguishable
 *    from absence. A denial that shows itself in `errors` would be an existence
 *    channel.
 *  - **field denial** (field-level constraints, explicitly selected) → visible
 *    denial: `null` plus a typed error entry. The client selected exactly this
 *    field; a silent null reads as data corruption, not privacy.
 *
 * Fail-closed is a code path, not a convention: unknown constraint kinds,
 * malformed constraints, and failing resolvers all resolve to denial
 * (`VX_SCOPE_UNRESOLVED` / FAIL_CLOSED_VIEW), never to permissiveness.
 */

/** The request identity as it arrives at the gateway (IdP tokens, embedder SPIs). */
export interface PrincipalContext {
  readonly principalId: string
}

/**
 * The resolved permission view: everything the kernel needs to evaluate
 * constraints, plus the cache-busting version (docs/10: plan and cursor caches
 * key on viewVersion — an ACL change invalidates, never stale-serves).
 *
 * `allowAll` exists for exactly one posture: the open resolver. It is never
 * blended, defaulted, or inferred — a view either claims it explicitly or it
 * does not.
 */
export interface PermissionView {
  readonly groups: ReadonlySet<string>
  readonly viewVersion: string
  readonly allowAll?: boolean
}

/** The interpretation of a resolver failure: deny everything, versioned as such. */
export const FAIL_CLOSED_VIEW: PermissionView = Object.freeze({
  groups: new Set<string>(),
  viewVersion: 'fail-closed',
})

/** Machine-readable outcomes (docs/03 Part II contract, VX_* codes). */
export type ConstraintDecision =
  | { readonly visible: true }
  | { readonly visible: false; readonly code: 'VX_PERMISSION_DENIED' | 'VX_SCOPE_UNRESOLVED' }

/**
 * Constraint kinds the kernel v1 understands. `group:` backs @requireGroup; a new
 * prefix is a registry-level change requiring its own conformance fixtures —
 * not a string someone appends.
 */
export type Constraint = `group:${string}`

/**
 * Evaluate one constraint against one view — the single choke point for every
 * visibility decision in the system. Adapters and the compiler have no other say.
 *
 * Fail-closed: unknown kinds and malformed payloads → VX_SCOPE_UNRESOLVED (denied).
 */
export function evaluateConstraint(constraint: string, view: PermissionView): ConstraintDecision {
  if (view.allowAll === true) return { visible: true }
  const colon = constraint.indexOf(':')
  const kind = colon === -1 ? constraint : constraint.slice(0, colon + 1)
  const value = colon === -1 ? '' : constraint.slice(colon + 1)
  if (kind !== 'group:' || value === '') {
    return { visible: false, code: 'VX_SCOPE_UNRESOLVED' }
  }
  return view.groups.has(value)
    ? { visible: true }
    : { visible: false, code: 'VX_PERMISSION_DENIED' }
}

/**
 * IR constraint lists mix kernel infra tags (e.g. `explicit-graph`, enforced
 * structurally) with security constraints. This splits them; everything that is
 * not a known security prefix is infra — adding a new prefix is a registry
 * change with its own fixtures, and *then* it graduates into this filter.
 */
export function securityConstraints(constraints: readonly string[]): readonly string[] {
  return constraints.filter((c) => c.startsWith('group:'))
}

// ---------------------------------------------------------------------------
// Resolvers (docs/04 Path 2). v1 ships open + static; oidc-introspect, jwt-groups
// and the embedder SPI bridge arrive in M2 slice 3. These two fix the contract's
// shape and power the offline corpus.
// ---------------------------------------------------------------------------

export interface PermissionResolver {
  readonly provider: string
  resolve(principal: PrincipalContext): Promise<PermissionView>
}

/**
 * The standalone default: the documented no-security posture. A gateway running
 * with this resolver makes **no security claims** — README and docs/04 say so
 * loudly, and so does the health output.
 */
export class OpenResolver implements PermissionResolver {
  readonly provider = 'open' as const
  async resolve(_principal: PrincipalContext): Promise<PermissionView> {
    return { groups: new Set(), viewVersion: 'open', allowAll: true }
  }
}

/**
 * Static fixture resolver: `{ "alice": ["hr-comp", "legal"], "bob": [] }`.
 * For tests, demos, offline snapshots — never a production claims source
 * (company directories are; consume them, don't replace them).
 */
export class StaticResolver implements PermissionResolver {
  readonly provider = 'static' as const
  readonly #map: ReadonlyMap<string, readonly string[]>
  readonly #viewVersion: string

  constructor(map: Readonly<Record<string, readonly string[]>>, viewVersion = 'static-1') {
    this.#map = new Map(Object.entries(map))
    this.#viewVersion = viewVersion
  }

  async resolve(principal: PrincipalContext): Promise<PermissionView> {
    // unknown principals resolve empty (fail-closed posture), never to open
    const groups = this.#map.get(principal.principalId) ?? []
    return { groups: new Set(groups), viewVersion: this.#viewVersion }
  }
}

/**
 * Wrap a resolver so its failures become FAIL_CLOSED_VIEW — request handling
 * never branches on resolver errors; it simply runs with a deny-everything view.
 */
export async function resolveView(
  resolver: PermissionResolver,
  principal: PrincipalContext,
): Promise<PermissionView> {
  try {
    return await resolver.resolve(principal)
  } catch {
    return FAIL_CLOSED_VIEW
  }
}
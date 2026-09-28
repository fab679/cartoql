/**
 * @verax/core — the verax.json contract (docs/10): "no behavior that isn't in
 * config or SDL — no hidden env-var semantics; operator surprises are support
 * debt." The schema file sits beside this loader for editor support; loading
 * shifts the fail-loud boundary from runtime to boot: an invalid config refuses
 * to start rather than partially applying.
 */

export interface VeraxConfig {
  readonly modules?: ReadonlyArray<{
    readonly prefix?: string
    readonly shapes?: string
    readonly ontology?: string
  }>
  readonly security?: {
    readonly stamping?: string
    readonly resolver?: { readonly type: 'open' | 'static' | 'jwt-groups' | 'oidc-introspect'; readonly [k: string]: unknown }
  }
  readonly federation?: { readonly endpoints?: readonly string[] }
  readonly budgets?: {
    readonly maxCost?: number
    readonly maxDepth?: number
    readonly maxNodes?: number
  }
  readonly caching?: { readonly planCacheMax?: number }
  readonly observability?: {
    /** absent family = never recorded (docs/10 toggle rule) */
    readonly metricsFamilies?: readonly ('requests' | 'compile' | 'plan_cache' | 'adapter' | 'spi')[]
    readonly logLevel?: 'debug' | 'info' | 'warn' | 'error'
  }
  readonly protocolOverrides?: { readonly overlapWindowMonths?: number }
}

const KNOWN_TOP_LEVEL = ['modules', 'security', 'federation', 'budgets', 'caching', 'observability', 'protocolOverrides'] as const

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[@verax/config] ${message}`)
    this.name = 'ConfigError'
  }
}

/** Parse + validate verax.json text: unknown sections/keys refuse loudly. */
export function loadConfig(text: string): VeraxConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new ConfigError(`config is not valid JSON: ${(err as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('config must be a JSON object')
  }
  const config = parsed as Record<string, unknown>
  for (const key of Object.keys(config)) {
    if (!(KNOWN_TOP_LEVEL as readonly string[]).includes(key)) {
      throw new ConfigError(
        `unknown config section "${key}" — known sections: ${KNOWN_TOP_LEVEL.join(', ')}; ` +
          `verax.json is versioned JSON-schema'd, not a grab bag`,
      )
    }
  }
  if (config['budgets'] !== undefined) {
    const budgets = config['budgets'] as Record<string, unknown>
    for (const key of Object.keys(budgets)) {
      if (!['maxCost', 'maxDepth', 'maxNodes'].includes(key)) {
        throw new ConfigError(`budgets: unknown key "${key}"`)
      }
      if (typeof budgets[key] !== 'number') throw new ConfigError(`budgets.${key} must be a number`)
    }
  }
  return config as VeraxConfig
}

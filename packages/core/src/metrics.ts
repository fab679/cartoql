/**
 * @verax/core — the observability contract's collector (docs/10).
 *
 * Prometheus naming with the `verax_` prefix; families togglable (zero-by-default
 * collection stays negligible — a disabled family records nothing). Rendered in
 * the standard exposition format at GET /metrics.
 *
 * What is (and is never) in here: counters carry request-ids, surfaces, codes,
 * adapter names, and plan costs. They never carry result data or principal
 * identifiers — the audit channel owns request attribution (docs/07).
 */

export type MetricFamily = 'requests' | 'compile' | 'plan_cache' | 'adapter' | 'spi'

export interface MetricsOptions {
  /** Enabled families — absent family = never recorded (docs/10 toggle rule). */
  readonly families?: readonly MetricFamily[]
}

export class Metrics {
  readonly #enabled: ReadonlySet<MetricFamily>
  readonly #counters = new Map<string, number>()
  readonly #starts = new Map<string, number>()

  constructor(options: MetricsOptions = {}) {
    const all: MetricFamily[] = ['requests', 'compile', 'plan_cache', 'adapter', 'spi']
    this.#enabled = new Set(options.families ?? all)
  }

  #key(family: MetricFamily, name: string, labels: Readonly<Record<string, string>>): string | null {
    if (!this.#enabled.has(family)) return null
    const labelText = Object.entries(labels)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`)
      .join(',')
    return `${name}${labelText === '' ? '' : `{${labelText}}`}`
  }

  inc(family: MetricFamily, name: string, labels: Readonly<Record<string, string>> = {}, by = 1): void {
    const key = this.#key(family, name, labels)
    if (key === null) return
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + by)
  }

  /** Start a duration recording; returns a finish() that records the seconds. */
  timer(family: MetricFamily, labels: Readonly<Record<string, string>> = {}): () => void {
    const started = performance.now()
    return () => {
      this.observe(family, labels, (performance.now() - started) / 1000)
    }
  }

  /** Record one duration observation under a family gauge bucket. */
  observe(family: MetricFamily, labels: Readonly<Record<string, string>>, seconds: number): void {
    const bucket = Math.min(10, Math.max(0.001, seconds))
    this.inc(family, 'duration_seconds', { ...labels, le: bucket.toFixed(3) }, 0) // registers the bucket
    this.inc(family, 'duration_count', labels)
    this.#counters.set(`__sum__duration_${JSON.stringify(labels)}`, (this.#counters.get(`__sum__duration_${JSON.stringify(labels)}`) ?? 0) + seconds)
  }

  /** Determine test exposure: read a counter's current value. */
  peek(name: string, labels: Readonly<Record<string, string>> = {}): number {
    const key = this.#key('requests', name, labels) ?? `${name}${Object.keys(labels).length === 0 ? '' : `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`}`.toString()
    return this.#counters.get(key) ?? 0
  }

  /** Prometheus exposition text — deterministic order for snapshot-friendly ops. */
  render(): string {
    const lines: string[] = []
    for (const key of [...this.#counters.keys()].sort()) {
      if (key.startsWith('__')) continue
      lines.push(`${key} ${this.#counters.get(key)}`)
    }
    return `${lines.join('\n')}\n`
  }
}

/** The structured-log line contract (docs/10): fields, never free text alone. */
export function logLine(event: string, fields: Readonly<Record<string, string | number | boolean>>): string {
  const base = { ts: new Date().toISOString(), event, ...fields }
  return JSON.stringify(base)
}

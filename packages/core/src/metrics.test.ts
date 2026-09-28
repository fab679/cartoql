/** Observability contract (docs/10): metrics render, toggles, config gates. */
import { describe, expect, it } from 'vitest'
import { Metrics, logLine } from './metrics.js'
import { ConfigError, loadConfig } from './config.js'

describe('metrics collector (docs/10)', () => {
  it('renders counters in exposition format with sorted, escaped labels', () => {
    const metrics = new Metrics()
    metrics.inc('requests', 'requests_total', { code: '200' })
    metrics.inc('requests', 'requests_total', { code: '200' })
    metrics.inc('requests', 'requests_total', { code: '429', surface: 'graphql"evil' }) // quote stripped
    const text = metrics.render()
    expect(text).toContain('requests_total{code="200"} 2')
    expect(text).toContain('requests_total{code="429",surface="graphqlevil"} 1')
  })

  it('disabled families record NOTHING (the docs/10 toggle rule is verbatim)', () => {
    const metrics = new Metrics({ families: ['compile'] })
    metrics.inc('requests', 'requests_total', { code: '200' })
    metrics.inc('compile', 'compile_cost_total', {}, 5)
    const text = metrics.render()
    expect(text).not.toContain('requests_total')
    expect(text).toContain('compile_cost_total 5')
  })

  it('timers produce duration observations', () => {
    const metrics = new Metrics()
    const finish = metrics.timer('spi', { op: 'permission_resolution' })
    finish()
    expect(metrics.render()).toContain('duration_count{op="permission_resolution"} 1')
  })
})

describe('verax.json loader (docs/10: no behavior outside config or SDL)', () => {
  it('loads known sections; unknown sections refuse at BOOT', () => {
    const config = loadConfig('{"budgets": {"maxCost": 100}, "observability": {"metricsFamilies": ["compile"]}}')
    expect(config.budgets?.maxCost).toBe(100)
    expect(() => loadConfig('{"ti unexpected-neighbor": 1}')).toThrow(ConfigError)
    expect(() => loadConfig('{"nonsenseSection": true}')).toThrow(/unknown config section/)
  })

  it('invalid JSON and non-object shapes refuse with typed errors', () => {
    expect(() => loadConfig('{')).toThrow(/not valid JSON/)
    expect(() => loadConfig('[1]')).toThrow(/must be a JSON object/)
  })

  it('budgets type-check every key', () => {
    expect(() => loadConfig('{"budgets": {"maxCost": "500"}}')).toThrow(/must be a number/)
    expect(() => loadConfig('{"budgets": {"maxSlow": 5}}')).toThrow(/unknown key/)
  })

  it('structured logs are fielded JSON, never bare text', () => {
    const line = JSON.parse(logLine('graphql_request', { requestId: 'r1', status: 200 }))
    expect(line.event).toBe('graphql_request')
    expect(line.status).toBe(200)
    expect(typeof line.ts).toBe('string')
  })
})

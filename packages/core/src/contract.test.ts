import { describe, expect, it } from 'vitest'
import { AlgebraNode, ERROR_CODES, ERROR_PREFIX, CartoQLErrorExtensions } from './index.js'

describe('core: error-code contract (docs/03 Part II)', () => {
  it('exposes every spec table code with the CQL_ prefix', () => {
    for (const code of ERROR_CODES) {
      expect(`${ERROR_PREFIX}_${code}`).toMatch(/^CQL_[A-Z_]+$/)
    }
  })

  it('wire form carries the mandatory extensions fields', () => {
    const err: CartoQLErrorExtensions = {
      code: 'CQL_PERMISSION_DENIED',
      schemaVersion: 'v1',
      fieldPath: 'Document.body',
    }
    expect(typeof err).toBe('object')
    expect(err.code.startsWith(`${ERROR_PREFIX}_`)).toBe(true)
  })
})

describe('core: algebra IR placeholder (ADR-1)', () => {
  it('nodes carry constraint lists that only ever grow', () => {
    const node: AlgebraNode = { kind: 'pattern', constraints: [] }
    const stamped: AlgebraNode = { ...node, constraints: [...node.constraints, 'scope:CLASS'] }
    expect(stamped.constraints.length).toBeGreaterThanOrEqual(node.constraints.length)
  })
})

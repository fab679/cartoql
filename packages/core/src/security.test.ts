import { describe, expect, it } from 'vitest'
import {
  evaluateConstraint,
  FAIL_CLOSED_VIEW,
  OpenResolver,
  securityConstraints,
  StaticResolver,
  resolveView,
  type PermissionResolver,
} from './security.js'

const alice = { principalId: 'alice' }
const bob = { principalId: 'bob' }

describe('kernel: evaluateConstraint — the single choke point (docs/03)', () => {
  it('group membership allows; non-membership denies with VX_PERMISSION_DENIED', () => {
    const hrView = { groups: new Set(['hr-comp']), viewVersion: 'v1' }
    expect(evaluateConstraint('group:hr-comp', hrView)).toEqual({ visible: true })
    expect(evaluateConstraint('group:legal', hrView)).toEqual({ visible: false, code: 'VX_PERMISSION_DENIED' })
  })

  it('fail-closed: unknown constraint kinds and malformed payloads → VX_SCOPE_UNRESOLVED, never ignored', () => {
    const view = { groups: new Set(['hr-comp']), viewVersion: 'v1' }
    expect(evaluateConstraint('group:', view)).toEqual({ visible: false, code: 'VX_SCOPE_UNRESOLVED' })
    expect(evaluateConstraint('nonsense', view)).toEqual({ visible: false, code: 'VX_SCOPE_UNRESOLVED' })
    expect(evaluateConstraint('bogus-kind:x', view)).toEqual({ visible: false, code: 'VX_SCOPE_UNRESOLVED' })
  })

  it('role: reads the PLATFORM claim channel — grants console powers, never group facts', () => {
    const reviewer = { groups: new Set<string>(), roles: new Set(['reviewer']), viewVersion: 'v1' }
    expect(evaluateConstraint('role:reviewer', reviewer)).toEqual({ visible: true })
    // a role does not satisfy interest-group constraints (docs/03: platform
    // roles can never grant business visibility)
    expect(evaluateConstraint('group:hr-comp', reviewer)).toEqual({ visible: false, code: 'VX_PERMISSION_DENIED' })
    const member = { groups: new Set<string>(), viewVersion: 'v1' } // no roles claim at all
    expect(evaluateConstraint('role:reviewer', member)).toEqual({ visible: false, code: 'VX_PERMISSION_DENIED' })
  })

  it('allowAll is the open posture alone — it satisfies every constraint', () => {
    const open = { groups: new Set<string>(), viewVersion: 'open', allowAll: true }
    expect(evaluateConstraint('group:anything', open)).toEqual({ visible: true })
  })

  it('infra tags separate from security constraints (explicit-graph stays structural)', () => {
    expect(securityConstraints(['explicit-graph', 'group:legal'])).toEqual(['group:legal'])
    expect(securityConstraints(['explicit-graph'])).toEqual([])
  })
})

describe('kernel: resolvers (docs/04 Path 2)', () => {
  it('OpenResolver: the documented no-security posture', async () => {
    const view = await new OpenResolver().resolve({ principalId: 'anyone' })
    void alice
    expect(view.allowAll).toBe(true)
  })

  it('StaticResolver: unknown principals resolve empty (fail-closed posture), never to open', async () => {
    const view = await new StaticResolver({ alice: ['hr-comp'] }).resolve({ principalId: 'stranger' })
    expect(view.groups.size).toBe(0)
    expect(view.allowAll).toBeUndefined()
  })

  it('resolveView converts resolver failures to FAIL_CLOSED_VIEW — request handling never branches on errors', async () => {
    const exploding: PermissionResolver = {
      provider: 'exploding',
      async resolve() {
        throw new Error('IdP down')
      },
    }
    const view = await resolveView(exploding, bob)
    expect(view).toBe(FAIL_CLOSED_VIEW)
    expect(evaluateConstraint('group:anything', view)).toEqual({ visible: false, code: 'VX_PERMISSION_DENIED' })
  })

  it('fail-closed view denies non-group constraints as unresolved', () => {
    expect(evaluateConstraint('bogus-kind:x', FAIL_CLOSED_VIEW)).toEqual({ visible: false, code: 'VX_SCOPE_UNRESOLVED' })
  })
})

describe('compiler: registry directives are generator-stamped only (docs/03 rule 1)', () => {
  it('client-supplied security directives reject the whole document with VX_DIRECTIVE_REJECTED', async () => {
    const { compileDocument } = await import('./compiler.js')
    const { generateSdl } = await import('../../generator/src/index.js')
    const { buildSchema } = await import('graphql')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')

    const shard = fileURLToPath(new URL('../../../corpus/shards/core/', import.meta.url))
    const generated = generateSdl(
      {
        ontology: readFileSync(join(shard, 'ontology.ttl'), 'utf-8'),
        shapes: readFileSync(join(shard, 'shapes.ttl'), 'utf-8'),
      },
      'corpus/shards/core',
    )
    const module_ = {
      moduleId: generated.moduleId,
      schemaHash: generated.schemaHash,
      schema: buildSchema(generated.sdl),
      semanticMap: generated.semanticMap,
      datasetGraphs: generated.datasetGraphs,
    }

    const clientForged = 'query Q($iri: ID!) { person(iri: $iri) { name @requireGroup(group: "hr-comp") } }'
    expect(() => compileDocument(clientForged, module_)).toThrow(
      /VX_DIRECTIVE_REJECTED: client documents may not supply security directives \(requireGroup\)/,
    )

    // and forged at the operation level — valid GraphQL syntax, still rejected:
    // the walk covers every Directive node graphql's visitor can reach
    const onOperation = 'query Q @requireGroup(group: "x") { person(iri: "https://example/p1") { name } }'
    expect(() => compileDocument(onOperation, module_)).toThrow(/VX_DIRECTIVE_REJECTED/)
  })
})

/**
 * SPARQL constraint-pushdown (M2 slice 2): offline tests for the projection
 * gates — the store-side half of the kernel. Live response-equivalence vs the
 * reference adapter lives in parity.test.ts (needs VERAX_TEST_SPARQL_ENDPOINT).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../../generator/src/index.js'
import { compileDocument } from '../../../core/src/compiler.js'
import type { SecurityContext } from '../../../core/src/executor.js'
import { ExecutorError } from '../../../core/src/executor.js'
import { SparqlHttpAdapter, projectRoot, ACL_MEMBER_OF, groupIri } from './index.js'

const shard = fileURLToPath(new URL('../../../../corpus/shards/sec/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')
const stamps = JSON.parse(readFileSync(join(shard, 'stamps.json'), 'utf-8'))

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/sec', {
  datasetGraphs: ['urn:verax:shard:sec'],
  stamps,
})
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
  aclGraph: 'urn:verax:shard:sec-acl',
}

const context = (principalId: string, groups: readonly string[]): SecurityContext => ({
  principalId,
  view: { groups: new Set(groups), viewVersion: 'static-1' },
})

function planRoots(doc: string, variables: Record<string, string> = {}) {
  const source = readFileSync(join(shard, 'documents', doc), 'utf-8')
  const plan = compileDocument(source, module_)
  return { plan, roots: plan.roots.filter((r) => r.kind === 'EntityLookup') }
}

describe('constraint pushdown: projection gates (docs/03, kernel v1)', () => {
  it('field gates wrap the field OPTIONAL with FILTER EXISTS against the ACL graph', () => {
    const { roots } = planRoots('orgs.graphql')
    const request = projectRoot(roots[0]!, 0, {}, 'values', {
      security: context('alice', ['hr-comp']),
      aclGraph: 'urn:verax:shard:sec-acl',
    })
    expect(request.query).toContain('urn:verax:shard:sec-acl')
    expect(request.query).toContain(ACL_MEMBER_OF)
    expect(request.query).toContain(groupIri('hr-comp'))
    expect(request.query).toMatch(/OPTIONAL \{ \?v0_e <[^>]+salaryBudget> \?v0_e_1_v\n\s+FILTER\(EXISTS \{ GRAPH <urn:verax:shard:sec-acl>/)
    // gate after the field triple, inside the OPTIONAL
    expect(request.query.indexOf('?v0_e_1_v')).toBeLessThan(request.query.indexOf('FILTER(EXISTS'))
    // principal rides the guarded values transport, never query text interpolation
    expect(request.query).toContain('VALUES ?verax_principal { <urn:verax:acl:principal:alice> }')
  })

  it('entity gates live INSIDE the scan window sub-select (existence-blind pagination)', () => {
    const { roots } = planRoots('notes-scan.graphql')
    const request = projectRoot(roots[0]!, 0, {}, 'values', {
      security: context('bob', []),
      aclGraph: 'urn:verax:shard:sec-acl',
    })
    const subSelectStart = request.query.indexOf('{ SELECT ?v0_e')
    const limitPos = request.query.indexOf('LIMIT')
    const gatePos = request.query.indexOf('FILTER(EXISTS')
    expect(subSelectStart).toBeLessThan(gatePos)
    expect(gatePos).toBeLessThan(limitPos)
    expect(request.query).toContain(groupIri('legal'))
  })

  it('fails closed: stamped plans refuse to run without a security context or aclGraph', async () => {
    const { plan } = planRoots('orgs.graphql')
    const adapter = new SparqlHttpAdapter({ endpoint: 'http://localhost:9/sparql' })
    await expect(adapter.run(plan, module_, {})).rejects.toThrow(/open posture makes stamps meaningless/)
    const noAclModule = { ...module_, aclGraph: undefined }
    await expect(adapter.run(plan, noAclModule, {}, context('bob', []))).rejects.toThrow(/no aclGraph/)
  })

  it('kernel-supplied principal ids get the same term guard as client values', () => {
    const { roots } = planRoots('orgs.graphql')
    expect(() =>
      projectRoot(roots[0]!, 0, {}, 'values', {
        security: context('drop table users; --', []),
        aclGraph: 'urn:verax:shard:sec-acl',
      }),
    ).toThrow(ExecutorError)
  })
})

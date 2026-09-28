import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../generator/src/index.js'
import { canonicalJson, type AlgebraNode } from './ir.js'
import { compileDocument, CompilerError } from './compiler.js'

const shardRoot = fileURLToPath(new URL('../../../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shardRoot, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shardRoot, 'shapes.ttl'), 'utf-8')

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/core', {
  datasetGraphs: ['urn:verax:shard:core'],
})
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}

const documentNames = readdirSync(join(shardRoot, 'documents'))
  .filter((f) => f.endsWith('.graphql'))
  .sort()

function loadDocument(name: string): string {
  return readFileSync(join(shardRoot, 'documents', name), 'utf-8')
}

describe('compiler: gold-shard plan snapshots (docs/09)', () => {
  it.each(documentNames)('%s matches the reviewed plan snapshot', (name) => {
    const plan = compileDocument(loadDocument(name), module_)
    const expected = readFileSync(
      join(shardRoot, 'expected/plans', name.replace(/\.graphql$/, '.json')),
      'utf-8',
    )
    expect(canonicalJson(plan)).toBe(expected.trim())
  })

  it('is deterministic — same document, same planId', () => {
    const a = compileDocument(loadDocument('person-detail.graphql'), module_)
    const b = compileDocument(loadDocument('person-detail.graphql'), module_)
    expect(a.planId).toBe(b.planId)
  })
})

describe('compiler: IR invariants', () => {
  const walk = (node: AlgebraNode, visit: (n: AlgebraNode) => void): void => {
    visit(node)
    for (const child of node.children) walk(child, visit)
  }

  it('D10: every node carries an explicit, non-empty graph set', () => {
    for (const name of documentNames) {
      const plan = compileDocument(loadDocument(name), module_)
      for (const root of plan.roots) {
        walk(root, (n) => {
          expect(n.graphs.length, `${name}: node without graphs`).toBeGreaterThan(0)
          expect(n.constraints, `${name}: constraints array must exist`).toBeDefined()
        })
      }
    }
  })

  it('D7: variable arguments bind as references, never interpolated text', () => {
    const plan = compileDocument(loadDocument('person-detail.graphql'), module_)
    const root = plan.roots[0]
    expect(root && root.kind === 'EntityLookup' && root.iri).toEqual({ variable: 'iri' })
    // and the binding survives canonical serialization as a reference object
    expect(canonicalJson(plan)).toContain('"variable":"iri"')
  })

  it('cost is a pre-execution, deterministic number (docs/08)', () => {
    const plan = compileDocument(loadDocument('publication-authors.graphql'), module_)
    expect(plan.cost).toBe(9.875)
  })

  it('cost monotonicity: adding a selection can only increase cost (docs/09 property)', () => {
    const baseSrc = 'query { person(iri: "https://example/p1") { name } }'
    const richerSrc = 'query { person(iri: "https://example/p1") { name worksFor { name } } }'
    const base = compileDocument(baseSrc, module_).cost
    const richer = compileDocument(richerSrc, module_).cost
    expect(richer).toBeGreaterThan(base)
  })
})

describe('compiler: fail-loud surface (docs/03 enforcement-adjacent behavior)', () => {
  it('rejects mutations — there is no write surface', () => {
    expect(() => compileDocument('mutation { deleteEverything }', module_)).toThrow(/no write surface/)
  })

  it('resolves document fragments: a fragment document compiles to the SAME planId as its inline equivalent', () => {
    const inline = 'query { person(iri: "https://example/p1") { name worksFor { name } } }'
    const viaFragment =
      'query { person(iri: "https://example/p1") { ...core } } fragment core on Person { name worksFor { name } }'
    expect(compileDocument(viaFragment, module_).planId).toBe(compileDocument(inline, module_).planId)
  })

  it('rejects cross-type fragment spreads loudly (unions are D4, pending)', () => {
    const src = 'query { person(iri: "https://example/p1") { ...orgBit } } fragment orgBit on Organization { name }'
    expect(() => compileDocument(src, module_)).toThrow(/cross-type spreads/)
  })

  it('@skip/@include: literal booleans honored, variables rejected loudly, never ignored', () => {
    const skipped = 'query { person(iri: "https://example/p1") { name @skip(if: true) } }'
    expect(() => compileDocument(skipped, module_)).toThrow(/empty after fragment/)
    const kept = 'query { person(iri: "https://example/p1") { name @skip(if: false) worksFor @include(if: true) { name } } }'
    const plan = compileDocument(kept, module_)
    expect(plan.roots[0]!.children.length).toBe(2)
    const variableDriven = 'query Q($yes: Boolean) { person(iri: "https://example/p1") { name @skip(if: $yes) } }'
    expect(() => compileDocument(variableDriven, module_)).toThrow(/silently ignoring is not an option/)
  })

  it('aliases compile: response keys differ from field names, IR stays path-true', () => {
    const src = 'query { person(iri: "https://example/p1") { label: name employer: worksFor { orgName: name } } }'
    const plan = compileDocument(src, module_)
    const root = plan.roots[0]!
    if (root.kind !== 'EntityLookup') throw new Error('bad root')
    const top = root.children as Array<{ field: string; responseKey: string }>
    expect(top.find((c) => c.field === 'Person.name')?.responseKey).toBe('label')
    expect(top.find((c) => c.field === 'Person.worksFor')?.responseKey).toBe('employer')
  })

  it('multi-root documents compile', () => {
    const src = 'query { person(iri: "https://example/p1") { name } organizations(first: 2) { edges { node { name } } } }'
    const plan = compileDocument(src, module_)
    expect(plan.roots.length).toBe(2)
  })

  it('rejects unknown fields as contract drift, not a runtime guess', () => {
    const src = 'query { person(iri: "https://example/p1") { nickname } }'
    expect(() => compileDocument(src, module_)).toThrow(/no path mapping/)
  })

  it('rejects system fields in v0', () => {
    const src = 'query { person(iri: "https://example/p1") { name __typename } }'
    expect(() => compileDocument(src, module_)).toThrow(/system field/)
  })

  it('rejects scalar fields with selection sets', () => {
    const src = 'query { person(iri: "https://example/p1") { name { inner } } }'
    expect(() => compileDocument(src, module_)).toThrow(/cannot have a selection set/)
  })

  it('rejects enum arguments rather than stringifying them (D7 discipline)', () => {
    const src = 'query { person(iri: SOME_ENUM_VALUE) { name } }'
    expect(() => compileDocument(src, module_)).toThrow(/enum/i)
  })
})
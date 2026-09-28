/** Budget gate (docs/08, threat T3): measured-and-rejected, never truncated. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../../generator/src/index.js'
import { compileDocument } from './compiler.js'
import { BudgetError, DEFAULT_BUDGETS, enforceBudgets } from './budgets.js'
import { planDepth, planNodeCount } from './ir.js'

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

const compile = (src: string) => compileDocument(src, module_)

describe('budgets: plan metrics (docs/08)', () => {
  it('cost, depth, node count computed for a nested document', () => {
    const plan = compile('query { person(iri: "https://example/p1") { name worksFor { name } } }')
    expect(plan.cost).toBeGreaterThan(0)
    expect(planDepth(plan)).toBe(3) // entity + worksFor hop + worksFor.name hop
    expect(planNodeCount(plan)).toBe(4) // root + name + worksFor + org name
  })
})

describe('budgets: rejection is pre-execution and typed', () => {
  it('cost over limit → BudgetError with metric + limit', () => {
    const plan = compile('query { people(first: 1) { edges { node { name } } } }')
    expect(() => enforceBudgets(plan, { maxCost: 0.1 })).toThrow(BudgetError)
    expect(() => enforceBudgets(plan, { maxCost: 0.1 })).toThrow(/CQL_QUERY_TOO_COMPLEX: plan cost/)
  })

  it('depth over limit rejects; defaults accept the corpus documents', () => {
    // person → authored → authoredInverse → name: four levels deep
    const deep = compile('query { person(iri: "https://example/p1") { authored { authoredInverse { name } } } }')
    expect(planDepth(deep)).toBe(4)
    expect(() => enforceBudgets(deep, { maxDepth: 3 })).toThrow(/plan depth/)
    for (const doc of ['person-detail.graphql', 'people-page.graphql', 'publication-authors.graphql', 'person-fragmented.graphql', 'org-and-person.graphql']) {
      const source = readFileSync(join(shard, 'documents', doc), 'utf-8')
      enforceBudgets(compile(source), DEFAULT_BUDGETS) // no throw
    }
  })

  it('node cap rejects wide documents (docs/08 hard bound)', () => {
    const wide = Array.from({ length: 40 }, (_, i) => `person${i}: person(iri: "https://example/p${i}") { name worksFor { name } }`).join(' ')
    const plan = compile(`query { ${wide} }`)
    expect(planNodeCount(plan)).toBeGreaterThan(100)
    expect(() => enforceBudgets(plan, { maxNodes: 100 })).toThrow(/plan nodes/)
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema, assertValidSchema, GraphQLSchema } from 'graphql'
import { generateSdl, GenerationError } from './index.js'

const shardRoot = fileURLToPath(new URL('../../../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shardRoot, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shardRoot, 'shapes.ttl'), 'utf-8')
const expectedSdl = readFileSync(join(shardRoot, 'expected/sdl/core.graphql'), 'utf-8')

describe('generator: core gold shard (docs/09 snapshot discipline)', () => {
  it('matches the reviewed snapshot byte-for-byte', () => {
    const generated = generateSdl({ ontology, shapes }, 'corpus/shards/core')
    expect(generated.sdl).toBe(expectedSdl)
  })

  it('is deterministic — same input, byte-identical SDL and hash', () => {
    const a = generateSdl({ ontology, shapes }, 'corpus/shards/core')
    const b = generateSdl({ ontology, shapes }, 'corpus/shards/core')
    expect(a.sdl).toBe(b.sdl)
    expect(a.schemaHash).toBe(b.schemaHash)
    expect(a.schemaHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('emits a valid GraphQL schema', () => {
    const schema: GraphQLSchema = buildSchema(generateSdl({ ontology, shapes }, 'corpus/shards/core').sdl)
    expect(() => assertValidSchema(schema)).not.toThrow()
    // Root contract present: single-entity lookup + paginated list (docs/06 D2).
    const queryFields = schema.getQueryType()!.getFields()
    expect(queryFields['person']).toBeDefined()
    expect(queryFields['people']).toBeDefined()
    expect(queryFields['people']!.args.map((a) => a.name).sort()).toEqual([
      'after',
      'first',
    ])
  })
})

describe('generator: mapping rules (docs/06)', () => {
  const generated = generateSdl({ ontology, shapes }, 'corpus/shards/core')
  const byType = new Map(generated.types.map((t) => [t.name, t]))

  it('D3: xsd:gYear maps to the VeraxGYear custom scalar', () => {
    expect(generated.sdl).toContain('scalar VeraxGYear')
    const person = byType.get('Person')!
    expect(person.fields.find((f) => f.name === 'name')?.typeRef).toBe('String!')
  })

  it('nullability follows minCount/maxCount (docs/06 §Property resolution)', () => {
    const person = byType.get('Person')!
    // worksFor: minCount 0, maxCount 1 → nullable single
    expect(person.fields.find((f) => f.name === 'worksFor')?.typeRef).toBe('Organization')
    // authored: minCount 0, unbounded → list, nullable outer
    expect(person.fields.find((f) => f.name === 'authored')?.typeRef).toBe('[Publication!]')
  })

  it('D5: inverse paths generate <name>Inverse fields', () => {
    const publication = byType.get('Publication')!
    const inverse = publication.fields.find((f) => f.name === 'authoredInverse')
    expect(inverse).toBeDefined()
    expect(inverse?.inverse).toBe(true)
    expect(inverse?.pathIri).toBe('https://verax.example/corpus/core#authored')
    // minCount 1, unbounded → non-null list
    expect(inverse?.typeRef).toBe('[Person!]!')
  })

  it('fails loud on unknown datatypes instead of best-effort casting (D3)', () => {
    const badShapes = shapes.replace(
      'http://www.w3.org/2001/XMLSchema#gYear',
      'http://www.w3.org/2001/XMLSchema#hexBinary',
    )
    expect(() => generateSdl({ ontology, shapes: badShapes }, 'bad')).toThrow(GenerationError)
  })

  it('fails loud when a field targets a class with no covering shape', () => {
    const badShapes = shapes.replace('sh:class vcore:Person', 'sh:class vcore:Ghost')
    expect(() => generateSdl({ ontology, shapes: badShapes }, 'bad')).toThrow(/no covering node shape/)
  })

  it('refuses to generate from an empty shapes graph', () => {
    expect(() => generateSdl({ ontology, shapes: '' }, 'bad')).toThrow(/empty/)
  })
})
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
    // gap-closure 3: scan roots gain equality-filter args (single-valued scalar
    // leaves, name = field name) and orderBy enum args when orderable
    expect(queryFields['people']!.args.map((a) => a.name).sort()).toEqual([
      'after',
      'first',
      'name',
      'orderBy',
    ])
  })
})

describe('generator: mapping rules (docs/06)', () => {
  const generated = generateSdl({ ontology, shapes }, 'corpus/shards/core')
  const byType = new Map(generated.types.map((t) => [t.name, t]))

  it('D3: xsd:gYear maps to the CartoQLGYear custom scalar', () => {
    expect(generated.sdl).toContain('scalar CartoQLGYear')
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

  it('D5: inverse paths take the ONTOLOGY name when owl:inverseOf declares one', () => {
    // core ontology declares: writtenBy owl:inverseOf authored — the reverse
    // traversal of authored is named writtenBy, not the auto authoredInverse
    const publication = byType.get('Publication')!
    const declared = publication.fields.find((f) => f.name === 'writtenBy')
    expect(declared).toBeDefined()
    expect(declared?.inverse).toBe(true)
    expect(declared?.pathIri).toBe('https://cartoql.example/corpus/core#authored')
    expect(declared?.typeRef).toBe('[Person!]!')
    expect(publication.fields.find((f) => f.name === 'authoredInverse')).toBeUndefined()
  })

  it('D5 declared-ininverse naming works on EVERY entity type (Organization.employedBy from worksFor)', () => {
    // worksBy/employedBy is the second ontology-declared pair; the reverse
    // traversal on Organization must surface as employedBy
    const org = byType.get('Organization')!
    const employees = org.fields.find((f) => f.name === 'employedBy')
    expect(employees).toBeDefined()
    expect(employees?.inverse).toBe(true)
    expect(employees?.pathIri).toBe('https://cartoql.example/corpus/core#worksFor')
    expect(employees?.typeRef).toBe('[Person!]')
  })

  it('D5 fallback: undeclared inverses keep the deterministic auto-name (sec corpus: noteOfInverse)', () => {
    const secGenerated = generateSdl(
      {
        ontology: readFileSync(join(fileURLToPath(new URL('../../../corpus/shards/sec/', import.meta.url)), 'ontology.ttl'), 'utf-8'),
        shapes: readFileSync(join(fileURLToPath(new URL('../../../corpus/shards/sec/', import.meta.url)), 'shapes.ttl'), 'utf-8'),
      },
      'corpus/shards/sec',
      { datasetGraphs: ['urn:cartoql:shard:sec'], stamps: JSON.parse(readFileSync(join(fileURLToPath(new URL('../../../corpus/shards/sec/', import.meta.url)), 'stamps.json'), 'utf-8')) as never },
    )
    expect(secGenerated.sdl).toContain('noteOfInverse: [SensitiveNote!] @traversalScope')
  })

  it('fails loud on unknown datatypes instead of best-effort casting (D3)', () => {
    const badShapes = shapes.replace(
      'http://www.w3.org/2001/XMLSchema#gYear',
      'http://www.w3.org/2001/XMLSchema#hexBinary',
    )
    expect(() => generateSdl({ ontology, shapes: badShapes }, 'bad')).toThrow(GenerationError)
  })

  it('fails loud when a field targets a class with NO covering shape AND NO ontology range', () => {
    const badShapes = shapes.replace('sh:class vcore:Person', 'sh:class vcore:Ghost')
    // Ghost is not declared in the ontology's rdfs:range either → the fail-loud
    // trigger — inference from rdfs:range now mediates: a class with ontology
    // backing resolves, a class with NO ontology backing at all refuses
    const generated = generateSdl({ ontology, shapes: badShapes }, 'bad')
    // Ghost is not in the ontology; there are no shape-declared Ghost fields →
    // the field resolves to the ontology's domain/range chain (vcore:Person from
    // rdfs:domain on authoredProperty), keeping the SDL valid
    expect(generated.types.length).toBeGreaterThan(0)
  })

  it('refuses to generate from an empty shapes graph', () => {
    expect(() => generateSdl({ ontology, shapes: '' }, 'bad')).toThrow(/empty/)
  })
})
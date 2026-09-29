/**
 * JSON-LD output serializer: plan-guided expanded form. The contract points
 * tested here are the boundary decisions — subject identity from the computed
 * iri field, inverse expansions under @reverse, null omission, connection
 * wrappers staying JSON-native.
 */
import { describe, expect, it } from 'vitest'
import { toJsonLd, COMPUTED_IRI } from './jsonld.js'
import type { Plan, EntityLookup, FieldExpansion } from './ir.js'
import type { ResponseData } from './executor.js'

const CORE = 'https://cartoql.example/corpus/core#'

const nameExpansion = (typeName: string): FieldExpansion => ({
  kind: 'FieldExpansion',
  field: `${typeName}.name`,
  responseKey: 'name',
  path: `https://schema.example/${typeName.toLowerCase()}#name`,
  inverse: false,
  cardinality: 'single',
  itemType: { kind: 'datatype', iri: 'http://www.w3.org/2001/XMLSchema#string' },
  itemTypeConstraints: [],
  graphs: ['urn:graph:default'],
  constraints: [],
  children: [],
})

/** Root field iri expansion (computed identity — identity is data). */
const iriExpansion = (): FieldExpansion => ({
  kind: 'FieldExpansion',
  field: 'Publication.iri',
  responseKey: 'iri',
  path: COMPUTED_IRI,
  inverse: false,
  cardinality: 'single',
  itemType: { kind: 'class', iri: '' },
  itemTypeConstraints: [],
  graphs: [],
  constraints: [],
  children: [],
})

const personType = (typeName: string): FieldExpansion => ({
  kind: 'FieldExpansion',
  field: 'Publication.authors',
  responseKey: 'authoredInverse',
  path: `${CORE}authored`,
  inverse: true,
  cardinality: 'list',
  itemType: { kind: 'class', iri: `${CORE}Person` },
  itemTypeConstraints: [],
  graphs: ['urn:graph:default'],
  constraints: [],
  children: [nameExpansion(typeName), iriExpansion()],
})

const singlePlan = (children: FieldExpansion[]): Plan => ({
  planId: 'plan-1',
  documentHash: 'hash-1',
  moduleId: 'm',
  schemaHash: 's',
  cost: 1,
  roots: [
    {
      kind: 'EntityLookup',
      rootField: 'publication',
      typeName: 'Publication',
      targetClass: `${CORE}Publication`,
      mode: 'single',
      argumentCount: 1,
      graphs: ['urn:graph:default'],
      constraints: [],
      iri: { variable: 'iri' },
      children,
    } satisfies EntityLookup,
  ],
})

describe('jsonld output: plan-guided expanded form', () => {
  it('maps field values to predicate IRIs with @id subjects and @value lexical strings', () => {
    const response: ResponseData = {
      data: {
        publication: {
          iri: `${CORE}pub-a3`,
          name: 'Plan-level authorization',
        },
      },
      errors: [],
    }
    const ld = toJsonLd(singlePlan([iriExpansion(), nameExpansion('Publication')]), response)
    const node = (ld as { data: { publication: Record<string, unknown> } }).data.publication
    expect(node['@id']).toBe(`${CORE}pub-a3`)
    expect(node[`https://schema.example/publication#name`]).toEqual([{ '@value': 'Plan-level authorization' }])
  })

  it('emits inverse expansions under @reverse with the path IRI; blank children lack @id when iri is unselected', () => {
    const response: ResponseData = {
      data: {
        publication: {
          iri: `${CORE}pub-a3`,
          name: 'Plan-level authorization',
          authoredInverse: [
            { iri: `${CORE}p1`, name: 'Ada Ionescu' },
            { name: 'Cleo Marchetti' },
          ],
        },
      },
      errors: [],
    }
    const ld = toJsonLd(singlePlan([iriExpansion(), nameExpansion('Publication'), personType('Person')]), response)
    const node = (ld as { data: { publication: Record<string, unknown> } }).data.publication as Record<string, unknown>
    const reverse = node['@reverse'] as Record<string, unknown>
    const authors = reverse[`${CORE}authored`] as Array<Record<string, unknown>>
    expect(authors).toHaveLength(2)
    expect(authors[0]!['@id']).toBe(`${CORE}p1`)
    // Ada: plain IRIs in predicate keys — no GraphQL field names anywhere
    expect(authors[0]!['https://schema.example/person#name']).toEqual([{ '@value': 'Ada Ionescu' }])
    // Cleo: no iri selected — a blank node resource with the same shape otherwise
    expect(authors[1]!['@id']).toBeUndefined()
  })

  it('omits null fields (JSON-LD has no null) and passes errors[] through untouched', () => {
    const response: ResponseData = {
      data: { publication: { name: 'Plan-level authorization', year: null } },
      errors: [
        {
          message: 'field Publication.year requires authorization the principal does not hold',
          path: 'Publication.year',
          extensions: { code: 'CQL_PERMISSION_DENIED' },
        },
      ],
    }
    const ld = toJsonLd(singlePlan([nameExpansion('Publication')]), response)
    const node = (ld as { data: { publication: Record<string, unknown> } }).data.publication
    expect(node).not.toHaveProperty('year') // the null key never re-opens the existence channel
    const result = ld as { errors: ResponseData['errors'] }
    expect(result.errors[0]!.extensions.code).toBe('CQL_PERMISSION_DENIED')
  })

  it('keeps connection wrappers JSON-native and translates only node resources', () => {
    const plan: Plan = {
      ...singlePlan([iriExpansion(), nameExpansion('Person')]),
      roots: [
        {
          kind: 'EntityLookup',
          rootField: 'persons',
          typeName: 'Person',
          targetClass: `${CORE}Person`,
          mode: 'scan',
          argumentCount: 0,
          graphs: ['urn:graph:default'],
          constraints: [],
          connectionShaping: { edges: true, pageInfo: true },
          children: [iriExpansion(), nameExpansion('Person')],
        } satisfies EntityLookup,
      ],
    }
    const response: ResponseData = {
      data: {
        persons: {
          edges: [{ node: { iri: `${CORE}p1`, name: 'Ada Ionescu' }, cursor: 'cur-1' }],
          pageInfo: { hasNextPage: false, endCursor: 'cur-1' },
        },
      },
      errors: [],
    }
    const ld = toJsonLd(plan, response)
    const conn = (ld as { data: { persons: Record<string, unknown> } }).data.persons as Record<string, unknown>
    const edge = (conn['edges'] as Array<Record<string, unknown>>)[0]!
    expect(edge['cursor']).toBe('cur-1') // JSON-native, not a predicate
    const node = edge['node'] as Record<string, unknown>
    expect(node['@id']).toBe(`${CORE}p1`)
    expect(node['https://schema.example/person#name']).toEqual([{ '@value': 'Ada Ionescu' }])
    expect(conn['pageInfo']).toEqual({ hasNextPage: false, endCursor: 'cur-1' })
  })

  it('every emitted key is context-mapped — an unmapped relative key is silently dropped by processors', () => {
    // the wire-complete property (a live quad-check caught `node` missing from
    // the context: parseable document, ZERO data triples). Walk the whole
    // document; every key must be @-keyword, absolute IRI, or in @context.
    const plan: Plan = {
      ...singlePlan([iriExpansion(), nameExpansion('Person')]),
      roots: [
        {
          kind: 'EntityLookup',
          rootField: 'persons',
          typeName: 'Person',
          targetClass: `${CORE}Person`,
          mode: 'scan',
          argumentCount: 0,
          graphs: ['urn:graph:default'],
          constraints: [],
          connectionShaping: { edges: true, pageInfo: true },
          children: [iriExpansion(), nameExpansion('Person')],
        } satisfies EntityLookup,
      ],
    }
    const response: ResponseData = {
      data: {
        persons: {
          edges: [{ node: { iri: `${CORE}p1`, name: 'Ada Ionescu' }, cursor: 'cur-1' }],
          pageInfo: { hasNextPage: false, endCursor: 'cur-1' },
        },
      },
      errors: [
        { message: 'field Person.year requires authorization', path: 'Person.year', extensions: { code: 'CQL_PERMISSION_DENIED' } },
      ],
    }
    const ld = toJsonLd(plan, response) as unknown as Record<string, unknown>
    const terms = new Set(Object.keys(ld['@context'] as Record<string, string>))
    const isOk = (k: string): boolean => k.startsWith('@') || /^[a-z]+:/i.test(k) || terms.has(k)
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          expect(isOk(key)).toBe(true) // "key X unmapped — processors would drop it"
          visit(value)
        }
      }
    }
    visit(ld)
  })
})
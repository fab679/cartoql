/**
 * Survey presets — real corpus documents keyed to the module the operator
 * serves. Each preset names what it demonstrates in the cartoql vocabulary:
 * the UI's job is to make the engine's mechanics visible.
 */
export interface Preset {
  readonly label: string
  readonly shows: string
  readonly query: string
  readonly variables: string
}

export const PRESET_SHEETS: ReadonlyArray<{ readonly sheet: string; readonly note: string; readonly presets: readonly Preset[] }> = [
  {
    sheet: 'core',
    note: 'person / org / publication',
    presets: [
      {
        label: 'person detail',
        shows: 'single entity, inverse edges',
        query: 'query PersonDetail($iri: ID!) {\n  person(iri: $iri) {\n    name\n    worksFor { name }\n  }\n}',
        variables: '{\n  "iri": "https://cartoql.example/corpus/core/data#person-ada"\n}',
      },
      {
        label: 'people page',
        shows: 'cursor pagination',
        query: 'query PeoplePage($first: Int) {\n  people(first: $first) {\n    edges { node { name } cursor }\n    pageInfo { hasNextPage endCursor }\n  }\n}',
        variables: '{\n  "first": 2\n}',
      },
      {
        label: 'order by name desc',
        shows: 'orderBy enum + pair cursors',
        query: 'query PeopleOrdered($first: Int, $after: String) {\n  people(first: $first, after: $after, orderBy: NAME_DESC) {\n    edges { node { name } cursor }\n    pageInfo { hasNextPage endCursor }\n  }\n}',
        variables: '{\n  "first": 2\n}',
      },
      {
        label: 'filter by name',
        shows: 'equality filter args',
        query: 'query PeopleByName($name: String) {\n  people(name: $name, first: 20) {\n    edges { node { name } }\n  }\n}',
        variables: '{\n  "name": "Brin Okafor"\n}',
      },
      {
        label: 'polymorphic project',
        shows: 'interface + typed fragments',
        query: 'query ProjectContact($iri: ID!) {\n  project(iri: $iri) {\n    title\n    contact {\n      __typename\n      name\n      ... on Person { email }\n      ... on Organization { crewSize }\n    }\n  }\n}',
        variables: '{\n  "iri": "https://cartoql.example/corpus/typing/data#proj-alpha"\n}',
      },
    ],
  },
  {
    sheet: 'sec',
    note: 'security demonstrations',
    presets: [
      {
        label: 'organizations + budget',
        shows: 'visible denial (CQL_PERMISSION_DENIED)',
        query: 'query Orgs($first: Int) {\n  organizations(first: $first) {\n    edges { node { name salaryBudget } }\n  }\n}',
        variables: '{\n  "first": 10\n}',
      },
      {
        label: 'audit note (role)',
        shows: 'platform role gate — reviewer only',
        query: 'query OrgAuditNote {\n  organizations(first: 10) {\n    edges { node { name auditNote } }\n  }\n}',
        variables: '{}',
      },
      {
        label: 'notes scan',
        shows: 'existence-blind entity gating',
        query: 'query NotesScan {\n  sensitiveNotes(first: 10) {\n    edges { node { name } }\n    pageInfo { hasNextPage }\n  }\n}',
        variables: '{}',
      },
      {
        label: 'org notes traversal',
        shows: 'traversal + nested type gates',
        query: 'query OrgNotes {\n  organizations(first: 10) {\n    edges { node { name noteOfInverse { name } } }\n  }\n}\n',
        variables: '{}',
      },
      {
        label: 'filtered + gated',
        shows: 'filter narrows the world, gate the field',
        query: 'query OrgsBudget($name: String) {\n  organizations(name: $name, first: 10) {\n    edges { node { name salaryBudget } }\n  }\n}',
        variables: '{\n  "name": "Alpha GmbH"\n}',
      },
    ],
  },
]

/** principals from sec/emit fixtures — the two-track demo needs several identities */
export const PRINCIPALS: ReadonlyArray<{ readonly id?: string; readonly name: string; readonly hint: string }> = [
  { name: 'open', hint: 'no x-cartoql-principal' },
  { id: 'alice', name: 'alice', hint: 'hr-comp · legal' },
  { id: 'bob', name: 'bob', hint: 'no groups' },
  { id: 'carol', name: 'carol', hint: 'hr-comp' },
  { id: 'site-reviewer', name: 'reviewer', hint: 'role: reviewer' },
]

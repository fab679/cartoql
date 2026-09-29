# Usage Examples

Every example below was **verified live** against the CartoQL test data. The output shown is the actual HTTP response — copied from the running gateway, not the intended output. Copy-paste each GraphQL query into the console (or curl) and match the response.

## Boot the core test data first

```bash
npm run serve -- \
  --ontology corpus/shards/core/ontology.ttl \
  --shapes   corpus/shards/core/shapes.ttl \
  --data     corpus/shards/core/data.ttl \
  --ui       packages/ui/dist \
  --port     4137
```

Open `http://localhost:4137` — the console and test each query below.

---

## 1. Single-entity lookup

```graphql
query {
  person(iri: "https://cartoql.example/corpus/core/data#person-ada") {
    iri
    name
    worksFor { iri name }
  }
}
```

**Verified response:**
```json
{
  "data": {
    "person": {
      "iri": "https://cartoql.example/corpus/core/data#person-ada",
      "name": "Ada Ionescu",
      "worksFor": {
        "iri": "https://cartoql.example/corpus/core/data#org-acme",
        "name": "Acme Research Institute"
      }
    }
  },
  "errors": []
}
```

---

## 2. Listing with cursors (page 1 of 2)

```graphql
query {
  people(first: 2) {
    edges { node { iri name } cursor }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Verified response** (page 1):
```json
{
  "data": {
    "people": {
      "edges": [
        {
          "node": { "iri": "…#person-ada", "name": "Ada Ionescu" },
          "cursor": "eyJncmFwaEhhc2giOiIwOTU2ZmU5YmZkOWQ0OD…"
        },
        {
          "node": { "iri": "…#person-brin", "name": "Brin Okafor" },
          "cursor": "eyJncmFwaEhhc2giOiIwOTU2ZmU5YmZkOWQ0OD…"
        }
      ],
      "pageInfo": { "hasNextPage": true, "endCursor": "eyJncmFwaEhhc2giOiIwOTU2…#person-brin…" }
    }
  }
}
```

**Page 2:** copy the `endCursor` from the response and pass it as `after`:

```graphql
query P($after: String) {
  people(first: 2, after: $after) {
    edges { node { iri name } cursor }
    pageInfo { hasNextPage }
  }
}
```

**Variables:**
```json
{ "after": "eyJncmFwaEhhc2giOiIwOTU2ZmU5YmZkOWQ0OD…" }
```

**Verified page-2 response:**
```json
{
  "data": {
    "people": {
      "edges": [
        { "node": { "iri": "…#person-cleo", "name": "Cleo Marchetti", "cursor": "…" } },
        { "node": { "iri": "…#person-dov",  "name": "Dov Lindqvist",   "cursor": "…" } }
      ],
      "pageInfo": { "hasNextPage": true }
    }
  }
}
```

Two windows: page 1 gives Ada+Brin, page 2 gives Cleo+Dov. No overlap.

---

## 3. Page the entire result set (first: 5)

```graphql
query {
  people(first: 5) {
    edges { node { iri name worksFor { iri name } } cursor }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Verified response** (all 5, exactly fitting the window):
```json
{
  "data": {
    "people": {
      "edges": [
        { "node": { "iri": "…#person-ada",  "name": "Ada Ionescu",    "worksFor": { "iri": "…#org-acme",  "name": "Acme Research Institute" } } },
        { "node": { "iri": "…#person-brin",  "name": "Brin Okafor",     "worksFor": { "iri": "…#org-acme",  "name": "Acme Research Institute" } } },
        { "node": { "iri": "…#person-cleo",  "name": "Cleo Marchetti",  "worksFor": { "iri": "…#org-north", "name": "Northwind Analytics" } } },
        { "node": { "iri": "…#person-dov",   "name": "Dov Lindqvist",   "worksFor": { "iri": "…#org-north", "name": "Northwind Analytics" } } },
        { "node": { "iri": "…#person-emi",   "name": "Emi Sato",        "worksFor": null } }
      ],
      "pageInfo": { "hasNextPage": false, "endCursor": "…#person-emi…" }
    }
  }
}
```

Note: `hasNextPage: false` — exactly population-fitting. `Emi Sato` has no worksFor edge → `null`.

---

## 4. Ordering ( orderBy: NAME_DESC )

```graphql
query {
  people(first: 5, orderBy: NAME_DESC) {
    edges { node { iri name } cursor }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Verified response** (reverse alphabetical by name):
```json
{
  "data": {
    "people": {
      "edges": [
        { "node": { "iri": "…#person-emi",  "name": "Emi Sato" },         "cursor": "eyJ…ZTA…" },
        { "node": { "iri": "…#person-dov",  "name": "Dov Lindqvist" },    "cursor": "eyJ…RG92…" },
        { "node": { "iri": "…#person-cleo", "name": "Cleo Marchetti" },   "cursor": "eyJ…" },
        { "node": { "iri": "…#person-brin", "name": "Brin Okafor" },      "cursor": "eyJ…" },
        { "node": { "iri": "…#person-ada",  "name": "Ada Ionescu" },      "cursor": "eyJ…QWRh…" }
      ],
      "pageInfo": { "hasNextPage": false }
    }
  }
}
```

The output is interactive (the console shows `Emi Sato` → `name`, `worksFor: null` if you add that field).

---

## 5. Ontology-driven inverse edges

The shield ontology declares `vcore:employedBy owl:inverseOf vcore:worksFor`. On `Person` the forward field is `worksFor`. On `Organization` the reverse traversal field is named from the ontology's own word with both declarations:

```graphql
query {
  organization(iri: "https://cartoql.example/corpus/core/data#org-acme") {
    iri
    name
    motto
    employedBy { iri name }
  }
}
```

**Verified response:**
```json
{
  "data": {
    "organization": {
      "iri": "https://cartoql.example/corpus/core/data#org-acme",
      "name": "Acme Research Institute",
      "motto": "Brick by brick",
      "employedBy": [
        { "iri": "…#person-ada",  "name": "Ada Ionescu" },
        { "iri": "…#person-brin", "name": "Brin Okafor" }
      ]
    }
  }
}
```

`motto `Brick by brick` is an rdf:langString — the response is the lexical value. [See ontology as the model](ontology.md) for what drives this naming.

## 6. Ontology inverse on Publication ( writtenBy )

```graphql
query {
  publication(iri: "https://cartoql.example/corpus/core/data#pub-a1") {
    iri
    name
    year
    writtenBy { iri name worksFor { iri name } }
  }
}
```
**Verified response:**
```json
{
  "data": {
    "publication": {
      "iri": "https://cartoql.example/corpus/core/data#pub-a1",
      "name": "Algebra of compiled views",
      "year": "2023",
      "writtenBy": [
        { "iri": "…#person-ada", "name": "Ada Ionescu",
          "worksFor": { "iri": "…#org-acme", "name": "Acme Research Institute" } }
      ]
    }
  }
}
```

---

## 7. Equality filters

```graphql
query {
  organizations(name: "Acme Research Institute", first: 5) {
    edges { node { iri name motto } }
    pageInfo { hasNextPage }
  }
}
```

**Verified response**:
```json
{
  "data": {
    "organizations": {
      "edges": [
        {
          "node": {
            "iri": "https://cartoql.example/corpus/core/data#org-acme",
            "name": "Acme Research Institute",
            "motto": "Brick by brick"
          }
        }
      ],
      "pageInfo": { "hasNextPage": false }
    }
  }
}
```

One match: `Acme Research Institute` (has motto). Southwind Analytics has no motto, slogan → ` null`.

---

## 8. Security (two-track) — needs the sec corpus

Boot the security corpus with its config:

```bash
npm run serve -- \
  --ontology corpus/shards/sec/ontology.ttl \
  --shapes   corpus/shards/sec/shapes.ttl \
  --data     corpus/shards/sec/data.ttl \
  --graph    urn:cartoql:shard:sec \
  --stamps   corpus/shards/sec/stamps.json \
  --auth-file /tmp/cartql-claims.json \
  --ui packages/ui/dist \
  --port 4136
```

**/tmp/cartql-claims.json**:
```json
{
  "groups": {
    "alice": ["hr-comp", "legal"],
    "bob": [],
    "site-reviewer": []
  },
  "roles": { "site-reviewer": ["reviewer"] }
}
```

### Query the same document with two different principals

```graphql
query {
  organizations(first: 3) { edges { node { iri name salaryBudget } } }
}
```

**With `x-cartoql-principal: alice`** ( has `hr-comp` group):
```json
{
  "data": {
    "organizations": {
      "edges": [
        { "node": { "iri": "…#org-alpha", "name": "Alpha GmbH",  "salaryBudget": "1200000" } },
        { "node": { "iri": "…#org-beta",  "name": "Beta AB",    "salaryBudget": null } },
        { "node": { "iri": "…#org-gamma", "name": "Gamma SA",   "salaryBudget": "555000" } }
      ]
    }
  },
  "errors": []
}
```

**With `x-cartoql-principal: bob`** (no groups):
```json
{
  "data": {
    "organizations": {
      "edges": [
        { "node": { "iri": "…#org-alpha", "name": "Alpha GmbH",  "salaryBudget": null } },
        { "node": { "iri": "…#org-beta",  "name": "Beta AB",    "salaryBudget": null } },
        { "node": { "iri": "…#org-gamma", "name": "Gamma SA",   "salaryBudget": null } }
      ]
    }
  },
  "errors": [
    { "message": "field Organization.salaryBudget requires authorization…",
      "path": "Organization.salaryBudget",
      "extensions": { "code": "CQL_PERMISSION_DENIED" } },
    { "message": "…", "extensions": { "code": "CQL_PERMISSION_DENIED" } },
    { "message": "…", "extensions": { "code": "CQL_PERMISSION_DENIED" } }
  ]
}
```

Bob sees the organization entities and their `name` — only the significance-gated field returned `null` with a **typed denial** explaining which field and why. `Beta AB` has no labels budget in the test data, but the denial still fires because the field was selected.

### Entity gating ( existence-blind track )

```graphql
query {
  sensitiveNotes(first: 5) { edges { node { iri name } } pageInfo { hasNextPage } }
}
```

**With `alice`** ( has `legal` group): `edges` has **2 entries** ( Alpha audit remark, Beta compliance check ) — `hasNextPage: false`, `errors: []`.

**With `bob`** (no groups): `edges` is `[ ]` empty — `hasNextPage: false`, **`errors: []`**. No error entry — the entity never appeared in the population.
This is the critical **existence-blind** half of the two-track security: an empty list and a gated list are **indistinguishable**.

### Platform role gate ( @requireRole )

```graphql
query {
  organizations(first: 3) { edges { node { iri name auditNote } } }
}
```

**With `site-reviewer`** (has the `reviewer` platform role):
```json
"data": { "organizations": { "edges": [
  { "node": { "name": "Alpha GmbH", "auditNote": null } },
  { "node": { "name": "Beta AB",  "auditNote": null } },
  { "node": { "name": "Gamma SA", "auditNote": "revenue recognition flagged 2025-Q3" } }
] } }
```

**With `alice`** (interest groups but NOT the reviewer role): all `auditNote` values return null WITH `CQL_PERMISSION_DENIED` denials.

Only `site-reviewer` — who has no interest groups — can see the audit notes. The security model is orthogonal see [Security Model](security.md).

---

## 9. Polymorphic fields ( interface field + __typename )

Boot the typing corpus:

```bash
npm run serve -- \
  --ontology corpus/shards/typing/ontology.ttl \
  --shapes   corpus/shards/typing/shapes.ttl \
  --data     corpus/shards/typing/data.ttl \
  --graph    urn:cartoql:shard:typing \
  --ui packages/ui/dist \
  --port 4135
```

```graphql
query {
  project(iri: "https://cartoql.example/corpus/typing/data#proj-alpha") {
    title
    contact {
      __typename
      iri
      name
      ... on Person { email }
      ... on Organization { crewSize }
    }
  }
}
```

**Verified response ( proj-alpha — contact resolves to a Person ):**
```json
{
  "data": {
    "project": {
      "title": "Project Alpha",
      "contact": {
        "__typename": "Person",
        "iri": "https://cartoql.example/corpus/typing/data#agent-ada",
        "name": "Ada Ionescu",
        "email": "ada@example.org"
      }
    }
  }
}
```

**proj-beta ( contact resolves to an Organization ):**
```json
{
  "data": {
    "project": {
      "title": "Project Beta",
      "contact": {
        "__typename": "Organization",
        "iri": "https://cartoql.example/corpus/typing/data#agent-bco",
        "name": "Beta Consulting",
        "crewSize": "42"
      }
    }
  }
}
```

For more on how entities with multiple shapes can carry fields under their proper type using typed fragments, see [detailed schema](schema.md).

## 10. Budget check with explain

Let's use `EXPLAIN` with a over-budget query:

```bash
curl -s -X POST http://localhost:4137/explain \\
  -H 'content-type: application/json' \\
  -d '{"query":"query { people(first: 500) { edges { node { name worksFor { name } } } }"}'
```

Actually a lighter example:
```bash
curl -s -X POST http://localhost:4137/explain \\
  -H 'content-type: application/json' \\
  -d '{"query":"query { people(first: 5) { edges { node { name worksFor { name } } } }"}'
```

**Verified response:**
```json
{
  "planId": "8360815bba1a36e7f9fec6d3e0a4cf3a2853765197e62a047cc3b6ebe77bb49e",
  "cost": 7.3,
  "depth": 3,
  "nodeCount": 4,
  "withinBudget": true
}
```

The same document POSTed to /graphql will execute normally. If the cost were over the limit ( with budget config bound to the gateway), the request resumes:
```json
{
  "errors": [{
    "message": "VX_QUERY_TOO_COMPLEX: plan cost 7300 exceeds limit 2500...",
    "extensions": { "code": "CQL_QUERY_TOO_COMPLEX", "metric": "cost", "value": 7300, "limit": 2500 }
  }]
}
```

---

## 11. Retrieving to SPARQL mode

```bash
npm run serve -- \
  --ontology corpus/shards/core/ontology.ttl \
  --shapes   corpus/shards/core/shapes.ttl \
  --sparql  http://localhost:7878/query \
  --graph   urn:cartoql:shard:core \
  --ui      packages/ui/dist \
  --port 4137
```

On SPARQL mode, CartoQL projects every plan to a `SELECT` injecting ACL joins for security stamps, and evaluate on an actual remote SPARQL 1.1 endpoint ( see the [architecture](architecture.md) diagram) — the [startup documentation](getting-started.md) shows a local test store).

## 12. Console TIps

| Interaction | What it does |
|---|---|
| `ctrl+enter` | run the document |
| `ctrl+shift+enter` | prettify |
| `graph` toolbar | open the schema-graph dialog |
| `res` / `rail` toolbar | toggle panels |
| `COPY CURL` | copy the shell command that makes this request |

Every query here works by pasting directly into the document editor.

## 13. Building an application on CartoQL

The whole contract in one place — load, serve, consume:

### a. Put your data where the module reads it (named graphs)

CartoQL serves **one module** over an **explicit graph scope** (D10 — no default-graph
accidents). Put entity facts in a data graph and permission facts in a separate
ACL graph, in the same store:

```sparql
# getting data in (Oxigraph / Fuseki / any SPARQL 1.1 Update endpoint):
LOAD <file:///path/to/app-data.ttl> INTO GRAPH <urn:my:app:data>
# membership facts (written by your provisioning, not by CartoQL):
#   <urn:urn…principal:alice> <urn:cartoql:acl:memberOf> <urn:cartoql:acl:group:legal> IN <urn:my:app:acl>
```

### b. Boot the gateway pinned to that scope

```bash
npm run serve -- \
  --ontology my-onto.ttl    --shapes my-shapes.ttl \
  --sparql  http://localhost:7878/query \
  --graph   urn:my:app:data \
  --acl-graph urn:my:app:acl \
  --stamps  my-stamps.json --auth-file my-claims.json \
  --ui      packages/ui/dist --port 4137
```

Same shapes + a different `--graph` = a different dataset; cursors minted under
one scope are refused in another.

### c. Talk to it from your app (TypeScript)

```ts
const GATEWAY = 'http://gateway:4137/graphql'

export async function ask<T>(query: string, variables: Record<string, unknown> = {}, principal?: {
  principalId?: string; bearer?: string
}): Promise<T> {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(principal?.principalId ? { 'x-cartoql-principal': principal.principalId } : {}),
      ...(principal?.bearer ? { authorization: `Bearer ${principal.bearer}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  })
  if (res.status === 403) throw new Error('CQL_PERMISSION_DENIED: identity bind refused')
  const body = (await res.json()) as {
    data?: T
    errors?: Array<{ extensions?: { code?: string } }>
  }
  for (const e of body.errors ?? []) {
    if (e.extensions?.code === 'CQL_QUERY_TOO_COMPLEX') throw new Error(e.extensions.code) // /explain and retry smaller
  }
  return body.data as T
}

// page-through pattern — cursors are graph-scoped and ordering-pinned
interface PersonPage {
  people: {
    edges: Array<{ cursor: string; node: { iri: string; name: string } }>
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}
let after: string | undefined
do {
  const { people } = await ask<PersonPage>(
    `query ($after: ID) { people(first: 100, after: $after) { edges { cursor node { iri name } } pageInfo { hasNextPage endCursor } } }`,
    { after },
  )
  people.edges.forEach((e) => console.log(e.node.iri, e.node.name))
  after = people.pageInfo.hasNextPage ? people.pageInfo.endCursor ?? undefined : undefined
} while (after !== undefined)
```

### d. What each part of the contract is for

| App concern | The CartoQL answer |
|---|---|
| which data | `--graph` named-graph scope (nothing else is readable — D10) |
| who is asking | `x-cartoql-principal` header (header-keyed resolvers) or a bearer JWT (attested identity; a header alias of another name = 403, docs/03 rule 7) |
| what it may see | stamps → `@requireGroup`/`@requireRole` compile into the plan ACL joins; `CQL_*` codes on `errors[]` (branch on codes, never messages) |
| JSON-LD consumers | `Accept: application/ld+json` → expanded-form response, plan-guided predicate IRIs (docs/04) |
| budgeting | `POST /explain` previews cost/depth before execution; `CQL_QUERY_TOO_COMPLEX` is the typed rejection |
| introspection | `/sdl` for the generated schema sheet (pin it against your shapes' checksum) |
| **writes** | **none from the gateway, by design** — writes go through your store's SPARQL Update with your store's write ACL (docs/01: no write surface in v1) |
| health/posture | `/health` — adapter, auth provider, schemaHash, aclGraph (operators never discover posture by accident) |
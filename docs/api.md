# HTTP API

The gateway is an HTTP server. Every surface is CORS-enabled, versioned, and accepts a `x-cartoql-principal` header for the requesting identity.

## POST /graphql

Runs a GraphQL document.

```bash
curl -s -X POST http://localhost:4137/graphql \\
  -H 'content-type: application/json' \\
  -H 'x-cartoql-principal: alice' \\
  -d '{"query":"query { person(iri: $iri) { iri name worksFor { iri name } } }",
       "variables":{"iri":"https://cartoql.example/corpus/core/data#person-ada"}}'
```

### Response

```json
{
  "data": { "person": { "iri": "...", "name": "Ada Ionescu", "worksFor": { ... } } },
  "errors": []
}
```

On a rejection ( over-budget, validation error, denied ), errors carry typed `CQL_*` extension codes -- see [Error Codes](errors.md).

## POST /explain

Compiles the document and previews its cost without executing:

```bash
curl -s -X POST http://localhost:4137/explain \\
  -H 'content-type: application/json' \\
  -d '{"query":"query { people(first: 5) { edges { node { name worksFor { name } } } }"}'
```

```json
{
  "planId": "83608...",
  "cost": 7.3,
  "depth": 3,
  "nodeCount": 4,
  "withinBudget": true
}
```

## GET /sdl

The compiled schema as SDL text. The console uses this to populate the schema rail, autocomplete, and graph dialog.

## GET /health

```json
{
  "status": "ok",
  "adapter": "reference (...)",
  "auth": "static",
  "schemaHash": "1653e...",
  "aclGraph": null
}
```

## GET /metrics

Prometheus exposition. Toggle with `--metrics off` or the `observability` section of `cartoql.json`.

## GET /playground

A lightweight single-prompt interface ( no editor ) served at `/playground`.

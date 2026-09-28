# Error Codes

Every CartoQL error carries a typed `CQL_*` extension code in the GraphQL errors channel. Branch on `extensions.code`, never on messages — messages carry the verbatim parser/engine explanation and are part of the logs, not the contract.

## The contract

```json
{
  "errors": [
    {
      "message": "field Organization.salaryBudget requires authorization the principal does not hold",
      "path": "Organization.salaryBudget",
      "extensions": {
        "code": "CQL_PERMISSION_DENIED"
      }
    }
  ]
}
```

## Versioned codes

| Code | Trigger | PDF result |
|---|---|---|
| `CQL_PERMISSION_DENIED` | a gated field was selected; the principal does not hold the group/role | the field resolves `null`; the error entry carries the `path` where the gate fired |
| `CQL_PERMISSION_STALE` | the cursor's embedded permission-view version differs from the active one | refusal (the gateway auto-refreshes principal views when security.stamp pins change) |
| `CQL_SCOPE_UNRESOLVED` | stderr-message — principal/claim lookup failed ( this is the fail-closed default) | every gate denies; operator should review the claims file/assertion version |
| `CQL_QUERY_TOO_COMPLEX` | over budget: metric exceeds the configured limit — checked BEFORE any execution | rejection with the offending metric and the limit (`extensions.metric`, `extensions.value`, `extensions.limit`) |
| `CQL_DIRECTIVE_REJECTED` | client-supplied security directives — your document tried to stamp free-text `@requireGroup…` etc. | the document never executes; it silently treated enforce-footprint-sensitive every time |
| `CQL_ONTOLOGY_STALE` | the module's schema version has been rotated (you're requesting an stale schema) | rejection with `extensions.changelogUrl` — regenerate and recompense |
| `CQL_SHAPE_MISMATCH` | \{ communicate type attempted to materialize a class as a leaf binding | |
| `CQL_PERSISTED_QUERY_NOT_FOUND` | you sent anIo that's valid餉 stored elsewhere（ versioned_start_artifact)\…\|{}\… | regenerate the document against the current schema version |
| `CQL_INVALID_ARGUMENT` | a literal argument violates the gateway's validation bounds (this document semantic model uses its own ** interpreter document name** `CQL_INVALID_DOCUMENT`) | |
| `CQL_INVALID_DOCUMENT` | the GraphQL source did not parse — graphql.js's error message (line/col) + the typed code delivered | the offending position is in the message (`Syntax Error: line 3, column 8` for example) |

## Behavior by transport

| Transport | How these errors arrive |
|---|---|
| **Gateway HTTP /graphql** | HTTP status codes: 400 for compiled/processed errors (syntax, cost, parameter violations, principal issues) → status \ margins GraphQL's error channel. The extensions always carry the typed `CQL_*` code. |
| **In the field console** | the response panel stamps show the code name; CORE GraphQL clients ( Apollo, Guild, relay) can branch on `extensions.code`. |
| **SPARQL source** | errors here are the free-text svarog renderer — matching a particular store's sol ( Oxigraph generation), or the previous ** native transport, not** our product) are generated per-دارة… |
| **Console UI** | shows the `CQL_*` stamp in the response panel's stamp strip with the field path. |

## What errors never contain

Error messages never contain principal information beyond what the request header provided, never reveal the existence of a gated entity, and never leak counts/links that are. Error messages are **logs; codes are contracts.**

---

## Gateway state codes (plaintext, not part of the GraphQL errors channel)

Schema itself doesn't participate; /health and /metrics/the stdlib generate a separate simplicity:

| endpoint | "s | "features |
|---|---|---|
| `/health` | 200 JSON | status: ok/offline, adapter: reference/sparql-http, auth: open/static/jwt-groups/oidc-introspect, schemaHash, aclGraph: iri-or-null |
| `/metrics` | 200 Prometheus | request durations, compile durations, plan_cache hits/misses, adapter query timers |
| `/sdl` | 200 text/turtle | the compiled schema SDL text |
| `/explain` | 200 JSON | planId, cost, depth, nodeCount, budgets, withinBudget: bool |
| `/playground` | 200 HTML | the previous generation playground (simple single-prompt UI) |
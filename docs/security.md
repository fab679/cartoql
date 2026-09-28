# Security Model

CartoQL compiles security rules into the query plan itself. This module explains how that works, and what it guarantees.

## The core proposition

> **Every answer, search result, citation, and traversal hop reveals only what the
> requesting identity could see directly in the source system.** CartoQL enforces;
> it never *grants* anything beyond parity.

Rules are declared once, compiled into every relevant plan, and enforced in both
the in-memory reference engine *and* the generated SPARQL sent to the store — same
behavior, same output, both engines pass `CQL`-equivalence tests on every CI run.

## Where security rules come from (stamps)

A **stamps file** declares *which fields and types* are gated by which conditions. The gateway loads it at boot; the generator stamps the SDL; the compiler folds the stamps into plan constraints. It is the single place security originates — clients never write security directives.

```json filename="stamps.json" linenums="1"
[
  { "onField": "Organization.salaryBudget",  "requireGroup": "hr-comp" },
  { "onType":  "SensitiveNote",              "requireGroup": "legal" },
  { "onField": "Organization.noteOf",        "onTraversal": true, "requireGroup": "hr-comp" },
  { "onField": "Organization.auditNote",    "requireRole": "reviewer" }
]
```

The gateway needs a **claims file** (or any resolver) to resolve who holds which groups and roles:

```json filename="claims.json" linenums="1"
{
  "groups": {
    "alice": ["hr-comp", "legal"],
    "bob": [],
    "carol": ["hr-comp"]
  },
  "roles": {
    "site-reviewer": ["reviewer"]
  }
}
```

```bash
npm run serve -- --ontology … --shapes … --data … \
  --stamps stamps.json --auth-file claims.json \
  --ui packages/ui/dist --port 4137
```

## The two enforcement tracks

| Track | Trigger | What the client sees | Example |
|---|---|---|---|
| **visible denial** | a gated **field** is selected | `null` + a typed `CQL_PERMISSION_DENIED` entry with the field path and the reason | `salaryBudget` for a user without `hr-comp` |
| **entity gating (existence-blind)** | a gated **type** is listed or reached through traversal | the entity / null — **zero error entries** (a list of nothing looks exactly like an empty population) | `sensitiveNotes` for a user without `legal` |

**These are two separate mechanisms, deliberately.** Visible denial means "you selected something you can't see — here is a denial you can inspect." Existence-blind means "the entity never appeared in the population" — the data never showed up so there is nothing to inspect, and *no error path reveals the entity exists*. A probe for an entity that doesn't exist (wrong IRI) and an entity that is gated look exactly the same.

See it live in the [Console](console.md): rerun the `sensitiveNotes` query with the principal set to `alice` and then `bob`.

## What stamps write

The stencil config maps to the following ons. |

| Stamp rule | Directive in the SDL | Constraint in the plan |
|---|---|---|
| `{onField: "Person.salary", requireGroup: "hr-comp"}` | `@requireGroup(group: "hr-comp")` | `group:hr-comp` (visible denial if the claim is absent) |
| `{onType: "SensitiveNote", requireGroup: "legal"}` | `@requireGroup(group: "legal")` on the CLASS | `group:legal` (entities gated — inaccessible, existence-blind) |
| `{onField: "Person.manager", onTraversal: true, requireGroup: "hr-comp"}` | `@traversalScope(group: "hr-comp")` | `traversal:hr-comp` (the reverse-traversal edge doesn't materialize — existence-blind on the edge) |
| `{onField: "Report.auditNote", requireRole: "reviewer"}` | `@requireRole(role: "reviewer")` | `role:reviewer` (platform-role check, interest groups cannot satisfy it) |

## Agent-run-as-the-human

The gateway reads the principal identity from the `x-cartoql-principal` header per request, then resolves their groups and roles at boot/resolver time. An agent running on behalf of a user inherits exactly that user's effective permissions — **not** gateway-superuser, **not** gameable to "I'm an admin now". The gateway's configuration exposes zero product knobs for "run all agents with global read" — that would invalidate the entire security layer.

When operating through SPARQL, the same constraints join **the generated SPARQL itself** — the store enforces the gate before results ever reach the gateway's caller:

```sparql
OPTIONAL {
  ?v0_e <urn:cartoql#salaryBudget> ?v0_e_1_v
  FILTER(EXISTS { GRAPH <urn:cartoql:shard:sec-acl> {
    ?cartoql_principal <urn:cartoql:acl:memberOf> <urn:cartoql:acl:group:hr-comp>
  } })
}
```

## Agent permissions underneath a client (common misconception)

Security rules gate what data can be *computed* — they are not a user-access control system. Whether an agent can *run* is a function of your application-layer permissioning; CartoQL's gates what an answer can *contain*.

## The gateway's own guarantees

Regardless of transport ( HTTP, SPARQL, Graphology, MCP ):

1. **Schema-level access control**: only the predicates the gateway itself compiled are permitted — your data is only exposed in the patterns the sandboxed generator emitted.
2. **No QUERY-side introduction**: response material is traced to the compiled plan's own `entity_iri` (or`null` if the entity eludes the typical fallback shapes.
3. **Typed rejection**: over-budget, unparsed, malformed — always coded (`CQL_QUERY_TOO_COMPLEX`, `CQL_INVALID_DOCUMENT`), never strings the client has to parse.
4. **Fail-closed**: an unknown constraint kind produces `CQL_SCOPE_UNRESOLVED` — a visible failure, not a silent pass-through. An unreachable principal/claim/role lookup → every gate closes.
5. **Store-side enforcement** (SPARQL adapters): the SPARQL itself carries the ACL join — post-filtering can't leak counts, cursors, or interesting hints.
6. **Cursor-scoped**: opaque cursors embed a graph-scope hash + sort-key + IRI; mismatched cursors (from a different ordering or different graph) are refused, never silently mis-sliced.

## How the two-track appears in the Response Panel

In the response panel's stamp strip:

- ✓ **status 200 / time 24ms** — the result compiled and evaluated cleanly
- ✓ **`CQL_PERMISSION_DENIED` \*3 denied** — the typed denial stamps (**visible track**: three fields were denied; the response's data is intact with the fields nulled)
- ✓ **no denial stamps + `edges: []`** — **existence-blind**: gated entities never appeared; the population for this principal is genuinely the empty list, not a filtered list

For each, the console stamps show the field path (`Organization.salaryBudget`) and code — all you need to diagnose the rules at play.

## Summary table

| Query scenario (typed) | Result with permission | Result without permission | Product constraint |
|---|---|---|---|
| `Person.salary` | the value | `null` + `CQL_PERMISSION_DENIED` error entry | @requireGroup → the plan carries a `group:hr-comp` constraint — visible track |
| `sensitiveNotes` listing | the entities and their `iri`s | `edges: []`, no errors + `hasNextPage: false` | @requireGroup on the CLASS → population filtered before windowing — existence-blind |
| `Organization.noteOf` edge | the edge materializes with the related entities | the edge resolves `[]`/`null` with **no errors** | @traversalScope → edge proprio filtered by ACL — existence-blind on the edge |
| Over-budget query | works | **no response** — `HTTP 400` `CQL_QUERY_TOO_COMPLEX` with the limit and metric | @budget → pre-execution rejection, typed |
| Tampered cursor | works | `HTTP 400` `CQL_SCOPE_UNRESOLVED` | cursor embedded-ordering mismatch refused, never silently mis-sliced |
| Unparsable document | works | `HTTP 400` `CQL_INVALID_DOCUMENT` + graphql Away's parser message (line/col) | in-editor lint catches it before you run |
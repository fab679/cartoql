# 07 — Security, Tenancy & Privacy

Data isolation is the platform's trust boundary and its sellable differentiator. It is
designed first and changed last: every other architectural mistake is refactorable,
but re-earning trust after an isolation failure is not. This document defines the
models precisely because sales, compliance, and engineering all quote from it.

## Isolation tiers

Three deployment tiers, sold as distinct product levels. The architecture is
**tenant-separable at the deployment level** even when running logically shared —
each tier is a placement decision, not a re-architecture.

| Tier | Name | What's shared | Target customer | Notes |
|---|---|---|---|---|
| T1 | **SaaS shared-logical** | compute+storage cluster; tenants = separate graphs/namespaces, separate encryption scopes | SaaS-native companies | Default tier; gateway-enforced routing; per-tenant keys |
| T2 | **Dedicated instance** | nothing at runtime; shared control plane (billing, fleet ops) | mid-market, light-regulated | Same charts, single-tenant graph+vector+store bundle |
| T3 | **VPC / on-prem** | nothing of ours except the software; their network, their keys, their LLM contracts (including model choice) | finance, healthcare, government | Air-gap-friendly: local extractor-only mode, client-hosted models |

**Rules:**
- Code addresses everything by `<tenant>/...` IRIs and `tenant_id` scoping — no tier
  has a different query path.
- Promotion between tiers is a deployment action, never a data migration with manual
  SQL; this is CI-tested by standing up a T1 tenant and promoting it to T2 in a pipeline.
- Tie-breaker on any design review that could weaken isolation: **fix the design.**

## Identity

- **Human users authenticate via the client's IdP**: SAML/OIDC SSO; SCIM 2.0 for
  provisioning/deprovisioning (deprovisioning is a same-day security event: sessions
  revoke, keys disable, audit entries remain).
- **Group/role data is sacred**: groups synced from the IdP (and from source ACLs) drive
  permission resolution ([permissions](#the-permission-model)); we treat them as
  security-critical data, not directory decoration.
- **Principals are per-tenant**: a user existing in two tenants is two principals;
  nothing joins them, including our own logs' analytics paths.
- **Service identities**: client applications get API keys/OAuth clients bound to
  (service account → explicit effective-identity) with their own permission class
  (see API plane).

## The permission model

**Permission parity** is the core security guarantee:

> Every answer, search result, citation, and traversal hop reveals only what the
> requesting identity could see directly in the source system. KMap enforces; it never
> *grants* anything beyond parity.

### Source-side (what we ingest)

ACLs are extracted with the data — Postgres RLS policies and grants, SharePoint
item-level permissions, Jira issue visibility, file ACLs ([05](05-ingestion-plane.md#connectors-and-sync)).
They resolve into tenant ACL graphs (`<tenant>/acl/{source}`, [06](06-semantic-infrastructure.md#graph-store-layout-per-tenant))
mapping **principal → permission → resource**, versioned with sync.

Statements get visibility metadata at publication: `kmap:readableBy` (concrete
principals/groups) and `kmap:visibilityPolicy` (e.g., "owner's group", "public within
tenant") so re-evaluation is possible when groups change without re-syncing content.

### Platform side (how it's enforced)

1. **Effective permission resolution** — at request time, the gateway computes the
   user's effective identity: direct user, group memberships (IdP + source ACLs),
   tenant roles. Cache with versioning: invalidated by ACL-version bump — a sync that
   changed access triggers warm re-resolution proactively for *active* users.
2. **Query-time join, not output filtering** — every SPARQL/GraphQL/vector query gets
   the permission constraint injected into the plan. This prevents the classic
   side-channel: an aggregate, traversal, or estimated-row style interaction leaking
   the existence of invisible data. Absence must be indistinguishable from
   non-existence.
3. **Traversal hop parity** — graph traversal expands a relationship only if the *edge
   itself* is visible; an entity node reachable only through hidden edges stays
   hidden. Connections and explanation queries run under the same rule — `explain_path`
   never includes hidden-hop legs in its result set.
4. **Agents run as the human, never as the platform.** An agent acting on behalf of a
   user inherits exactly that user's effective permissions. **Agents never have
   tenant-sudo.** There is deliberately no "agent service account with global read"
   product configuration — it would invalidate permission parity.
5. **Admin ≠ reader.** Tenant admins manage sources/queues/budgets and see audit,
   but reading business facts still goes through their own effective permissions.
6. **Universal fallback: fail closed.** Anything unresolvable (unknown principal,
   ACL sync stale beyond SLA, evaluation error) is *denied* by default, logged, surfaced
   to platform health.

### Verification

- **Permission test suite**: each tenant carries declarative fixtures of
  `user X must/must-not see Y` covering every connected source, run on every deploy
  and after every ACL sync event. Written during Pilot (client Stage 2), executed
  forever. Failing fixtures block releases.
- **Quarterly negative-probe audit**: synthetic probes (data only certain groups
  should see) probed through agent, API, and admin paths; any leak page is a Sev-1.

## Encryption & key management

- In transit: TLS 1.2+/1.3 everywhere, internal service mesh mTLS.
- At rest: platform-managed keys per tenant (envelope encryption); **BYOK** at T2/T3
  (client KMS, e.g., CloudKMS/Vault); ideally *each tenant's* key never decrypts
  another's data even at T1 (scoped keys per tenant namespace rather than one
  platform-wide DEK).
- Secrets: external vault with scoped service identities; rotation automated;
  source credentials are *always* client-scoped read-only, audited quarterly.
- Tenant deletion (offboarding): cryptographic erasure of tenant DEK-scope, plus
  documented deletion job through stores ([06](06-semantic-infrastructure.md#operational-guarantees--values)),
  plus a signed deletion certificate. Not conditional on ticket memory.

## Audit & monitoring

- **Append-only audit log** (control store) of: every retrieval with query shape +
  actor + result summary, every agent action (tool, args, result summary), every
  admin action, every ontology change/review decision, every webhook emit.
- Each record: actor identity, tenant, timestamp, permission version used, source
  versions visible at answer time.
- **Tenant-exportable**: clients can pull their audit trail at any time
  (compliance self-serve is a selling point).
- Anomaly detection: impossible-travel logins, unusual volume read, repeated
  denied-permission hits (enumeration probes), source-credential failures.
- Platform security telemetry segmented by tenant; **no cross-tenant analytics on
  content**, only fleet-level operational metrics in aggregate.

## subprocessors & data boundaries

Declared list in every enterprise agreement; current notable one:

- **LandingAI (document extraction, v1)**: used only for tenants whose trust posture
  permits; under **Zero Data Retention** mode (fetched results revoked immediately;
  unfetched expire within 24-48h) and **EU-endpoint residency options**. Tenants that
  disallow it get the local extraction stack inside their boundary — the
  `DocumentExtractor` abstraction ([05](05-ingestion-plane.md#documents--landingai-ade-behind-documentextractor))
  exists precisely so the trust posture is per-tenant configuration.

Model providers follow the same matrix: client-hosted models or platform-pinned ones
per contract; contracts never share model contexts across tenants (no cross-tenant
prompt-cache sharing, per-provider feature disable or routing tiering).

## Compliance roadmap commitments

| When | Commitment |
|---|---|
| Pilot phase | security questionnaire pack; DPA template; subprocessor list |
| End of v1 (month ~6) | SOC 2 Type I; pen test by an external firm; GDPR DPA live |
| v2 window (month ~16) | SOC 2 Type II (evidence collected continuously since v1, not backfilled); ISO 27001 initiation; HIPAA BAA readiness if a healthcare design partner exists |

## Security engineering practices

- SDLC: threat model per new plane; security review of permission-adjacent PRs is
  mandatory
- Quarterly access reviews (human access + service credentials)
- Least-privilege service accounts (every internal service gets its own spiffe-style
  identity — no shared "backend" role)
- 90-day key rotation (client credentials included, with support for zero-downtime rotation)
- Incident response: severity ladder (leak = Sev-1), 24h client notification standard,
  quarterly incident tabletop exercise
- Tenant pentest opt-in (clients may test their own tenant)

## What this layer guarantees, verbatim (for the sales deck and the contract appendix)

1. **Isolation as sold**: data stays inside the promised tier boundary.
2. **Permission parity**: no answer, search result, or connection reveals data the
   requester's own source-system rights wouldn't.
3. **Fail closed** on any unresolvable access decision.
4. **Audited** retrieval: no read happens without a corresponding audit entry.
5. **Deletion and export** work as contractual obligations with receipts.
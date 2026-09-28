# Contributing to CartoQL

Thank you for considering a contribution. This is a **spec-first** project: the
documents in [`docs/`](docs/) are the contract, and behavior changes land only after
the spec changes.

## Ground rules

1. **Spec before code.** Any change affecting the directive registry, error codes,
   enforcement rules, or versioning semantics requires a documentation PR merged
   *before* (or bundled with, clearly marked) the implementation PR.
2. **One execution artifact.** The compiled plan is the only thing that runs. PRs
   introducing resolver-level data access, per-adapter policy lookups, or
   "temporary" escape hatches will be closed regardless of how urgent the use case
   feels — this is the project's core security property.
3. **Directives are enforcement points, never grants.** New directives go through
   the parking-lot review in [docs/03-directive-spec.md](docs/03-directive-spec.md#parking-lot-proposed-not-in-v1--needs-design-review):
   leak analysis, cost semantics, and a deprecation path *at birth*.
4. **Fail-closed is tested, not asserted.** Security-relevant PRs must add fixtures
   to the testkit corpus — denial cases *and* existence-blindness cases (probe paths
   must be indistinguishable from empty results).
5. **Apache-2.0 with patent grant:** by contributing you agree your contributions
   are licensed under the project license.

## Practical process

- Bug reports: include store/adapter, SDL module versions, error code (never just
  the message), and a minimal document if possible.
- Feature proposals: open a discussion issue first; expect it to be routed to the
  spec docs before implementation.
- All commits pass CI: fixture corpus, adapter parity tests (where applicable),
  and doc linting (this README bundle is checked against the tables in `docs/03`).
- Be kind; be concise; assume everyone here cares about query plans more than is
  strictly normal.
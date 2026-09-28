# Security Policy

CartoQL's core value is security compilation; security reports are treated as
first-class project work, not embarrassment.

## Supported versions

Security fixes are backported to the **last two minor releases** while the project
is pre-2.0. The directive-table and error-code contract follows the security
carve-out in [docs/03-directive-spec.md](docs/03-directive-spec.md#versioning):
a fix for an enforcement-rule violation may land as a patch release.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

- Report privately via GitHub's *Report a vulnerability* facility on this repository
  (Security tab → "Report a vulnerability"), which routes to the maintainers under
  coordinated disclosure.
- Include if possible: component (`core`/`generator`/`gateway`/adapter), a minimal
  document/datasource that reproduces, expected-vs-actual enforcement semantics, and
  which [threat-model row](docs/07-threat-model.md) it matches (or why it doesn't).
- You will get an acknowledgment within 72 hours and a severity assessment within
  7 days.

## Coordinated disclosure

- Default window: **90 days** from confirmation, extended by mutual agreement for
  complex fixes or coordinated multi-adapter releases (a defect in the compiler that
  affects adapter behavior may need synchronized patching).
- CVEs are issued via GitHub Advisories for compiled-artifact vulnerabilities —
  not for embedder misconfigurations (e.g., running standalone mode with a permissive
  resolver and calling it a breach; the docs and README mark that posture explicitly).
- Findings that are really feature requests for the leak-probe corpus (side channels
  we document as out-of-scope, e.g. timing inference against non-cooperating stores —
  see [threat model T10](docs/07-threat-model.md#t10--backend-store-inference-timing--since-m1))
  get routed to the public corpus as fixtures, with credit.

## Safe harbor

Research conducted in good faith — on your own deployments, or against public
reference instances we run (when they exist), respecting service availability — is
welcome and will not be met with legal threats. Don't test against deployments you
don't own or operate without their operators' permission.

## What we test continuously

The public [leak-probe corpus](docs/09-testing-conformance.md#the-leak-probe-corpus-security-fixtures)
in this repository is the standing definition of enforcement behavior: filtering,
probe blindness, count blindness, hidden-edge traversal, cache isolation across
principals, injection, directive forgery, and complexity rejection — run in CI on
every relevant change. If you break one of these, you found a bug, not a feature.
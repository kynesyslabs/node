---
type: discovery
title: Security Scan — 2026-06-02
date: 2026-06-02
status: active
slug: security-scan-2026-06-02
---

# Security Scan — 2026-06-02

Read-only security audit of the Demos Network node. No production code or
configuration is modified by this run; every issue identified is filed as a
finding, not patched.

## Executive Summary

_Placeholder — populated by story S8 (`08-findings-summary.md`)._

- Critical findings: _TBD_
- High findings: _TBD_
- Medium findings: _TBD_
- Low findings: _TBD_
- Informational: _TBD_
- Net-new regressions vs. `DEPS-AUDIT.md` baseline (2026-04-08): _TBD_

Top themes will be summarized here after sub-docs 01–08 are complete. The
authoritative ranked list lives in `08-findings-summary.md`; this section is a
high-level digest only.

## Scope

In-scope:

- Network-exposed surfaces (RPC, OmniProtocol TCP, WebRTC signaling, MCP,
  Prometheus metrics, Compose-exposed services).
- Authentication, authorization, and rate-limiting paths in
  `src/libs/network/`.
- Input validation across RPC dispatch, web2 proxy, TLSNotary, StorageProgram,
  ZK feature routes.
- Dependency vulnerabilities (`bun audit` + `npm audit` cross-check).
- Secrets and default credentials tracked in the repository.
- Docker / Compose hardening, Caddy posture, healthcheck behaviour.
- CI/CD workflow permissions and supply-chain gates.

Out of scope:

- Runtime/operational testing — the node is NOT started during this audit.
- Penetration testing against live infrastructure.
- Cryptographic primitive review of upstream libraries (assume audited
  upstream; only integration is reviewed).
- Modifying production code, configuration, lockfiles, or migrations.

## Table of Contents

| # | Document | Topic |
| --- | --- | --- |
| 01 | [`01-exposed-network-surface.md`](./01-exposed-network-surface.md) | Open ports, bind hosts, route enumeration, CORS/XFF posture |
| 02 | [`02-secrets-in-tree.md`](./02-secrets-in-tree.md) | Tracked secret-like files, default credentials, env hardcoded keys |
| 03 | [`03-dependency-vulnerabilities.md`](./03-dependency-vulnerabilities.md) | `bun audit` / `npm audit` results vs. `DEPS-AUDIT.md` baseline |
| 04 | [`04-authentication-and-authorization.md`](./04-authentication-and-authorization.md) | Signature verification, MCP auth, metrics auth, rate limiter trust-proxy |
| 05 | [`05-input-validation-and-injection.md`](./05-input-validation-and-injection.md) | RPC dispatch, web2 proxy sanitization, TypeORM, FHE/ZK inputs |
| 06 | [`06-docker-and-deployment.md`](./06-docker-and-deployment.md) | Image hardening, volume permissions, Caddy basic-auth, healthchecks |
| 07 | [`07-ci-cd-and-supply-chain.md`](./07-ci-cd-and-supply-chain.md) | Workflow permissions, missing audit gate, secret-handling, lockfile freshness |
| 08 | [`08-findings-summary.md`](./08-findings-summary.md) | Final severity-ranked list with CWE refs and remediation owners |

## Artifacts

Supporting artifacts live under [`./artifacts/`](./artifacts/):

| File | Description |
| --- | --- |
| `bun-audit.json` | Raw `bun audit` snapshot captured during this run |
| `npm-audit.json` | Cross-check `npm audit --omit=dev` snapshot |
| `gitleaks.sarif` | Secret-scan output (SARIF). Treat as sensitive; see redaction rules below |
| `route-table.md` | Every HTTP route enumerated with auth / rate-limit / PII state |
| `exposed-files.txt` | `git ls-files` matches for sensitive name patterns + hexdump signatures |

## Finding ID Scheme

Every finding across the report uses the identifier format:

```
SEC-2026-06-02-NNN
```

- `SEC` — fixed prefix for security findings.
- `2026-06-02` — ISO date of this audit run (matches the directory slug).
- `NNN` — zero-padded, monotonic ordinal (`001`, `002`, …) allocated in the
  order findings are written into the report, across all sub-docs.

Cross-references between sub-files MUST use the finding ID. Do not cite a
finding by `file:line` alone — file/line locations rot when code moves.

## Severity Scale

Findings use exactly this five-tier scale. No new tiers may be introduced.

| Severity | Meaning | CVSS guidance |
| --- | --- | --- |
| `critical` | Trivially exploitable, immediate impact (RCE, key compromise, auth bypass on a network-exposed path). | 9.0–10.0 |
| `high` | Exploitable with constrained prerequisites or significant impact (privilege escalation, data leak on default config). | 7.0–8.9 |
| `medium` | Requires non-default conditions or has bounded impact (info disclosure, DoS via specific input). | 4.0–6.9 |
| `low` | Defence-in-depth gaps, hardening opportunities, low-impact misconfig. | 0.1–3.9 |
| `informational` | No direct security impact; documentation, hygiene, or future-risk notes. | — |

Map to CVSS where applicable. Severity is a header field on every finding;
mapping rationale belongs in the finding body.

## Finding Template

Every finding written in sub-docs 01–07 (and aggregated in 08) uses this
header block, then free-form body:

```markdown
### SEC-2026-06-02-NNN — <short title>

- **Severity**: critical | high | medium | low | informational
- **CWE**: CWE-XXX (optional, when a clear mapping exists)
- **Component**: <feature / module / file path>
- **Status**: open
- **Requires human review**: true | false

<Body — observation, evidence, impact, recommended remediation.>
```

## Conventions and Constraints

- **Read-only run**: no files outside `docs/discoveries/security-scan-2026-06-02/`
  are modified. No `package.json`, `bun.lock`, `.env`, `Dockerfile`,
  `docker-compose*.yml`, migrations, or production source.
- **Do not run the node**: no `npm run start`, no `docker compose up`. Static
  analysis and read-only commands only. `bun audit` / `npm audit` are fine.
- **Redact secrets**: if `gitleaks` flags real-looking material, record only
  the first 8 characters and the byte length. Full values stay in the local
  SARIF artifact; do not paste them into markdown.
- **Fixture-key safety**: `testing/devnet/l2ps/live_local_001/private_key.txt`
  is a known fixed test vector. Verify, document, and do NOT delete. If
  fixture status is uncertain, flag `severity: critical` and
  `requires-human-review: true`.
- **Baseline comparison**: `DEPS-AUDIT.md` (2026-04-08) reports Total 85 /
  Critical 3 / High 47 / Moderate 26 / Low 9. Any increase since that date is
  treated as a regression and flagged separately from pre-existing items in
  `03-dependency-vulnerabilities.md`.
- **No new tooling**: this run does not add ESLint plugins, Snyk, Semgrep,
  Trivy, Grype, or any new dev dependency. Tooling hardening belongs in a
  follow-up PR.
- **Idempotency**: the entire `docs/discoveries/security-scan-2026-06-02/`
  directory is safe to delete and regenerate. No state outside of it.

## Regeneration

To regenerate this report end-to-end, re-run the audit story sequence
(S1–S8) against the current `testnet` HEAD. All commands are read-only;
artifacts under `./artifacts/` may be overwritten.

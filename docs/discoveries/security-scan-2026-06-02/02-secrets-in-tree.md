---
type: discovery
title: Secrets and Secret-Like Material in Tree
date: 2026-06-02
status: active
slug: security-scan-2026-06-02
---

# 02 — Secrets in Tree

## Scope

This sub-report covers two read-only checks:

1. **Path-name scan** — `git ls-files | grep -Ei '(key|secret|password|token|\.env|\.pem|\.p12)'` against HEAD. Raw output and per-file triage in `artifacts/exposed-files.txt`.
2. **Content scan** — `gitleaks 8.21.2` against the full repo (working tree + 3641 commits of history). Raw SARIF in `artifacts/gitleaks.sarif` (NOT committed — see §Artifact handling).

Tool: `gitleaks detect --no-banner --redact --report-format sarif --source .`
Runtime: 6m52s, 3641 commits scanned.

## Headline numbers

| Metric | Count |
|---|---|
| Path-name matches in HEAD | 68 |
| Real candidates needing review | 4 |
| Confirmed sensitive in HEAD | 0 |
| Gitleaks total raw hits | 39 462 |
| Gitleaks hits in HEAD (after triage) | 0 (real) / ~39 425 (chain-state false positives) |
| Gitleaks hits in HISTORY only | 5 distinct (1 stripe, 1 GH PAT, 3 private keys) |

**Bottom line**: no committed-and-current credential found. All real-looking
secret material in the scan results lives in **git history** under commits
that pre-date the repo split (`d4831141f`, `24cab4942`, `95fc09141`,
`2a2ddfcb0`). The current `HEAD` tree only contains: a deterministic test
vector (`testing/devnet/l2ps/.../private_key.txt`), one tracked test env
with a public RPC URL (`src/tests/.env`), and an env template with default
dev credentials (`.env.example`).

## Findings

### SEC-2026-06-02-021 — Real secrets exist in git history (pre-split)

- **Severity**: high
- **CWE**: CWE-540 Inclusion of Sensitive Information in Source Code
- **Status**: exposed material still reachable via `git log --all`
- **Evidence**: 5 distinct gitleaks rule hits in historical commits:

| Rule | Historic path | First-seen commit | First 8 char of fp | Length |
|---|---|---|---|---|
| `private-key` | `demos/.demos_identity` | `24cab4942` | `24cab494` | 1 line, PEM-like |
| `private-key` | `common/.demos_identity` | `24cab4942` | `24cab494` | 1 line, PEM-like |
| `private-key` | `demos/src/ssl/server.key` | `d4831141f` | `d4831141` | 1 line, PEM-like |
| `github-fine-grained-pat` | `.env` (line 12, pre-split) | `88097f6a` | `88097f6a` | 1 line, env var |
| `stripe-access-token` | `docs/storage_features/access-control.md:406` | `db614ccf` | `db614ccf` | embedded in doc example |

All five files are absent from current HEAD (`git ls-files | grep -E '…'`
returns only `src/tests/.env`). Two `Delete .demos_identity` commits exist
(`2a2ddfcb0`, `95fc09141`).

- **Why this still matters**: anyone with clone access can `git log --all -p
  -- <path>` and recover the historical material. Removal from HEAD does not
  invalidate the secret. If any of these credentials remain valid in
  production (GitHub PAT, Stripe key, SSL server private key), they are
  effectively public to anyone who has cloned the repo.
- **Remediation owner**: human review required.
  - Rotate the GitHub fine-grained PAT (`88097f6a…`) — assume compromised.
  - Rotate the Stripe access token (`db614ccf…`) — assume compromised. Note
    this one is inside a doc example so it may already be a sample/test key.
  - Confirm `demos/src/ssl/server.key` was a dev cert, not a prod cert; if
    prod, rotate the SSL keypair + reissue cert.
  - Confirm `.demos_identity` was a development node identity, not a
    long-running validator key; if validator, the consensus key is
    effectively published.
- **Remediation options** (after rotation):
  - **Accept**: document that history contains expired/rotated material and
    move on. Cheapest; only safe if every leaked credential is confirmed
    rotated.
  - **Rewrite**: `git filter-repo --invert-paths --path <…>` then force-push
    all branches and ask every clone-holder to re-clone. Expensive,
    breaks PR refs, but is the only way to redact from history.
- **Detection going forward**: add `bun audit` + gitleaks to CI (see file
  `07-ci-cd-and-supply-chain.md`).

### SEC-2026-06-02-022 — `.env.example` ships default development credentials

- **Severity**: medium
- **CWE**: CWE-1188 Insecure Default Initialization of Resource
- **Status**: documented (`.env.example`, `docker-compose.yml`)
- **Evidence**:
  - `GRAFANA_ADMIN_PASSWORD=demos` at `.env.example:263` and via
    `${GRAFANA_ADMIN_PASSWORD:-demos}` in `docker-compose.yml:304`
  - `NEO4J_AUTH=neo4j/changeme-please` at `docker-compose.yml:355` (no env
    fallback — literal default in compose file)
  - `PG_PASSWORD=demospassword` at `.env.example:99` and via
    `${PG_PASSWORD:-demospassword}` in `docker-compose.yml:47`
- **Risk**: an operator who runs `cp .env.example .env && docker compose
  up` on a host with `0.0.0.0` binds (default for Grafana port 3000 and
  Neo4j 7474/7687 — see `docker-compose.yml`) deploys with known
  passwords. Combined with the `XFF_MODE=legacy` warning in `.env.example`,
  this can lead to immediate compromise on any internet-facing deployment.
- **Remediation**: the audit recommends a **boot-time gate** in
  `src/index.ts` (or a new `src/libs/security/credentialGuard.ts`) that:
  1. Detects `PROD=true` or `NODE_ENV=production`.
  2. Refuses to start if any of `GRAFANA_ADMIN_PASSWORD ∈ {demos, ''}`,
     `NEO4J_AUTH ∈ {neo4j/changeme-please, ''}`, `PG_PASSWORD ∈ {demospassword, ''}`.
  3. Logs the failing variable name (NOT the value) and exits non-zero.
  Do **not** implement in this audit run — file as follow-up PR.

### SEC-2026-06-02-023 — `testing/devnet/l2ps/live_local_001/private_key.txt` is a known test fixture

- **Severity**: informational
- **CWE**: N/A
- **Status**: confirmed fixture, not a secret
- **Evidence**: file content is the 32-byte deterministic hex
  `0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0`.
  This is a sentinel/test-vector pattern (descending nibbles 0f→00 then
  ascending 00→ff) — not a randomly generated key. Used by the L2PS devnet
  fixtures.
- **Action**: keep as-is. Add a `README.md` to the fixture directory
  documenting that the value is deterministic and must not be used for any
  real key material. Not in scope for this audit run.

### SEC-2026-06-02-024 — `src/tests/.env` contains only a public devnet RPC URL

- **Severity**: informational
- **Status**: no action needed
- **Evidence**: content = `RPC_URL=http://85.208.48.187:53550\n` (35 bytes).
  The endpoint is a publicly advertised devnet RPC — no credentials, no
  identifying info.
- **Action**: none.

### SEC-2026-06-02-025 — Gitleaks false-positive volume in chain state files

- **Severity**: informational
- **Status**: tuning required for CI
- **Evidence**: of 39 462 gitleaks hits, 39 417 (99.9%) come from two files:
  - `data/snapshot/gcr_main.jsonl` — 27 688 hits
  - `data/genesis.json` — 11 729 hits

  All matches are against the `generic-api-key` rule on 64-character hex
  strings that are public Ed25519 addresses / hashes in the genesis chain
  state. These are not secrets — chain addresses are public by design.
- **Action**: when adding gitleaks to CI (see
  `07-ci-cd-and-supply-chain.md`), include a `.gitleaksignore` /
  `[allowlist]` block excluding:
  ```toml
  [allowlist]
  paths = [
    '''data/snapshot/.*\.jsonl$''',
    '''data/genesis\.json$''',
    '''data/snapshot/identity_commitments\.jsonl$''',
  ]
  ```
  Otherwise the noise will drown any real signal.

### SEC-2026-06-02-026 — Documentation example contains realistic-looking auth strings

- **Severity**: informational
- **Status**: false positive, no action
- **Evidence**: `docs/runbooks/proxy-setup.md` lines 88 and 168 contain
  `-u metrics:YOUR_PASSWORD_HERE` and `-u mcp:mcp-password-here`. Gitleaks
  `curl-auth-user` flagged these. They are documentation placeholders.
- **Action**: none. If false-positive volume becomes painful in CI, add
  these two lines to `.gitleaksignore`.

## Artifact handling

Per audit spec rule 4, real-looking material was flagged in history, so
the raw SARIF report is **redacted in this markdown** (first 8 chars + length
only) and the full `artifacts/gitleaks.sarif` file (100 MB) is excluded
from the commit via one new line appended to `.gitignore`:

```
docs/discoveries/security-scan-2026-06-02/artifacts/gitleaks.sarif
```

The SARIF stays on disk locally so any reviewer can reproduce. To
regenerate from a fresh clone:

```bash
gitleaks detect --no-banner --redact --report-format sarif \
  --report-path docs/discoveries/security-scan-2026-06-02/artifacts/gitleaks.sarif \
  --source .
```

The path-name scan output (`artifacts/exposed-files.txt`, ~9 KB) IS
committed because it contains no secret material — only file paths and
hexdumps of files already confirmed safe (the L2PS fixture, the public-URL
test env, the binary header of `.env.example`).

## Cross-references

- See `01-exposed-network-surface.md` for which endpoints could expose any
  of these defaults if a deployer skips the `.env` swap.
- See `06-docker-and-deployment.md` for the Grafana/Neo4j default-cred
  posture in `docker-compose.yml`.
- See `07-ci-cd-and-supply-chain.md` for the recommended CI integration
  (gitleaks + bun audit + `.gitleaksignore`).

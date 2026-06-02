---
type: discovery
title: CI/CD and supply-chain audit
date: 2026-06-02
status: active
slug: security-scan-2026-06-02
---

# 07 — CI/CD and supply-chain

Scope: GitHub Actions workflows under `.github/workflows/`, repository
metadata in `.github/`, project-level supply-chain hygiene
(`package.json`, `bun.lock`, lockfile freshness, packageManager pin),
and the secrets/permissions surface of every workflow that can run
against this repo.

> Finding IDs in the `700` series are pre-allocated to this story to
> avoid clashes with sibling stories. The 08-findings-summary author
> may renumber to a contiguous global sequence at merge time.

## Inventory

`.github/` contains **only** `workflows/`. No other repo-level
governance files exist:

```
.github/
└── workflows/
    ├── ci.yml                       (lint + type-check)
    ├── claude.yml                   (Claude Code @-mention bot)
    └── claude-code-review.yml       (Claude Code PR auto-review)
```

Absent at the repo root or under `.github/`:

- `dependabot.yml` — no automated dependency PRs.
- `CODEOWNERS` — no required-reviewer routing.
- `SECURITY.md` — no published vulnerability disclosure policy.
- `pull_request_template.md` — no PR hygiene checklist.
- CodeQL / SAST workflow.
- `bun audit` / `npm audit` workflow gate.
- Secret-scan workflow (gitleaks, trufflehog).
- Container image scan (trivy / grype).
- Release / tag-signing workflow.

`package.json` declares **no** audit-related scripts (`audit`, `sec`,
`scan`, `sast`, `gitleaks` all empty in the script set) and **no**
`packageManager` field. `corepack` therefore cannot pin a bun version
across maintainers, and CI relies on whatever `oven-sh/setup-bun@v2`
resolves at runtime.

Lockfile vs `package.json` mtime check (`stat -f "%m"`):

| File | mtime (epoch) | Order |
|------|---------------|-------|
| `package.json` | 1780330068 | older |
| `bun.lock`     | 1780409357 | newer (≈22h later) |

`bun.lock` is newer than `package.json` → freshness OK at HEAD; CI
enforces `bun install --frozen-lockfile`, which would catch the
opposite.

## Workflow-by-workflow review

### `ci.yml`

```yaml
name: CI

on:
on:                       # <-- duplicate key
  pull_request:
    branches: [main, testnet, stabilisation]
  push:
    branches: [main, testnet, stabilisation]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run lint
  type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run type-check
```

Issues:

1. **Duplicate `on:` key** (lines 3 + 4). YAML 1.2 (which GitHub uses)
   accepts the second occurrence and silently discards the first. The
   first `on:` happens to be empty, so the file works by accident.
   Confirmed by parsing with PyYAML — the resulting map has `True:` as
   a key (Norway-problem: bare `on` becomes a boolean in YAML 1.1
   parsers). Both bugs are latent — a maintainer editing the first
   `on:` block will see no effect.
2. **No `permissions:` block.** Jobs inherit the
   repository/workflow default `GITHUB_TOKEN` permission set. If the
   repo or org default is `read-write`, lint/type-check jobs receive a
   token that can `contents: write`, `pull-requests: write`, etc.
3. **Floating-tag actions.** `actions/checkout@v4` and
   `oven-sh/setup-bun@v2` are major-version tags, mutable and
   reassignable by the action owner (or anyone who compromises the
   owner). GitHub's hardening guidance is to pin third-party actions
   to a full 40-char commit SHA.
4. **No vulnerability gate.** No `bun audit` / `npm audit` step. The
   repo carries `DEPS-AUDIT.md` (85 known vulnerabilities, 3 critical
   + 47 high) and the CI pipeline will not detect regressions.
5. **No secret scan.** No gitleaks/trufflehog step on PR; tracked
   secrets in the working tree would not be flagged at merge time.
6. **No type-check coverage of test files.** The script run is
   `bun run type-check` (which resolves to a stricter
   `bunx tsc -p tsconfig.strict.json` in `package.json`). Verify the
   strict config covers `tests/` and `testing/` paths — out of scope
   for this story; flag for follow-up.
7. **No artifact upload of lint/type-check report.** Failures are
   readable in the action log but cannot be diffed across runs.

### `claude.yml`

Triggers on `issue_comment`, `pull_request_review_comment`, `issues`,
`pull_request_review` when the body/title contains `@claude`.

```yaml
permissions:
  contents: read
  pull-requests: read
  issues: read
  id-token: write
  actions: read
```

Issues:

1. **No author-association gate.** Any GitHub user — including a
   first-time contributor or anonymous opener of a public issue — can
   trigger the workflow by typing `@claude` in an issue title/body or
   comment. The action itself is expected to enforce its own ACL, but
   the runner cost and any side-effects (Claude posting comments,
   reading actions logs) are at attacker's discretion.
   Recommendation: add `if: contains(...) && (
   github.event.comment.author_association == 'MEMBER' ||
   ... == 'OWNER' || ... == 'COLLABORATOR')` style gate, mirroring
   the upstream `claude-code-action` examples.
2. **`id-token: write`** grants OIDC token issuance to whatever the
   action does with it. Confirm the action actually uses OIDC; if
   not, drop the permission (principle of least privilege).
3. **`secrets.CLAUDE_CODE_OAUTH_TOKEN`** is a long-lived OAuth token.
   No rotation cadence is documented. If leaked (action log
   misconfiguration, prompt-injection exfil to a webhook), it grants
   Claude Code API access until manually revoked.
4. **Floating tag `anthropics/claude-code-action@v1`.** Same pinning
   concern as ci.yml. The action's `v1` tag is moved by Anthropic on
   every release.
5. **`fetch-depth: 1`** is correct for the read-only review use case;
   noted as a good-practice baseline.

### `claude-code-review.yml`

```yaml
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: read
  issues: read
  id-token: write

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 1
  - uses: anthropics/claude-code-action@v1
    with:
      claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      plugin_marketplaces: 'https://github.com/anthropics/claude-code.git'
      plugins: 'code-review@claude-code-plugins'
      prompt: '/code-review:code-review ${{ github.repository }}/pull/${{ github.event.pull_request.number }}'
```

Issues:

1. **`pull_request` event from forks gets workflow secrets.** GitHub
   does *not* expose secrets to `pull_request` workflows from forks
   by default — but the `claude_code_oauth_token` is in env, and the
   workflow checks out the PR head with `actions/checkout` at the
   merge-commit SHA. If GitHub's policy ever changes, or if a future
   maintainer switches the event to `pull_request_target` (which
   *does* expose secrets to forks), the OAuth token is reachable by
   arbitrary fork code. Recommend explicitly documenting "never
   switch to `pull_request_target` without re-auditing" inline.
2. **No PR-author filter.** Every PR from an anonymous contributor
   spins the action and consumes Claude credits. The commented-out
   block at the top of the file shows the maintainers considered
   gating on author association then disabled it. Re-enable for
   defence-in-depth and cost containment.
3. **`plugin_marketplaces: 'https://github.com/anthropics/claude-code.git'`**
   and `plugins: 'code-review@claude-code-plugins'` pull a moving
   plugin spec from a remote git URL on every PR. The plugin
   contents are not pinned to a SHA, so a compromised plugin
   repository could inject prompts that exfiltrate the
   `secrets.CLAUDE_CODE_OAUTH_TOKEN` via the action's tool calls.
4. **Same `id-token: write` and floating-tag concerns** as
   `claude.yml`.
5. **Prompt-injection via PR description / diff.** The prompt
   instructs Claude to review the PR; a malicious PR can include
   adversarial instructions in its diff or description that the
   action's LLM may follow. This is an inherent limitation of any
   LLM-on-PR pipeline and must be acknowledged in the runbook even
   if no remediation exists.

## Findings

> Severity scale: `critical | high | medium | low | informational`.
> CWE references use the public MITRE list.

---

### SEC-2026-06-02-700 — No `bun audit` / vulnerability gate in CI

- **Severity:** high
- **CWE:** CWE-1104 (Use of Unmaintained Third Party Components)
- **Location:** `.github/workflows/ci.yml` (entire file)
- **Evidence:** `DEPS-AUDIT.md` documents 85 unfixed vulnerabilities
  (3 critical, 47 high). `ci.yml` runs only `bun run lint` and
  `bun run type-check`. Nothing fails the build when the audit
  baseline regresses, and nothing prevents a PR from raising the
  vulnerability count.
- **Impact:** Critical-severity transitive dependencies can land on
  `main` / `testnet` / `stabilisation` without surface signal.
- **Remediation:** Add a `dependency-audit` job that runs
  `bun audit --severity high --json` (or `npm audit --omit=dev`
  after generating a temporary lockfile). Compare against a checked-
  in baseline JSON; fail the job when the count of high+critical
  rises above baseline. Run on PRs only (not push) to avoid blocking
  emergency hotfixes.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-701 — No automated secret scanning in CI

- **Severity:** high
- **CWE:** CWE-540 (Inclusion of Sensitive Information in Source Code)
- **Location:** `.github/workflows/` (no workflow exists)
- **Evidence:** Repo tracks at least one fixture private key
  (`testing/devnet/l2ps/live_local_001/private_key.txt`) and a
  `.env` (`src/tests/.env`). A future contributor accidentally
  committing a real secret would not be caught at PR time. See also
  SEC-2026-06-02-2xx in `02-secrets-in-tree.md`.
- **Impact:** Real credentials can land on `main` undetected; once
  pushed, GitHub history retention makes rotation the only mitigation.
- **Remediation:** Add a `secret-scan` job that runs
  `bunx gitleaks detect --redact --no-banner --exit-code 1`. Allowlist
  the known fixture file via `.gitleaks.toml`. Run on every PR.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-702 — No SAST / CodeQL workflow

- **Severity:** medium
- **CWE:** CWE-1059 (Insufficient Technical Documentation /
  Insufficient Analysis)
- **Location:** `.github/workflows/` (no workflow exists)
- **Evidence:** No `codeql.yml`, no `semgrep.yml`. The codebase
  handles cryptographic key material, multi-chain bridge transactions,
  and a custom HTTP server (`bunServer.ts`). Static analysis would
  surface common JavaScript/TypeScript injection sinks.
- **Impact:** Classes of vulnerability (path traversal, prototype
  pollution, command-injection in `Bun.spawn` callers) go undetected
  during code review.
- **Remediation:** Enable GitHub's free CodeQL workflow for
  `javascript-typescript`. As a follow-up, evaluate `semgrep` with
  a Demos-specific ruleset for blockchain patterns (signature
  verification timing, BigInt comparisons, RNG sources).
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-703 — Workflow actions pinned to floating major tags

- **Severity:** medium
- **CWE:** CWE-829 (Inclusion of Functionality from Untrusted Control
  Sphere)
- **Location:**
  - `.github/workflows/ci.yml:15`,`:16`,`:24`,`:25`
  - `.github/workflows/claude.yml:29`,`:35`
  - `.github/workflows/claude-code-review.yml:30`,`:36`
- **Evidence:** All `uses:` lines reference major tags
  (`actions/checkout@v4`, `oven-sh/setup-bun@v2`,
  `anthropics/claude-code-action@v1`). Owners (or attackers who
  compromise owner accounts) can reassign these tags to a malicious
  commit. The `tj-actions/changed-files` incident (2025) is the
  reference case.
- **Impact:** A single upstream compromise grants arbitrary code
  execution inside this repo's CI runners — with the
  `claude_code_oauth_token` secret in env on the Claude workflows.
- **Remediation:** Pin every third-party action to a full 40-char
  commit SHA, comment-annotated with the version. Example:
  `uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1`.
  Enable Dependabot for `package-ecosystem: github-actions` (see
  SEC-2026-06-02-707) so the SHAs get auto-bumped with the version
  comment as the changelog.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-704 — `claude.yml` lacks author-association gate

- **Severity:** medium
- **CWE:** CWE-862 (Missing Authorization)
- **Location:** `.github/workflows/claude.yml:14-19`
- **Evidence:** The `if:` block only checks `contains(..., '@claude')`.
  Any GitHub user — including a first-time contributor — can trigger
  the workflow and consume runner minutes plus Claude API credits.
- **Impact:** Denial-of-wallet (runner minutes, Claude API usage), and
  expanded attack surface for prompt-injection / data-exfiltration
  attempts against the OAuth token.
- **Remediation:** Add to each disjunct of the `if:`:
  `&& contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'),
  github.event.comment.author_association)` (adjust per event type).
  Reference: anthropics/claude-code-action README.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-705 — `claude-code-review.yml` runs on every PR with unpinned plugin marketplace

- **Severity:** medium
- **CWE:** CWE-829 (Inclusion of Functionality from Untrusted Control
  Sphere)
- **Location:** `.github/workflows/claude-code-review.yml:34-41`
- **Evidence:** The action pulls
  `plugin_marketplaces: 'https://github.com/anthropics/claude-code.git'`
  and loads `plugins: 'code-review@claude-code-plugins'` on every PR
  event. Neither the marketplace repo nor the plugin is pinned to a
  commit. Trust boundary: whoever can write to
  `anthropics/claude-code` can change what runs here.
- **Impact:** A compromised plugin can issue tool calls inside the
  action's sandbox with access to `secrets.CLAUDE_CODE_OAUTH_TOKEN`
  in env and the checked-out PR source.
- **Remediation:** Either (a) pin the plugin marketplace by hosting a
  fork and referencing a SHA, or (b) accept the risk explicitly in
  `docs/runbooks/` with a documented incident-response plan
  (token revocation steps). Also re-enable the author-association
  filter (currently commented out at lines 15-19) so unknown PR
  authors don't trigger the action at all.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-706 — `ci.yml` has duplicate `on:` key and no `permissions:` block

- **Severity:** low
- **CWE:** CWE-1188 (Insecure Default Initialization of Resource)
- **Location:** `.github/workflows/ci.yml:3-4`, full file (no
  `permissions:`)
- **Evidence:** Lines 3 and 4 both declare `on:`. PyYAML parse yields
  `{True: {pull_request: ..., push: ...}}` (the `on` → boolean coercion
  is the YAML 1.1 Norway-problem). GitHub's YAML 1.2 parser silently
  takes the second occurrence; the file works by accident. No
  top-level `permissions:` means the workflow inherits the
  repo/org default `GITHUB_TOKEN` scope.
- **Impact:** Latent bug: a maintainer editing the (empty) first
  `on:` will see no effect. If the org default token scope is
  `read-write`, the lint/type-check jobs receive write permissions
  they never use.
- **Remediation:** Remove the duplicate `on:` line. Add explicit
  `permissions: { contents: read }` at the workflow level (jobs
  inherit). Verify the org-wide default is also `read` at
  Settings → Actions → General → Workflow permissions.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-707 — No `dependabot.yml` for npm or GitHub Actions

- **Severity:** low
- **CWE:** CWE-1104 (Use of Unmaintained Third Party Components)
- **Location:** `.github/` (no file present)
- **Evidence:** No `.github/dependabot.yml`. `DEPS-AUDIT.md` documents
  manual `overrides` patches in `package.json` as the only remediation
  channel; nothing prompts maintainers when upstream publishes the
  underlying fix.
- **Impact:** Vulnerable dependencies and stale GitHub Actions linger
  in the repo until a human notices.
- **Remediation:** Add a `dependabot.yml` enabling weekly updates for
  `npm` (open-pull-requests-limit: 5, target `testnet`) and
  `github-actions` (limit: 3). Use `groups:` to bundle minor/patch
  bumps to reduce PR noise. Pair with SEC-2026-06-02-703 so SHA pins
  get refreshed automatically.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-708 — No `CODEOWNERS` file

- **Severity:** low
- **CWE:** CWE-732 (Incorrect Permission Assignment for Critical
  Resource)
- **Location:** repository root (no file present)
- **Evidence:** No `CODEOWNERS` at root, in `.github/`, or in `docs/`.
- **Impact:** Branch-protection rules cannot enforce "X must review
  changes to `src/libs/crypto/**` or `src/libs/consensus/**`". Any
  collaborator with write access can merge security-critical changes.
- **Remediation:** Add `.github/CODEOWNERS` mapping at least:
  - `/src/libs/crypto/**` → @<crypto-lead>
  - `/src/libs/consensus/**` → @<consensus-lead>
  - `/src/features/zk/**` → @<zk-lead>
  - `/.github/workflows/**` → @<devops-lead>

  Combined with branch-protection "require review from code owners",
  this gates merges on the right humans.
- **Owner:** Engineering leads + Platform / DevOps.

### SEC-2026-06-02-709 — No `SECURITY.md` / vulnerability disclosure policy

- **Severity:** low
- **CWE:** CWE-1059 (Insufficient Technical Documentation)
- **Location:** repository root (no file present)
- **Evidence:** No `SECURITY.md`, no `.github/SECURITY.md`. GitHub's
  "Security" tab therefore shows no disclosure contact.
- **Impact:** External researchers have no documented channel to
  report findings. Reports route to public issue tracker by default,
  which exposes vulnerabilities before remediation.
- **Remediation:** Publish a `SECURITY.md` with:
  - Supported versions table.
  - Private reporting contact (email or GitHub private security
    advisory).
  - SLA for triage (e.g., 72h ack, 30d resolution for high).
  - PGP key for encrypted reports.

  Enable GitHub Private Vulnerability Reporting
  (Settings → Code security → Private vulnerability reporting).
- **Owner:** Engineering leads.

### SEC-2026-06-02-710 — No `packageManager` pin; bun version floats in CI

- **Severity:** low
- **CWE:** CWE-1357 (Reliance on Insufficiently Trustworthy Component)
- **Location:** `package.json` (missing `packageManager` field);
  `.github/workflows/ci.yml:16`,`:25`
- **Evidence:** `package.json` has no `packageManager` field
  (`node -e ...` confirmed). `oven-sh/setup-bun@v2` is invoked without
  `with: bun-version:`. CI therefore runs whatever bun version the
  action defaults to on a given day; local maintainers run whatever
  they have installed.
- **Impact:** Reproducibility gap — a CI green run does not guarantee
  the same outcome on a maintainer's laptop or in production. A
  future bun upgrade could break the runtime silently.
- **Remediation:** Either (a) add
  `"packageManager": "bun@1.x.y"` to `package.json` (the cleanest
  fix), or (b) add `with: { bun-version: 1.x.y }` to both
  `setup-bun@v2` steps. Pair with Renovate/Dependabot to bump the
  pin periodically.
- **Owner:** Platform / DevOps.

### SEC-2026-06-02-711 — No release / tag-signing workflow

- **Severity:** informational
- **CWE:** CWE-345 (Insufficient Verification of Data Authenticity)
- **Location:** `.github/workflows/` (no workflow exists)
- **Evidence:** No `release.yml`, no `sigstore`/`cosign` workflow, no
  npm publish step.
- **Impact:** Releases (if any) are unsigned. Consumers of the
  built artifact cannot verify provenance. Less relevant if the
  node is only consumed via `git clone`; flagged for awareness.
- **Remediation:** If the node is distributed (npm package, Docker
  image, prebuilt binary), add a release workflow with provenance
  attestation (GitHub `attest-build-provenance` action) or sigstore
  signing. If not distributed, document the non-goal in
  `docs/runbooks/release.md`.
- **Owner:** Engineering leads.

### SEC-2026-06-02-712 — Workflow logs may leak prompt-injection payloads from PRs

- **Severity:** informational
- **CWE:** CWE-117 (Improper Output Neutralization for Logs)
- **Location:** `.github/workflows/claude-code-review.yml:36-41`
- **Evidence:** The `code-review` plugin's prompt is built from
  `${{ github.event.pull_request.number }}` (safe — integer) but the
  action subsequently fetches the PR diff and description and feeds
  them to Claude. An attacker can put injection payloads in the PR
  body that Claude may reproduce in review comments, potentially
  including masked secrets if the action logs them.
- **Impact:** Inherent to LLM-on-PR pipelines. Cannot be eliminated;
  must be acknowledged.
- **Remediation:** Document the prompt-injection threat model in
  `docs/runbooks/claude-code-review.md`. Disable verbose action
  logging for the Claude workflows (do not pass
  `ACTIONS_STEP_DEBUG=true`). Review the action's outputs setting
  to ensure tool-call traces don't print env vars.
- **Owner:** Engineering leads.

## CI-hardening PR (recommended scope)

This story does NOT add tooling. The following describes the scope
the follow-up PR should cover, in priority order:

1. **`dependency-audit.yml`** — `bun audit --severity high --json`
   on PRs to `main`/`testnet`/`stabilisation`. Fail when count rises
   above baseline JSON. Closes SEC-2026-06-02-700.
2. **`secret-scan.yml`** — `bunx gitleaks detect`. Closes
   SEC-2026-06-02-701.
3. **Pin every action to commit SHA** with `# v1.2.3` comments. Add
   `dependabot.yml` (`github-actions` + `npm`). Closes
   SEC-2026-06-02-703 and SEC-2026-06-02-707.
4. **Author-association gates** on `claude.yml` and re-enable the
   commented-out filter in `claude-code-review.yml`. Closes
   SEC-2026-06-02-704 and part of SEC-2026-06-02-705.
5. **`permissions: { contents: read }`** at the top of `ci.yml`;
   remove the duplicate `on:` key. Closes SEC-2026-06-02-706.
6. **`SECURITY.md` + `CODEOWNERS`**. Closes SEC-2026-06-02-708 and
   SEC-2026-06-02-709.
7. **`packageManager` field in `package.json`** plus explicit
   `bun-version:` in CI. Closes SEC-2026-06-02-710.
8. **CodeQL workflow** (GitHub-hosted, zero cost). Closes
   SEC-2026-06-02-702.

Do NOT bundle items 1-2 with items 3-7 in the same PR; the audit
gates can flag pre-existing issues that block the SHA-pinning work.
Land 3-7 first, then 1-2 with a baseline JSON captured at the
post-pinning state.

## Cross-references

- Vulnerability counts: see `03-dependency-vulnerabilities.md`.
- Tracked sensitive-looking files: see `02-secrets-in-tree.md`.
- Claude prompt-injection threat model: pending runbook
  `docs/runbooks/claude-code-review.md` (does not exist yet).

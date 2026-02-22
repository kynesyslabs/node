# Codebase Concerns

**Analysis Date:** 2026-02-22

## Quick Metrics (from `src/`)

- TODO/FIXME/REVIEW markers: **629** occurrences
- `as any` casts: **54** occurrences
- `: any` annotations: **281** occurrences
- `eslint-disable` directives: **39** occurrences
- `@deprecated` tags: **6** occurrences
- Unique `process.env.*` references: **102** variables (approx; grep-derived)

These numbers are useful for trend tracking and prioritization; they are not a substitute for threat modeling.

## High-Risk Correctness / Security

### Transaction nonce validation bypassed
- Risk: Transaction nonce checks are effectively disabled.
- Code: `src/libs/blockchain/routines/validateTransaction.ts`
  - `assignNonce()` currently returns `true` via `const validNonce = true // TODO Override for testing`
- Impact: Replay / ordering guarantees can be broken; can destabilize mempool/consensus assumptions.

### Security module stubbed
- Risk: Rate limiting / security reporting appears unimplemented.
- Code: `src/libs/network/securityModule.ts` is explicitly marked “TODO Implement this”.
- Impact: DoS resistance and request validation may rely on incomplete components.

### Database auto-sync in production risk
- Risk: TypeORM `synchronize: true` can cause unintended schema changes at runtime.
- Code: `src/model/datasource.ts` sets `synchronize: true`.
- Impact: Production data loss / migration drift if used outside controlled environments.

## Maintainability / Tech Debt

### Large TODO backlog in core subsystems
- Concentrated in blockchain/network/bridge routines; triage needed by impact area.
- Starting points:
  - `src/libs/blockchain/routines/validateTransaction.ts`
  - `src/libs/network/` (method managers + middleware)
  - `src/features/bridges/`

### Type safety erosion
- `any` usage is permitted by ESLint (`@typescript-eslint/no-explicit-any: off`) and is common.
- Impact: runtime failures can hide until consensus-critical paths execute.

## Operational / Secret Handling

### Sensitive local identity files exist in repo root (do not commit/share)
- `.demos_identity`, `.demos_identity.key` exist in the working tree (ensure they’re ignored and handled carefully).
- Recommendation: treat as secrets; restrict permissions and avoid copying into docs/logs.

## Suggested next steps (actionable)

1. Turn `assignNonce()` into a real nonce check (and add tests).
2. Audit/implement `src/libs/network/securityModule.ts` + verify `RateLimiter` usage in request pipeline.
3. Decide on DB strategy (Postgres vs sqlite) and remove/clarify legacy configs (`ormconfig.json`) to reduce confusion.
4. Track TODO clusters as beads issues by subsystem (consensus, network, GCR, bridges).


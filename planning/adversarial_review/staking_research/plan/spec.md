# Spec: Staking Foundation + Stackable Genesis Governance

> Version: 1.0
> Status: Draft
> Depends on: Adversarial review v2 documents

---

## Objective

Implement a two-phase system:
- **Phase 0**: Staking lifecycle (stake, unstake, exit) — prerequisite
- **Phase 1**: On-chain governance (propose, vote, activate network upgrades)

Both require coordinated changes across two repos:
- `@kynesyslabs/demosdk` (SDK, `../sdks/`)
- Demos node (`./`)

**Constraint:** SDK changes must be built + published before node changes that depend on
them. The plan is structured around SDK publish cycles.

---

## Acceptance Criteria

### Phase 0 — Staking Foundation

- [ ] Validators entity has clean `staked_amount: string` column (bigint as string)
- [ ] Validators entity has `unstake_requested_at` and `unstake_available_at` columns
- [ ] `validatorStake` tx type: register as validator with amount >= minToStake
- [ ] `validatorStake` tx type: increase existing stake
- [ ] `validatorUnstake` tx type: request unstake, starts lock period (1000 blocks)
- [ ] `validatorExit` tx type: withdraw after lock period, validator becomes inactive
- [ ] Lock period: validator remains active during unbonding (can be selected for consensus, votes count)
- [ ] RPC handlers: `getValidatorInfo`, `getValidators`, `getStakedAmount`
- [ ] SDK methods: `stake()`, `unstake()`, `validatorExit()`
- [ ] SDK queries: `getValidatorInfo()`, `getValidators()`, `getStakedAmount()`
- [ ] `minToStake` read from genesis/config, not hardcoded
- [ ] `bun run lint:fix` passes
- [ ] `bun test testing/` passes (existing tests unbroken)
- [ ] New unit tests for: entrance, increase, unstake, exit, lock enforcement

### Phase 1 — Stackable Genesis Governance

- [ ] `NetworkParameters` and `NetworkUpgradeProposal` types (split design from v2 doc)
- [ ] `NetworkUpgrade` and `NetworkUpgradeVote` DB entities
- [ ] `networkUpgrade` tx type with full validation (safety bounds, conflict detection, etc.)
- [ ] `networkUpgradeVote` tx type (one per validator per proposal, snapshot-based)
- [ ] Vote tally at voting window end (stake-weighted, 2/3 supermajority)
- [ ] Proposal lifecycle: pending → approved → activating → active / rejected
- [ ] Grace period locking (affected keys locked between tally and activation)
- [ ] Deterministic activation ordering (lexicographic by proposalId)
- [ ] `loadNetworkParameters()` at startup
- [ ] Parameter safety bounds (50% max change + absolute floors, non-upgradeable)
- [ ] RPC handlers: `getNetworkParameters`, `getActiveProposals`, `getProposalVotes`, `getUpgradeHistory`
- [ ] SDK methods: `proposeNetworkUpgrade()`, `voteOnUpgrade()`
- [ ] SDK queries: `getNetworkParameters()`, `getActiveProposals()`, `getProposalVotes()`, `getUpgradeHistory()`
- [ ] `defaults.ts` reads from `getSharedState.networkParameters` instead of hardcoded values
- [ ] `bun run lint:fix` passes
- [ ] `bun test testing/` passes
- [ ] New unit tests for: proposal, vote, tally, rejection, concurrent proposals, safety bounds, activation

---

## Non-Goals (explicit)

- Stake-weighted consensus shard selection (future work, not needed for governance)
- Validator slashing
- Delegation / liquid staking
- featureFlags registry (Phase 2 of governance, deferred)
- shardSize / blockTimeMs governance (Phase 2 of governance, deferred)

---

## Key Design References

| Document | Location |
|----------|----------|
| Governance design v2 | `planning/adversarial_review/stackable_genesis_system_v2.md` |
| Network configs | `planning/adversarial_review/network_configs_editability_v2.md` |
| Security model | `planning/adversarial_review/security_conditions_v2.md` |
| Research inventory | `planning/adversarial_review/staking_research/00_research_inventory.md` |
| Lead conclusions | `planning/adversarial_review/staking_research/01_lead_conclusions.md` |
| SDK gap analysis | `planning/adversarial_review/staking_research/02_sdk_gap_analysis.md` |

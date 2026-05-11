# Security Conditions — v2

> Expanded after adversarial peer review. Previously 3 bullet points;
> now merged into this standalone summary. Full details in stackable_genesis_system_v2.md.

## Governance Security Model

### Threat: Low-participation attacks
- **Mitigation:** Abstention counts as NO. Threshold is 2/3 of ALL staked weight,
  not 2/3 of votes cast. A small active minority cannot push through changes.

### Threat: Proposal spam / governance DoS
- **Mitigation:** Each validator may have at most 1 pending proposal at a time.
  Proposals require the proposer to be an active validator with sufficient stake.

### Threat: Conflicting concurrent proposals
- **Mitigation:** Proposals declare affected parameters (derived from `Object.keys(proposedParameters)`).
  Two proposals touching the same parameter key cannot coexist — the second is rejected at validation.
  Grace period locking extends this protection through activation.

### Threat: Malicious parameter values
- **Mitigation:** Dual-layer safety bounds (50% max change + absolute floors).
  These bounds are non-upgradeable — they cannot be weakened via governance.

### Threat: Vote weight manipulation
- **Mitigation:** Vote weight is staked DEMOS (not liquid balance), snapshotted at proposal
  confirmation block. Staking/unstaking after the snapshot has no effect on the vote.

### Threat: Fork-based vote manipulation
- **Mitigation:** Vote tally is always re-derived from on-chain data. Never cached.
  Reorgs trigger re-evaluation from canonical chain state.

### Threat: Threshold reduction attack
- **Mitigation:** The 2/3 threshold is NOT a governable parameter. It is a protocol constant.

## Constraints (carried from original)

- Stake-based approvals only (no headcount voting)
- Every validator can have only 1 pending upgrade network transaction
- One vote per validator per proposal, votes are final

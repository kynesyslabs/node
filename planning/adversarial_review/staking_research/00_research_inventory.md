# Staking System Research — Raw Inventory

> Research conducted by Team "Stack Overflow Prevention Unit"
> Scope: node repo (`src/`) + SDK repo (`../sdks/`)

---

## Node Repository Findings

### Validators Entity (`src/model/entities/Validators.ts`)

```typescript
@Entity("validators")
export class Validators {
    @PrimaryColumn("text")    address: string     // validator public key hex
    @Column("text")           status: string      // "2" = valid/active
    @Column("text")           connection_url: string
    @Column("text")           staked: string      // staking amount (string repr)
    @Column("integer")        first_seen: number  // block when joined
    @Column("integer")        valid_at: number    // block when became valid
    @Column("integer")        stake: number       // stake amount (integer)
}
```

**Note:** There are TWO stake columns — `staked` (text) and `stake` (integer). Likely a legacy/migration artifact. Needs cleanup.

### ValidatorsManagement (`src/libs/blockchain/routines/validatorsManagement.ts`)

- `minToStake = 10000000000000000000000000` — hardcoded constant, TODO says "Defined in genesis"
- `manageValidatorEntranceTx(tx)` — only checks `tx.content.amount < minToStake`
  - Has TODOs for: "Is not already staking", "Is not in the chain blacklist", "Has never been kicked"
- `manageValidatorOnlineStatus()` — reads validator, gets connection_string, TODO for connection test
- `isValidatorActive()` — checks `status === 2`
- **No unstake method exists**
- **No stake update method exists**
- **No exit/leave method exists**

### GCR Validator Queries (`src/libs/blockchain/gcr/gcr.ts`)

Three query methods exist (node-internal only, NOT exposed via RPC):

1. `getGCRHashedStakes(blockN)` — queries validators, hashes stakes (line 304)
2. `getGCRValidatorsAtBlock(blockN)` — queries validators filtered by `first_seen <= blockN` (line 333)
3. `getGCRValidatorStatus(pubkeyHex, blockN)` — single validator lookup (line 365)

**These provide the foundation for block-height-aware validator set queries.**

### Consensus / Shard Selection

- `getShard.ts` — selects validators for consensus round using CVSA seed + Alea PRNG
  - Filters: `peer.status.online && peer.sync.status && block_sync <= 1`
  - Sorts by identity, selects up to `shardSize` validators
  - Selection is **headcount-based** (equal weight), not stake-weighted
- `secretaryManager.ts` — 7-phase consensus protocol, secretary coordination
  - No stake weighting in any phase

### Transaction Handling

- **No `"validatorEntrance"` or `"validatorExit"` explicit tx type** in `transaction.ts`
- Validator entrance is handled via `manageValidatorEntranceTx()` but the tx type routing is unclear
- **No `"networkUpgrade"` or `"networkUpgradeVote"` tx type**

---

## SDK Repository Findings

### Structure

- `src/websdk/demosclass.ts` — main `Demos` class, nodeCall-based RPC
- `src/websdk/DemosTransactions.ts` — transaction builders (pay, transfer, sign, broadcast)
- `src/types/blockchain/Transaction.ts` — `TransactionContent` + `TransactionContentData` union
- `src/types/blockchain/TransactionSubtypes/` — 18 transaction type files
- `src/types/blockchain/GCREdit.ts` — GCR edit variants
- `src/types/blockchain/genesisTypes.ts` — genesis types (minimal)

### Staking/Validator/Governance: NOTHING EXISTS

- Zero staking methods
- Zero validator management methods  
- Zero governance/voting methods
- Zero nodeCall handlers for validators exposed from node
- `DemosTransactions` has no `stake()`, `unstake()`, `proposeUpgrade()`, or `vote()` methods
- `TransactionContentData` union has no staking or governance types
- `GCREdit` has no validator-stake variant
- `INativePayload` only has: `send`, `tlsn_request`, `tlsn_store`

### Transaction Types Available (SDK)

L2PS, L2PSHash, Web2, Crosschain, Native, Demoswork, Identity, InstantMessaging,
NativeBridge, Storage, StorageProgram, ContractDeploy, ContractCall, D402Payment,
Escrow, IPFS, TokenCreation, TokenExecution

**None are staking or governance related.**

---

## Summary: What EXISTS vs What is MISSING

| Capability | Exists? | Where | Notes |
|-----------|---------|-------|-------|
| Validator DB entity | YES | `model/entities/Validators.ts` | Has `staked`/`stake` columns |
| Validator entrance validation | PARTIAL | `validatorsManagement.ts` | Only checks amount >= minToStake |
| Validator set query by block | YES | `gcr.ts:getGCRValidatorsAtBlock()` | Not exposed via RPC |
| Single validator query | YES | `gcr.ts:getGCRValidatorStatus()` | Not exposed via RPC |
| Hashed stakes query | YES | `gcr.ts:getGCRHashedStakes()` | Not exposed via RPC |
| minToStake enforcement | YES | `validatorsManagement.ts` | Hardcoded, not from genesis |
| Stake-weighted shard selection | NO | `getShard.ts` | Currently headcount-based |
| Unstake / validator exit | NO | — | Does not exist |
| Stake amount updates | NO | — | Stake is set at entrance, never updated |
| Validator removal / slashing | NO | — | Does not exist |
| Lock period / unbonding | NO | — | Does not exist |
| SDK staking methods | NO | — | Does not exist |
| SDK governance methods | NO | — | Does not exist |
| RPC endpoints for validators | NO | — | GCR methods exist but are internal-only |
| networkUpgrade tx type | NO | — | Does not exist |
| networkUpgradeVote tx type | NO | — | Does not exist |
| NetworkProperties type | NO | — | Does not exist |
| Stake snapshot at block X | PARTIAL | `getGCRValidatorsAtBlock()` | Returns validators, includes stake data |

# SDK Gap Analysis for Staking + Governance

> What the SDK needs, mapped to its existing patterns.

---

## Current SDK Architecture (brief)

- **`Demos` class** (`demosclass.ts`) — main entry point, uses `this.nodeCall(message, args)` for RPC
- **`DemosTransactions`** (`DemosTransactions.ts`) — builder pattern: `prepare() → sign() → broadcast()`
- **Transaction types** — each subtype gets its own file in `TransactionSubtypes/`, added to:
  - `TransactionContentData` union in `Transaction.ts`
  - `TransactionContent["type"]` string literal union
  - `SpecificTransaction` union in `index.ts`
- **GCREdits** — `GCREdit.ts` defines variants applied atomically on confirmation
- **INativePayload** — native operations (`send`, `tlsn_request`, `tlsn_store`)

## Pattern for Adding New TX Types

Every prior feature (tokens, escrow, IPFS, bridges) followed this exact pattern:

```
1. New file: src/types/blockchain/TransactionSubtypes/FooTransaction.ts
   - Define FooPayload interface
   - Narrow TransactionContent to type: "foo", data: ["foo", FooPayload]
   - Export typed FooTransaction

2. Add to: src/types/blockchain/Transaction.ts
   - TransactionContentData union: | ["foo", FooPayload]
   - TransactionContent["type"]: | "foo"

3. Add to: src/types/blockchain/TransactionSubtypes/index.ts
   - Re-export, add to SpecificTransaction union

4. Add builder to: DemosTransactions.ts (or new module)
   - foo(args, demos) → prepare({type: "foo", data: [...]}) → sign → return

5. Add query to: demosclass.ts
   - this.nodeCall("getFooStatus", args)
```

**This is mechanical work.** No architectural changes needed in the SDK.

## New Methods Needed

### Phase 0 (Staking)

```typescript
// Transaction builders
DemosTransactions.stake(amount: bigint, demos: Demos)
DemosTransactions.unstake(demos: Demos)
DemosTransactions.validatorExit(demos: Demos)

// Queries (on Demos class)
Demos.getValidatorInfo(address: string): Promise<ValidatorInfo>
Demos.getValidators(blockNumber?: number): Promise<ValidatorInfo[]>
Demos.getStakedAmount(address: string): Promise<string>
```

### Phase 1 (Governance)

```typescript
// Transaction builders
DemosTransactions.proposeNetworkUpgrade(params: NetworkUpgradeParams, demos: Demos)
DemosTransactions.voteOnUpgrade(proposalId: string, approve: boolean, demos: Demos)

// Queries
Demos.getNetworkParameters(): Promise<NetworkParameters>
Demos.getActiveProposals(): Promise<NetworkUpgradeProposal[]>
Demos.getProposalVotes(proposalId: string): Promise<ProposalVoteInfo>
Demos.getUpgradeHistory(): Promise<NetworkUpgradeProposal[]>
```

## New Types Needed

### GCREdit variant
```typescript
interface GCREditValidatorStake {
  type: "validatorStake"
  isRollback: boolean
  account: string
  operation: "stake" | "unstake" | "exit"
  amount: string  // bigint as string
  txhash: string
}
```

### NetworkParameters (in genesisTypes.ts or new file)
```typescript
interface NetworkParameters {
  blockTimeMs: number
  shardSize: number
  minValidatorStake: string  // bigint as string
  networkFee: number
  rpcFee: number
  featureFlags: Record<string, boolean>
}
```

## Node-Side: Missing RPC Handlers

The node has `getGCRValidatorsAtBlock()`, `getGCRValidatorStatus()`, and
`getGCRHashedStakes()` but **none are exposed via nodeCall handlers**.

New handler file needed: `src/libs/network/handlers/validatorHandlers.ts`

Registered in `handlerRegistry` following existing pattern.

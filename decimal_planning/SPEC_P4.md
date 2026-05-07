# SPEC_P4 — SDK v3.0.0-rc.1: Dual-Format Type Migration

> **Status**: Planning pass complete. Implementation **NOT** started.
> **Repo**: `/Users/tcsenpai/kynesys/sdks/` (the SDK).
> **Target**: SDK `3.0.0-rc.1` (publish with `--tag rc`).
> **Inputs read**: SPEC.md §3 P4, audit_sdk.md, LOG.md sessions 9/11/12, forking_feasibility.md, current SDK source on `decimals`-equivalent state.

---

## 0. State of the SDK at start of P4

- Current published version: `2.12.2`. The bump from `2.12.0` → `2.12.2` was patch-level (axios retry hardening, fail-fast guard, validation fixes). No denomination semantics changed since P0.
- `src/denomination/{constants,conversion,index}.ts` exists, exported as `denomination` from `src/index.ts`. Dormant — no other module imports it yet.
- `Account.balance: string` (gls/account.ts), `BridgeOperation.amount: string`, `IPFSCustomCharges.max_cost_dem: string`, `GCREditValidatorStake.amount: string` are **already** OS/bigint-string, but most of these are still labelled "DEM" in comments. They do not need to change shape, only label/semantics.
- Every other amount/fee/balance field still typed `number`.
- No fork-detection / dual-format machinery anywhere in the SDK. Greenfield.
- **STOP conditions check**: every audit_sdk.md path verified to exist; no partial migration found beyond the items already string-typed (which the audit itself flagged); gcr_edits structure is well-bounded (3 carriers — see §2). No STOP triggered.

---

## 1. Inventory of types to migrate

For each: file, current shape (with line cite), target shape. Internal representation everywhere becomes `bigint`; wire representation when fork is active becomes decimal OS string. Public API uses `bigint`.

### 1.1 Core transaction types

| File | Field | Current (line) | Target | Notes |
|---|---|---|---|---|
| `src/types/blockchain/TxFee.ts` | `network_fee`, `rpc_fee`, `additional_fee` | `number` (L2-4) | `string` (wire) — bigint-as-decimal-string | Used by `TransactionContent.transaction_fee`. Storage skeleton (`websdk/utils/skeletons.ts`) initializes these as `0`; should become `"0"`. |
| `src/types/blockchain/Transaction.ts` | `TransactionContent.amount` | `number` (L98) | `string` | Top-level transferred DEM. |
| `src/types/blockchain/rawTransaction.ts` | `amount`, `networkFee`, `rpcFee`, `additionalFee` | `number` (L24,27-29) | `string` | DB-derived raw row. |
| `src/types/blockchain/statusNative.ts` | `balance` | `number` (L3) | `string` | Native blockchain status. |
| `src/types/gls/StateChange.ts` | `nativeAmount`, `TokenTransfer.amount`, `NFTTransfer.amount` | `number` (L16,22,29) | `string` | Indexer state diff. |
| `src/types/blockchain/TransactionSubtypes/D402PaymentTransaction.ts` | `D402PaymentPayload.amount` | `number` (L11) | `string` | Comment claims "smallest unit" but field is `number` — was DEM number. Becomes OS string. |
| `src/types/bridge/bridgeTradePayload.ts` | `BridgeTradePayload.amount` | `number` (L5) | `string` | Native DEM source amount for a trade. |
| `src/types/blockchain/TransactionSubtypes/NativeTransaction.ts` | inherits `TransactionContent.amount` | n/a | follows TransactionContent | No standalone change. |
| `src/types/blockchain/TransactionSubtypes/EscrowTransaction.ts` | `EscrowPayload.amount` | already `string?` (L6) | `string` (semantics: OS) | Confirm callers populate as OS-string. |

### 1.2 GCR edit types — see §2 for full scope

| File | Type | Field | Current | Target |
|---|---|---|---|---|
| `src/types/blockchain/GCREdit.ts` | `GCREditBalance.amount` | L23 | `number` | `string` (OS) |
| `src/types/blockchain/GCREdit.ts` | `GCREditNonce.amount` | L31 | `number` | stays `number` for nonces (always `1`). See §2.3. |
| `src/types/blockchain/GCREdit.ts` | `GCREditEscrow.data.amount?` | L190 | `number` | `string` (OS) |
| `src/types/blockchain/GCREdit.ts` | `GCREditValidatorStake.amount` | L233 | `string` | already correct (post-staking PR) |

### 1.3 Account / address-info types

| File | Field | Current | Target |
|---|---|---|---|
| `src/types/gls/account.ts` | `Account.balance` | `string` (L5) | stays `string` — semantics change DEM → OS. Comment + JSDoc update only. |
| `src/types/blockchain/address.ts` | `AddressInfo.balance` | `bigint` (L29) | stays `bigint` — semantics change. JSDoc note: this is OS internally. |

### 1.4 IPFS / Storage / TLSNotary fees

| File | Item | Current | Target |
|---|---|---|---|
| `src/types/blockchain/CustomCharges.ts` | `IPFSCostBreakdown.{base_cost,size_cost,duration_cost}` | `string` ("DEM wei" comment, L22-29) | stays `string` — relabel/redefine as **OS** decimal string; SDK does conversion when post-fork serializer is active. |
| `src/types/blockchain/CustomCharges.ts` | `IPFSCustomCharges.max_cost_dem` | `string` (L43) | rename → `max_cost_os` |
| `src/types/blockchain/CustomCharges.ts` | `ValidityDataCustomCharges.max_cost_dem`, `actual_cost_dem` | `string` (L107,110) | rename → `max_cost_os`, `actual_cost_os` |
| `src/types/blockchain/TransactionSubtypes/StorageProgramTransaction.ts` | `STORAGE_PROGRAM_CONSTANTS.FEE_PER_CHUNK` | `1n` (L20) | `OS_PER_DEM` (1_000_000_000n) — currently bug: 1 OS not 1 DEM |
| `src/tlsnotary/helpers.ts` | `calculateStorageFee(proofSizeKB): number` | `number` returning DEM (L25) | returns `bigint` of OS: `OS_PER_DEM + BigInt(ceil(KB)) * OS_PER_DEM` |
| `src/tlsnotary/TLSNotaryService.ts` | `RequestAttestationOptions.amount: number` (L125), `calculateStorageFee` (L739), `createTlsnStoreTransaction(fee: number)` (L828) | `number` | `bigint` |

### 1.5 Bridge types

| File | Field | Current | Target |
|---|---|---|---|
| `src/bridge/nativeBridgeTypes.ts` | `BridgeOperation.amount` | `string` (L17) | stays `string` — represents the **stablecoin** amount on the source chain (USDC etc.), not DEM. **Do NOT** rewrite as OS. Document this clearly. |
| `src/bridge/nativeBridgeTypes.ts` | `EVMTankData.amountExpected`, `SolanaTankData.amountExpected` | `number` (L28,34) | `string` — these are stablecoin units in their chain's smallest unit (wei / lamports), kept as decimal string for BigInt safety. Not converted to OS. |
| `src/bridge/nativeBridgeTypes.ts` | `BridgeOperationCompiledLegacy.content.amountExpected` | `number` (L67) | `string` (legacy, may be deprecated) |
| `src/types/bridge/bridgeTradePayload.ts` | `amount` | `number` | `string` — when `fromToken === "NATIVE"`, this is OS; otherwise stablecoin smallest unit. JSDoc must call this out. |

### 1.6 D402

| File | Field | Current | Target |
|---|---|---|---|
| `src/d402/server/types.ts` | `amount`, `verified_amount`, `amount` (L11,27,49) | `number` | `bigint` for SDK-internal types, `string` for wire-facing. |
| `src/d402/server/middleware.ts` | `amount` (L14,37) | `number` | `bigint` |
| `src/d402/client/types.ts` | `amount` (L11) | `number` | `bigint` |

### 1.7 XM / multichain — explicit non-targets

The following are **not** migrated. They represent native amounts on other chains, not DEM/OS.

| File | Field | Reason |
|---|---|---|
| `src/types/xm/apiTools.ts` | `SolNativeTransfer.amount`, `SolTransaction.fee` | Solana lamports |
| `src/multichain/core/types/interfaces.ts` | `amount: number \| string` | XM protocol — chain-specific units |
| `src/multichain/core/xrp.ts` | `preparePay(amount)` | XRP drops |
| `src/multichain/localsdk/aptos.ts` | `fundFromFaucet(amount)` | Aptos octas |
| `src/contracts/templates/{TemplateRegistry,Token.ts.template}` | `transfer/mint/burn(amount)` | In-VM token templates, not network-level DEM. |

These are listed here explicitly so the implementer doesn't sweep them. The SPEC's risk register also calls them out.

---

## 2. `gcr_edits[]` migration scope

Per LOG.md Session 9, gcr_edits is the SDK's responsibility to populate with OS-string amounts when post-fork. The node serializer **explicitly does not** transform `gcr_edits[].amount` — it spreads the content verbatim except for the top-level `amount` and `transaction_fee`. So if the SDK puts a `number` into a gcr_edit's `amount` while talking to a post-fork node, the resulting hash will not match the node's expectation.

### 2.1 Where gcr_edits are constructed

Single source of truth: `src/websdk/GCRGeneration.ts`. Every `Demos.sign()` flow runs `raw_tx.content.gcr_edits = await GCRGeneration.generate(raw_tx)` (`demosclass.ts:486`). Edits are produced in:
- `GCRGeneration.generate` itself (gas, nonce edits).
- `HandleNativeOperations.handle` (send, tlsn_request, tlsn_store).
- `HandleD402Operations.handle` (d402 payment).
- `HandleStorageProgramOperations.handle` + its `calculateStorageFee` helper.
- Validator-stake / network-upgrade case branches in `generate`.

There is also one **non-GCRGeneration** site: `src/escrow/EscrowTransaction.ts` builds gcr_edits inline (L85-112, L181-206, L266-289) before calling `demos.sign()`. `demos.sign()` then **overwrites** them via `GCRGeneration.generate` — which means the escrow's manually-built edits are dead code today (subtle bug; flagged for cleanup but not blocking). For P4 we still update those inline construction sites for type-correctness, since they appear in tests.

### 2.2 Variants that carry per-entry amounts

Three variants of `GCREdit` carry amounts that need migration:

1. **`GCREditBalance.amount`** — populated from:
   - `GCRGeneration.createGasEdit` — `gasAmount: number = 1` (gas-fee edit, hardcoded 1 DEM).
   - `HandleNativeOperations` `case "send"` — passes the user-supplied DEM `amount` straight into `subtractEdit` and `addEdit`.
   - `HandleNativeOperations` `case "tlsn_request"` — `TLSN_REQUEST_FEE = 1`.
   - `HandleNativeOperations` `case "tlsn_store"` — `storageFee = TLSN_STORE_BASE_FEE + (proofSizeKB * TLSN_STORE_PER_KB_FEE)` in DEM.
   - `HandleD402Operations.handle` — payload's `amount`.
   - `HandleStorageProgramOperations.handle` — `fee` from `calculateStorageFee`.
2. **`GCREditNonce.amount`** — always `1`; this is a counter increment, **not** a token amount. Plan: keep typed as `number` with JSDoc clarification. (Audit lumped these together; on inspection they are semantically different.)
3. **`GCREditEscrow.data.amount?`** — populated from `EscrowTransaction.sendToIdentity` (when SDK escrow flow is wired into `GCRGeneration` — currently only via the `demos.sign()` overwrite which discards the inline edit, so this is only populated via the handler that actually runs in the node + `Handle*` SDK code; will still need handling once escrow is properly wired).

### 2.3 Required SDK changes

- Widen `GCREditBalance.amount` from `number` to `string` (OS, bigint-as-string).
- Update every construction site listed above to populate `amount` as an OS string when the post-fork serializer is active, or as a DEM number when pre-fork (see §3 for the format-switch architecture).
- Keep `GCREditNonce.amount: number` (clarify with JSDoc that it's a count, not an amount).
- Update `GCREditEscrow.data.amount?` to `string` (OS).

### 2.4 Decision: format choice for gcr_edits

We have two architectural options:

- **(A) gcr_edits always carry OS-strings** regardless of node fork status, and the **pre-fork serializer also transforms gcr_edits to legacy DEM-numbers** for hashing. This makes the SDK internal contract uniform but pushes complexity into the pre-fork wire.
- **(B) gcr_edits carry whatever the wire format expects** (number pre-fork, string post-fork). The SDK's GCRGeneration takes the fork state as input and produces the right shape. Internal arithmetic always uses bigint; conversion happens at edit construction time.

**Recommend (B)**, because:
- The node serializer specifically does not transform `gcr_edits[].amount`. So whatever the SDK puts there *is* the wire format. Option (A) would require a pre-fork SDK-side transformer right before hashing, duplicating node-side logic.
- The current SDK already produces DEM-numbers for pre-fork; that's exactly the legacy contract. Keeping it for pre-fork is zero-risk.
- Post-fork: GCRGeneration receives the fork-state flag and emits OS strings.

**Concrete plan**: thread the fork-state flag into `GCRGeneration.generate(tx, isRollback, isPostFork)` and propagate to handlers. Default `isPostFork = false` to preserve current callers during the staged rollout (P4 commits 1-3); flip on at the public-API integration commit.

---

## 3. Dual-format serialization strategy

The SDK must produce different wire formats depending on fork status. This section is the architectural core.

### 3.1 Detection and caching

- **RPC**: `demos.nodeCall("getNetworkInfo")` → `NetworkInfo` (envelope unwrapped to `response.data.response` per the existing `nodeCall` flow). The handler is implemented at `node/src/libs/network/handlers/forkHandlers.ts:62`. Response shape:
  ```ts
  { forks: { osDenomination: { activationHeight: number | null, activated: boolean, currentHeight: number } } }
  ```
- **Cache key**: per-`Demos` instance, scoped by `rpc_url` (mirror the pattern at `_cachedNetworkParametersRpcUrl` in demosclass.ts:1199 — switching network within TTL must invalidate).
- **TTL**: 30s when `activated = true` (won't change again). When `activated = false` and `activationHeight` is non-null, refresh more aggressively as we approach: `min(30s, max(2s, (activationHeight - currentHeight) * blockTime / 4))`. When `activationHeight = null`, TTL = 30s (no fork ever scheduled).
- **First call**: lazy. The first `sign()` call after `connect()` triggers it. The result is cached on the `Demos` instance.
- **Failure modes**: If `getNetworkInfo` errors, returns `{result:500,...}`, or returns a malformed shape: **assume pre-fork** (safest default — produces legacy wire format which the current production node accepts). Log a warning once per `Demos` instance.

### 3.2 Public API behavior

- All public-API methods accept `bigint` (OS units): `Demos.transfer(to, amountOs)`, `Wallet.transfer(to, amountOs, demos)`, `EscrowTransaction.sendToIdentity(..., amountOs)`, etc.
- The SDK's internal arithmetic is always `bigint`-OS.
- At the wire boundary (just before `JSON.stringify(raw_tx.content)` for hashing), the format-switch picks pre-fork vs post-fork serialization.

### 3.3 Serializer chokepoint

Today the SDK has two hash sites:
- `demosclass.ts:513` — `raw_tx.hash = Hashing.sha256(JSON.stringify(raw_tx.content))` (the active path used by `demos.sign()`).
- `DemosTransactions.sign:130` — `raw_tx.hash = await sha256(JSON.stringify(raw_tx.content))` (deprecated alternate signer; still in code).

Plan:
- Add a new utility `src/denomination/serializerGate.ts` that mirrors the node's `forks/serializerGate.ts` design: `serializeTransactionContent(content, isPostFork): string`.
- Pre-fork branch: convert any internal `bigint` amounts back to DEM `number` (since the SDK has been bigint-internally even pre-fork after the migration), then `JSON.stringify(content)`.
- Post-fork branch: convert internal `bigint` to OS decimal string, then `JSON.stringify(content)`.
- Both hash sites call `serializeTransactionContent` instead of `JSON.stringify(raw_tx.content)`.
- The `gcr_edits[]` array is part of `content`; gates need to align with §2.4 option (B). The serializer takes already-correctly-shaped edits and just stringifies. Construction-time correctness is the contract.

### 3.4 Pre-fork sub-DEM rejection

When pre-fork mode and `amountOs % OS_PER_DEM !== 0n`, reject:
```
SubDemPrecisionError: pre-fork node cannot accept sub-DEM precision (amount = 1234567 OS = 0.001234567 DEM). Either upgrade to a post-fork node or round to whole DEM.
```
This guard runs in the public API entry points (`Demos.transfer`, `Wallet.transfer`, `EscrowTransaction.sendToIdentity`, …) **after** fork detection, **before** building the transaction.

### 3.5 Canonical key order

LOG.md Session 9 recorded the canonical wire key order:
```
type, from, to, amount, data, nonce, timestamp, transaction_fee, from_ed25519_address, gcr_edits
```
The SDK's `skeletons.ts` already produces this order via insertion. Migration must preserve insertion order at every construction site (no `Object.assign`, no spread that reorders, no late additions). **Add an integration test that asserts `Object.keys(content)` matches the canonical sequence after `sign()`.**

The skeleton currently lacks `from_ed25519_address` and `gcr_edits`; those are added in `sign()` after construction. Keep that order — `from_ed25519_address` is set at sign:421-426, `gcr_edits` at sign:486 (right before the fee calc and hash). This matches the node's canonical order.

---

## 4. Per-method API changes

| Method | Old signature | New signature | Compat |
|---|---|---|---|
| `Demos.transfer` | `(to: string, amount: number)` | `(to: string, amountOs: bigint)` | break (major) |
| `Demos.pay` | `(to: string, amount: number)` | `(to: string, amountOs: bigint)` | break |
| `Demos.getAddressInfo` | returns `AddressInfo` with `balance: bigint` (FIXME) | returns `AddressInfo` with `balance: bigint` (OS, fixed) | semantics change; FIXME removed |
| `Wallet.transfer` | `(to, amount: number, demos)` | `(to, amountOs: bigint, demos)` | break |
| `Wallet.getBalance` | stub returning `void` | `Promise<bigint>` (OS) and add `wallet.balanceOs`, `wallet.balanceDem` accessors | new API |
| `EscrowTransaction.sendToIdentity` | `(..., amount: number, options?)` | `(..., amountOs: bigint, options?)` | break |
| `EscrowTransaction.claimEscrow` | unchanged signature; internal amount is 0 placeholder | unchanged; internal amount becomes `"0"` | none |
| `EscrowTransaction.refundExpiredEscrow` | as above | as above | none |
| `IPFSOperations.quoteToCustomCharges` | returns `{ maxCostDem: string, ... }` | returns `{ maxCostOs: string, ... }`, applies `demToOs` to quote.cost_dem if node response is still DEM-string | break (rename) |
| `IPFSOperations.createCustomCharges` | returns `{ max_cost_dem, ... }` | returns `{ max_cost_os, ... }` | break |
| `IPFSOperations.createAddPayload`, `createPinPayload` | accept `customCharges.maxCostDem` | accept `customCharges.maxCostOs` | break (rename) |
| `TLSNotaryService.calculateStorageFee` | `(proofSizeKB: number): number` | `(proofSizeKB: number): bigint` | break (return type) |
| `nativeBridge.generateOperation` | `amount: string` (stablecoin) | unchanged — not DEM | none |

For each break, JSDoc gains migration examples, e.g.:
```ts
// v2:
await demos.transfer("0x…", 100)
// v3:
import { demToOs } from "@kynesyslabs/demosdk"
await demos.transfer("0x…", demToOs(100))         // 100 DEM
await demos.transfer("0x…", demToOs("1.5"))       // 1.5 DEM
await demos.transfer("0x…", 1_500_000_000n)        // raw OS bigint
```

---

## 5. Internal arithmetic call sites

After migration, every site listed below must operate on `bigint`-OS, with conversions at boundaries only.

| File | Lines | Current operation | Post-migration |
|---|---|---|---|
| `src/websdk/demosclass.ts` | 631-646, 648-664 | `_calculateAndApplyGasFee` adds `Number(edit.amount)` and `Number(raw_tx.content.amount)` | `BigInt(edit.amount)` (parse OS string), `BigInt` math, store back as OS string. Note: this fallback path runs only when the node's `getNetworkParameters` is missing; it derives the implicit fee from gcr_edits balance-removes minus the user's transferred amount. |
| `src/websdk/GCRGeneration.ts` | 246, 283-294, 333-336, 375-386, 393-403, 408-422, 686-699, 726-744, 762-805 | DEM `number` arithmetic for gas/fees | All BigInt; emit OS strings in edit `amount` fields when post-fork. |
| `src/escrow/EscrowTransaction.ts` | 91, 105, 118, 127, 202, 286 | DEM `number` flowing into edits and content.amount | BigInt input → OS string in tx content + gcr_edits. The `amount.toString()` at L127 needs reviewing — currently calls `.toString()` on a number; should call `toOsString` on the bigint. |
| `src/bridge/nativeBridge.ts` | 125, 130-132 | tx with `amount: 0`, `network_fee: 0`, etc. | `amount: "0"`, `network_fee: "0"`, etc. (post-fork) |
| `src/websdk/utils/skeletons.ts` | 13, 19-21 | initialises `amount: 0`, fee fields `0` | the skeleton produces a `Transaction` shape that gets filled in by callers; widen types so it accepts both numbers (pre-fork) and strings (post-fork). Concretely: the skeleton itself can stop initialising `amount` (remove the field; callers must set it). |
| `src/websdk/DemosTokens.ts` | 86, 90-92, 400, 404 | `amount: 0`, `network_fee: 0` token-tx skeletons | OS strings post-fork |
| `src/abstraction/Identities.ts` | 120, 158 | `amount: 0` placeholders | `"0"` post-fork |
| `src/l2ps/l2ps.ts` | 221 | `amount: 0` placeholder | `"0"` post-fork |
| `src/types/blockchain/TransactionSubtypes/StorageProgramTransaction.ts` | 20 | `FEE_PER_CHUNK = 1n` (bug: 1 OS, intended 1 DEM) | `OS_PER_DEM` |

---

## 6. Test strategy

### 6.1 Unit (new + updated)

- `src/denomination/conversion.test.ts` — already exists from P0; extend with edge cases (negative inputs, max-uint256-ish bigint inputs).
- New: `src/denomination/serializerGate.test.ts` — pre-fork branch produces legacy bytes byte-identical to today's `JSON.stringify(content)`. Post-fork branch produces OS-string bytes byte-identical to the node's `serializeTransactionContent`. Use a fixed canonical TransactionContent fixture; assert on the exact string.
- Update: every existing tx-construction test (`tests/native.spec.ts`, `tests/storagePrograms.spec.ts`, etc.) to use bigint OS where it previously used DEM number.

### 6.2 Compatibility — pre-fork node

- Mock `getNetworkInfo` returning `activated: false, activationHeight: null`.
- Build a transfer tx via `demos.transfer(to, demToOs(100))`.
- Assert wire bytes (the `JSON.stringify` input to `Hashing.sha256`) carry `amount: 100` (number, DEM), not `"100000000000"`.
- Assert the same for fee fields and gcr_edits balance amounts.
- Assert `demos.transfer(to, 1n)` (sub-DEM precision) throws `SubDemPrecisionError`.

### 6.3 Compatibility — post-fork node

- Mock `getNetworkInfo` returning `activated: true, currentHeight: 100, activationHeight: 50`.
- Build same transfer.
- Assert wire bytes carry `amount: "100000000000"` (string, OS).
- Assert gcr_edits[].amount entries are OS strings.
- Assert `demos.getAddressInfo(addr)` parses a post-fork response (`{ balance: "100000000000" }`) into `bigint(100000000000n)` for `info.balance`.

### 6.4 Round-trip with node serializer

- For a fixed TransactionContent fixture (chosen to exercise amount, fee, multi-edit gcr_edits, all key-order positions):
  1. SDK v3 (post-fork mode) computes `hashSdk = sha256(serializeTransactionContent(content, true))`.
  2. Independently, paste the same fixture into a node-side test that calls the node's `serializeTransactionContent(content, blockHeight=N+1)` → `hashNode`.
  3. Assert `hashSdk === hashNode`.
- This is the ground-truth that SDK signatures will validate on the post-fork node. It would be best wired as an SDK test that imports the same fixtures the node tests use (cross-repo coupling — accept this).

### 6.5 Detection / caching tests

- `getNetworkInfo` called once per `Demos` instance under TTL.
- Fork-status cache invalidates on `rpc_url` change.
- Failing `getNetworkInfo` assumes pre-fork; logs once per instance.
- TTL shrinks as `currentHeight` approaches `activationHeight`.

### 6.6 Key-order regression

- `Object.keys(signedTx.content)` matches `[type, from, to, amount, data, nonce, timestamp, transaction_fee, from_ed25519_address, gcr_edits]` after `demos.sign()`.

---

## 7. Build / version / publish

- `package.json`: bump `"version": "2.12.2"` → `"3.0.0-rc.1"`.
- Publish: `bun publish --tag rc` (so caret consumers don't auto-pull).
- Build: no scripts change. Same `tsc --skipLibCheck && resolve-tspaths && …` pipeline; new files in `src/denomination/` get picked up automatically.
- Exports: `src/index.ts` already exports `denomination`. Add `serializerGate` either inside `denomination` (probably best — keeps it co-located) or as a new module. Recommendation: keep it inside `denomination` and **do not** add a top-level export — it's internal infrastructure, not user-facing API.

---

## 8. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | gcr_edits embedded amount nesting (Session 9 flag) | §2 enumerates every construction site; tests assert OS-string at every spot. |
| R2 | Key-order canonicalization drift between SDK & node | §3.5 + §6.6 explicit canonical-order test; cross-repo round-trip test §6.4. |
| R3 | XM (Solana lamports, Aptos octas, XRP drops, etc.) accidentally converted to OS | §1.7 explicit non-target list; lint rule for any `demToOs` call inside `src/multichain/` should fail review. |
| R4 | TON/Tron/NEAR top-level `amount` fields on `tx.content` for cross-chain ops | These flow through `TransactionContent.amount` which **does** become OS string post-fork — but in those flows the user's DEM payment is the `amount`, while the cross-chain target amount lives in the `data` payload (chain-specific units). Reviewer must confirm during implementation that no chain-specific amount has been misrouted into `content.amount`. |
| R5 | Pre-fork node receiving a v3-built tx with sub-DEM precision | §3.4 hard error before tx construction; never reaches the wire. |
| R6 | `getNetworkInfo` failure mode wrong default | Default to pre-fork (legacy format) so old nodes continue working; explicit warn-log so users notice. |
| R7 | Fork status cache stale across `connect()` to a different RPC | TTL keyed on `rpc_url`; mirrors existing pattern in demosclass.ts. |
| R8 | `Wallet.transfer()` sets `tx.content.from = demos.keypair.publicKey…` overwriting the field — this is unrelated but visible during the migration. Don't fix in P4. | Note in commit message; defer. |
| R9 | Storage program `FEE_PER_CHUNK = 1n` is currently 1 OS not 1 DEM (pre-existing bug) | P4 fixes by replacing with `OS_PER_DEM`. Increases storage fees by 10^9 — call out in changelog. |
| R10 | Node-side `STORAGE_PROGRAM_FEE_PER_CHUNK` in `GCRStorageProgramRoutines.ts` is `1n` and unchanged by the migration. After fork, node will charge 1 OS per chunk while pre-fork it charged 1 DEM (= now 1 OS in stored balance). Fee crashes by 10^9. | This is a **node-side** issue not in P4 scope; flag for P5/P6. P4 still aligns SDK constants with `OS_PER_DEM` (the user-intended 1 DEM/chunk). The post-fork SDK will produce edits that node will only charge 1 OS for — fee under-collection. Document this for P5 to address. |
| R11 | Skeleton `transaction.content.amount: 0 // number` initialises a numeric. Post-fork serializer will see `0` and need to coerce. | Either (a) remove the skeleton field and require callers to set it, or (b) initialise as `0n` bigint and coerce at serialize-time. (a) is cleaner; pick during implementation. |
| R12 | `_calculateAndApplyGasFee` fallback uses `Number(edit.amount)` and silently drops precision for OS-magnitude values | Migrate the math to BigInt; this fallback runs rarely (only when `getNetworkParameters` is missing) but values are large enough to overflow Number once they're OS. |
| R13 | Tests in `src/tests/*.spec.ts` use DEM number literals; many assertions on `amount: 100` etc. | Sweep + replace under §6.1 update step. Risk: missed test that silently keeps passing because `Number == String` fails type-check. TS strict mode catches these at build. |
| R14 | Public consumers of v2.x (e.g., docs, examples) reference `amount: number` | Update README, examples, JSDoc as part of the same release. P7 (final v3.0.0) is the formal docs sweep but RC ships with usable docs. |

---

## 9. Phasing within P4 (commit sequence)

P4 is one shippable RC. For review hygiene we propose 5 commits. Each is reviewable but only the final commit leaves the SDK fully buildable + tests green; intermediate commits use TS escapes (`@ts-expect-error`, `as unknown as ...`) where required. Call this out in commit messages.

### Commit 1 — `feat(types): widen amount/fee/balance fields to OS string`
Updates: `TxFee.ts`, `Transaction.ts`, `rawTransaction.ts`, `statusNative.ts`, `StateChange.ts`, `D402PaymentTransaction.ts`, `bridgeTradePayload.ts`, `EscrowPayload`, `GCREdit.ts` (Balance/Escrow), `nativeBridgeTypes.ts` (EVMTankData/SolanaTankData/legacy), `CustomCharges.ts` (rename).
**Buildable**: NO. Will produce many type errors at construction sites — that's the point. Use `@ts-expect-error` on the offending sites with a TODO referencing commit 2.

### Commit 2 — `feat(construction): bigint internal arithmetic + OS-string emission at boundaries`
Updates: `GCRGeneration.ts` (all handlers), `EscrowTransaction.ts`, `nativeBridge.ts`, `skeletons.ts`, `DemosTokens.ts`, `Identities.ts`, `l2ps.ts`, `_calculateAndApplyGasFee` in `demosclass.ts`. Tests still using DEM-number literals are temporarily skipped with a `// TODO P4 commit 5` marker.
**Buildable**: YES (with the test-skips). Existing tests in `tests/` may break — re-enable in commit 5.

### Commit 3 — `feat(serializer): dual-format serializerGate`
Adds: `src/denomination/serializerGate.ts` (mirrors node design, includes pre-fork `bigint→number` coercion and post-fork `bigint→OS-string` coercion). Wires both hash sites in `demosclass.ts` and `DemosTransactions.ts` to use it. Default `isPostFork = false` until commit 4.
**Buildable**: YES.

### Commit 4 — `feat(rpc): getNetworkInfo fork detection + sub-DEM guard + public API bigint`
Adds: `Demos.getNetworkInfo()` (typed RPC wrapper), `Demos._cachedForkStatus` + TTL+rpc-url-keyed cache, `_getForkStatusCached` helper. Threads cached fork status into `sign()` → `serializerGate` → `GCRGeneration`. Flips public API: `Demos.transfer(to, amountOs: bigint)`, `Wallet.transfer(..., amountOs: bigint, ...)`, `EscrowTransaction.sendToIdentity(..., amountOs: bigint, ...)`. Adds `SubDemPrecisionError`. Fixes `getAddressInfo` FIXME by parsing OS-string when `activated`, BigInt-DEM-multiplied otherwise; or accepting either shape and normalizing.
**Buildable**: YES, with new tests for compatibility paths.

### Commit 5 — `chore: tests + version bump + jsdoc`
Re-enables/rewrites all skipped tests. Adds the new tests from §6.1-6.6. Bumps `package.json` to `3.0.0-rc.1`. JSDoc + examples updated. `CHANGELOG.md` entry.
**Buildable**: YES. Tests green. Ready to publish.

### Why not split further
- Splitting commit 1 from commit 2 is forced — type changes break construction sites. No way to land them in one buildable commit.
- Combining commit 3 with commit 4 hides the dual-format infrastructure inside the public-API change. Separating them lets us review the serializer in isolation.
- Commit 5 is mostly mechanical and could be dropped into commit 4, but separating gives clean reviewability (no test churn obscuring the API change).

If review concludes that commit 1's broken-build state is unacceptable, fold commits 1 and 2 into a single mega-commit. We deliberately did **not** propose that as the default because it's harder to review.

---

## 10. Acceptance for P4

- All SDK tests pass (existing + new from §6).
- TypeScript strict-mode build clean.
- `bun run build` succeeds; output verified to include `denomination/serializerGate.{js,d.ts}`.
- `package.json.version === "3.0.0-rc.1"`.
- Cross-repo SPEC §3 P4 acceptance items all satisfied:
  - SDK works against pre-fork node (legacy format, no precision-loss surprises).
  - SDK works against post-fork node (OS format, hashes match node).
  - Sub-DEM precision rejected pre-fork.
  - First call to `getNetworkInfo` cached; not called per-tx.
- Implementation Report delivered (per agent template).

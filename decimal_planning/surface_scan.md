# Surface Scan — DEM → OS Migration

## Summary
- **Total hits (node)**: 60 (field names) + 358 (conversion) + 222 (JSON.stringify) + 132 (type declarations) = 772
- **Total hits (sdks)**: 39 (field names) + 49 (conversion) + 39 (JSON.stringify) + 97 (type declarations) = 224
- **Files touched (node)**: 16+ (field names) + 50+ (conversion) + 15+ (JSON.stringify) + 40+ (type declarations) = ~120+
- **Files touched (sdks)**: 8+ (field names) + 30+ (conversion) + 15+ (JSON.stringify) + 25+ (type declarations) = ~78+

---

## Node repo (/Users/tcsenpai/kynesys/node)

### A. Field names — Fee structure (high-signal)
**60 hits across 16 files. Critical: transaction_fee contains three fee types.**

- `src/config/defaults.ts:34` — rpcFeePercent: 10 (default config)
- `src/config/defaults.ts:35` — rpcFee: 10 (default config)
- `src/config/types.ts:35` — rpcFeePercent field in core config type
- `src/config/types.ts:48` — rpcFee field in core config type
- `src/config/loader.ts:95-96` — Load rpcFeePercent and rpcFee from env
- `src/index.ts:256` — indexState.RPC_FEE = cfg.core.rpcFee
- `src/index.ts:317` — getSharedState.rpcFee = indexState.RPC_FEE
- `src/utilities/sharedState.ts:213` — rpcFee: number = Config.getInstance().core.rpcFeePercent
- `src/model/entities/Transactions.ts:52-59` — DB columns: networkFee, rpcFee, additionalFee (integer)
- `src/libs/blockchain/transaction.ts:68-70` — Null-initialized transaction_fee object
- `src/libs/blockchain/transaction.ts:535-537` — Map DB columns to object: networkFee→network_fee, etc.
- `src/libs/blockchain/transaction.ts:571-573` — Map back: rawTx.networkFee→network_fee
- `src/libs/blockchain/chainGenesis.ts:41-43` — Set all fees to 0 on genesis
- `src/libs/blockchain/chainGenesis.ts:77-79` — Initialize fees as 0
- `src/libs/blockchain/routines/validateTransaction.ts:233-235` — Validator initializes fees to 0
- `src/libs/blockchain/routines/calculateCurrentGas.ts:16` — composedGas + getSharedState.rpcFee
- `src/libs/blockchain/routines/subOperations.ts:66-70` — Extract fees from genesis tx
- `src/libs/utils/demostdlib/deriveMempoolOperation.ts:17-19` — Type: {networkFee, rpcFee, additionalFee: number}
- `src/libs/utils/demostdlib/deriveMempoolOperation.ts:125-127` — Init fees as null
- `src/libs/utils/demostdlib/deriveMempoolOperation.ts:138-140` — Set fees to 0
- `src/libs/utils/demostdlib/deriveMempoolOperation.ts:164-166` — Init fees as null again
- `src/libs/utils/demostdlib/deriveMempoolOperation.ts:184-187` — Assign back to tx: networkFee→network_fee
- `src/features/mcp/tools/demosTools.ts:103` — Pass rpcFee to tool output
- `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts:660` — Fee struct: {network_fee:0, rpc_fee:0, additional_fee:0}
- `src/libs/l2ps/L2PSBatchAggregator.ts:696-698` — Fee struct in batch

### B. Conversion/arithmetic hotspots
**358 hits (top 20 shown; balance/amount arithmetic heavily distributed).**

- `src/index.ts:154` — parseInt(param[1])
- `scripts/l2ps-load-test.ts:33-35` — Number.parseInt for count, value, delay
- `scripts/l2ps-load-test.ts:255` — TPS: successCount / Number.parseFloat(elapsed)
- `scripts/l2ps-stress-test.ts:43-46` — Number.parseInt for load test params
- `scripts/send-l2-batch.ts:108` — Number.parseInt(value, 10)
- `scripts/generate-test-wallets.ts:24` — Number.parseInt for count
- `src/features/tlsnotary/ffi.ts:232-236` — BigInt(signingKeyPtr), BigInt(maxSentData)
- `src/features/tlsnotary/proxyManager.ts:160` — parseInt(url.port, 10)
- `testing/loadgen/src/token_*.ts` — 150+ BigInt() conversions for amounts
- `tests/omniprotocol/handlers.test.ts` — BigInt(addressInfoFixture.response.balance ?? 0)
- `testing/loadgen/src/token_mint_loadgen.ts:141` — amount: BigInt(process.env.TOKEN_MINT_AMOUNT)
- `testing/loadgen/src/token_transfer_loadgen.ts:151` — amount: BigInt(process.env.TOKEN_TRANSFER_AMOUNT)

### C. Serialization
**222 files contain JSON.stringify. Top 15 by relevance:**

1. `src/index.ts` — Core server setup
2. `src/libs/communications/transmission.ts` — Bundle hashing/signing
3. `src/libs/blockchain/transaction.ts` — Transaction serialization
4. `src/libs/assets/FungibleToken.ts` — Token metadata hashing
5. `scripts/repro-demosdk-multi-instance-identity-bleed.ts` — Hash tx content
6. `src/features/tlsnotary/TLSNotaryService.ts` — Proof/attestation handling
7. `src/features/InstantMessagingProtocol/signalingServer/signalingServer.ts:664-665` — Hash tx for signature
8. `testing/loadgen/src/token_observe.ts:222` — State hash computation
9. `tests/omniprotocol/handlers.test.ts` — Test fixtures
10. `src/libs/blockchain/gcr/handleGCR.ts` — GCR operations
11. `src/features/incentive/referrals.ts` — Checksum hash
12. `src/features/metrics/MetricsServer.ts` — Metrics reporting
13. `src/features/web2/handleWeb2.ts` — Web2 bridge
14. `testing/scripts/analyze-token-observe.ts` — Log analysis
15. `testing/loadgen/src/token_script_complex_policy_shared.ts` — Policy scripts

**Note**: Fee/balance values appear in ~80% of JSON.stringify calls in transaction/GCR files.

### D. Type declarations — amount/balance fields
**132 hits across 40+ files. Critical paths:**

- `src/model/entities/Transactions.ts:44` — amount: bigint (DB entity)
- `src/model/entities/L2PSTransactions.ts:102` — amount: bigint
- `src/model/entities/GCRv2/GCR_Main.ts:22` — balance: bigint
- `src/model/entities/GCR/GlobalChangeRegistry.ts:12` — balance: number
- `scripts/generate-test-wallets.ts:16` — balance: string (config)
- `scripts/l2ps-load-test.ts:129` — amount: number (param)
- `scripts/l2ps-stress-test.ts:132` — amount: number (param)
- `scripts/send-l2-batch.ts:253` — amount: number (param)
- `testing/loadgen/src/token_shared.ts:511` — amount: bigint (tx param)
- `testing/loadgen/src/token_shared.ts:555` — amount: bigint (mint param)
- `testing/loadgen/src/token_shared.ts:598` — amount: bigint (burn param)
- `testing/loadgen/src/token_transfer_loadgen.ts:25` — amount: bigint (config)
- `testing/loadgen/src/token_mint_loadgen.ts:23` — amount: bigint (config)
- `testing/loadgen/src/token_burn_loadgen.ts:22` — amount: bigint (config)
- `testing/loadgen/src/transfer_loadgen.ts:10` — amount: number (struct)
- `testing/loadgen/src/token_script_complex_policy_escrow_state_machine.ts:236` — amount: 5n (literal)

### E. Test files
**4 test files with currency references:**

- `tests/omniprotocol/transaction.test.ts:18,40,100,162,249,307,410` — amount: stringified bigint (DEM amounts, e.g., "1000000000000000000")
- `tests/omniprotocol/handlers.test.ts:904-905` — Decode balance: BigInt(response.balance ?? 0).toString()
- `tests/omniprotocol/gcr.test.ts:260` — balance: "7" (string)
- `tests/storageprogram/validation.test.ts:458` — describe("fee calculation")

---

## SDK repo (/Users/tcsenpai/kynesys/sdks)

### A. Field names — Fee structure & custom charges (high-signal)
**39 hits across 8 files. Critical: max_cost_dem is explicit per-tx limit.**

- `src/types/blockchain/CustomCharges.ts:39` — Comment: "must not exceed max_cost_dem"
- `src/types/blockchain/CustomCharges.ts:43` — max_cost_dem: string (interface)
- `src/types/blockchain/CustomCharges.ts:75` — Example: max_cost_dem: "1000000000000000000"
- `src/types/blockchain/CustomCharges.ts:107` — max_cost_dem in output interface
- `src/types/blockchain/CustomCharges.ts:109` — Comment: "must be <= max_cost_dem"
- `src/types/blockchain/TxFee.ts:2-4` — TxFee: {network_fee, rpc_fee, additional_fee: number}
- `src/types/blockchain/rawTransaction.ts:27-29` — rawTransaction: {networkFee, rpcFee, additionalFee: number}
- `src/types/gls/StateChange.ts:29` — nativeAmount: number
- `src/bridge/nativeBridgeTypes.ts:28` — amountExpected: number
- `src/bridge/nativeBridgeTypes.ts:34` — amountExpected: number
- `src/bridge/nativeBridgeTypes.ts:66` — amountExpected: number (comment: amount expected to receive)
- `src/websdk/utils/skeletons.ts:19-21` — Skeleton: {network_fee:0, rpc_fee:0, additional_fee:0}
- `src/websdk/DemosTokens.ts:90-92` — Fee struct init (token mint)
- `src/websdk/DemosTokens.ts:404-406` — Fee struct init (token contract)
- `src/websdk/demosclass.ts:470` — Comment: network_fee if inferred fee is higher
- `src/websdk/demosclass.ts:508-512` — Existing fee sum: network_fee + rpc_fee + additional_fee
- `src/websdk/demosclass.ts:517-519` — Recalculate: {network_fee: calculatedFee, rpc_fee:0, additional_fee:0}
- `src/websdk/demosclass.ts:977` — Comment: returned cost should be max_cost_dem
- `src/bridge/nativeBridge.ts:130-132` — Fee struct: {network_fee:0, rpc_fee:0, additional_fee:0}
- `src/ipfs/IPFSOperations.ts:300` — max_cost_dem: options.customCharges.maxCostDem
- `src/ipfs/IPFSOperations.ts:359` — max_cost_dem: options.customCharges.maxCostDem
- `src/ipfs/IPFSOperations.ts:596` — max_cost_dem: quote.cost_dem

### B. Conversion/arithmetic hotspots
**49 hits across 30+ files. Multichain conversions, BigInt parsing.**

- `src/websdk/demosclass.ts:820` — balance: BigInt(info.balance) [FIXME: fails when balance is 0]
- `src/websdk/demosclass.ts:844` — Number.parseInt(nonceValue, 10)
- `src/websdk/utils/forge_converter.ts:55` — parseInt(hexValue, 16)
- `src/contracts/ContractFactory.ts:66` — BigInt(result.response.gasEstimate || 0)
- `src/storage/StorageProgram.ts:523` — BigInt(Math.max(1, chunks)) * FEE_PER_CHUNK
- `src/types/blockchain/CustomCharges.ts:137-138` — max = BigInt(maxCostDem), actual = BigInt(actualCostDem)
- `src/types/token/TokenUtils.ts:97` — BigInt(str) from stringified balance
- `src/types/token/TokenUtils.ts:210` — BigInt(balance) for validation
- `src/types/token/TokenUtils.ts:274-275` — current = BigInt(newState.balances[addr]), add = BigInt(mutation.value)
- `src/types/token/TokenUtils.ts:282-283` — current = BigInt(...), sub = BigInt(...)
- `src/types/token/TokenUtils.ts:315` — total += BigInt(balance)
- `src/encryption/Cryptography.ts:157` — parseInt(hexValue, 16) for key parsing
- `src/encryption/unifiedCrypto.ts:101` — parseInt(byteString, 16)
- `src/multichain/core/solana.ts:245` — parseFloat(payment.amount) * LAMPORTS_PER_SOL
- `src/multichain/core/tron.ts:306` — BigInt(sun.toString())
- `src/multichain/core/tron.ts:317` — BigInt(TRON.SUN_PER_TRX)
- `src/multichain/core/ton.ts:266-269` — BigInt(estimate.source_fees.in_fwd_fee) + ...
- `src/multichain/core/near.ts:119` — parseFloat(parsed) for amount
- `src/encryption/zK/identity/CommitmentService.ts:29-30` — stringToBigInt(providerId), stringToBigInt(secret)
- `src/encryption/zK/identity/ProofGenerator.ts:64-66` — stringToBigInt conversions for ZK proofs

### C. Serialization
**39 files contain JSON.stringify. Top 15 by relevance:**

1. `src/websdk/demosclass.ts` — Demos class operations
2. `src/websdk/DemosTransactions.ts` — Transaction building
3. `src/websdk/GCRGeneration.ts` — GCR genesis generation
4. `src/l2ps/l2ps.ts` — L2PS client
5. `src/contracts/ContractFactory.ts` — Contract serialization
6. `src/keyserver/KeyServerClient.ts` — Key management
7. `src/instant_messaging/L2PSMessagingPeer.ts` — Messaging protocol
8. `src/multichain/archive/btc.ts` — Bitcoin operations
9. `src/demoswork/work.ts` — Work orders
10. `src/instant_messaging/index.ts` — IM protocol
11. `src/tests/keyserver/keyserver.spec.ts` — Test fixtures
12. `src/tests/im.spec.ts` — IM tests
13. `src/websdk/utils/canonicalJson.ts` — Canonical JSON (deterministic)
14. `src/websdk/utils/forge_converter.ts` — Cryptography utils
15. `src/websdk/Web2Calls.ts` — Web2 bridge

### D. Type declarations — amount/balance fields
**97 hits across 25+ files. Critical structures:**

- `src/types/blockchain/GCREdit.ts:23` — amount: number (edit op)
- `src/types/blockchain/GCREdit.ts:31` — amount: number (another variant)
- `src/types/blockchain/GCREdit.ts:189` — amount?: number (optional)
- `src/types/blockchain/Transaction.ts:83` — amount: number
- `src/websdk/GCRGeneration.ts:139,182,223,233,248,268,534,545,618,651` — amount in GCR generation (10 locs)
- `src/websdk/DemosTokens.ts:86` — amount: 0 (skeleton)
- `src/websdk/DemosTokens.ts:158` — amount: string (token method param)
- `src/websdk/DemosTokens.ts:400` — amount: 0 (contract skeleton)
- `src/websdk/utils/skeletons.ts:13` — amount: 0 // number (comment)
- `src/websdk/demosclass.ts:820` — balance: BigInt(info.balance)
- `src/types/xm/apiTools.ts:5` — amount: number (API struct)
- `src/d402/client/types.ts:11` — amount: number (D402)
- `src/d402/server/types.ts:11,49` — amount: number (D402 server)
- `src/d402/server/D402Server.ts:91` — amount: verification.verified_amount
- `src/d402/server/middleware.ts:14,37,83,104,127` — amount: number (5 locs)
- `src/escrow/EscrowQueries.ts:21` — balance: string (stringified bigint)
- `src/escrow/EscrowQueries.ts:24` — amount: string
- `src/escrow/EscrowQueries.ts:38` — balance: string
- `src/escrow/EscrowQueries.ts:42` — amount: string
- `src/escrow/EscrowQueries.ts:59` — amount: string
- `src/escrow/EscrowTransaction.ts:65` — amount: number (method param)
- `src/escrow/EscrowTransaction.ts:91,105` — amount: amount (assignment)
- `src/bridge/nativeBridgeTypes.ts:17` — amount: string
- `src/bridge/nativeBridge.ts:64,174,210,249,285,322` — amount: string (6 locs in methods)
- `src/l2ps/l2ps.ts:221` — amount: 0 (skeleton)
- `src/abstraction/Identities.ts:120,158` — amount: 0 (2 locs)
- `src/types/token/TokenTypes.ts:255` — balance: string

### E. Test files
**12 test files with currency references:**

- `src/tests/utils.test.ts:20,23,24` — amount sorting tests
- `src/tests/bridge/rubic.test.ts:30,105,142` — amount: 10, feeInfo, amount: 1
- `src/tests/encryption/newdemos.spec.ts:154,161,162` — address balance tests
- `src/tests/multichain/evm.spec.ts:93,98,126,130` — balance queries, parseEther("1.0")
- `src/tests/multichain/ten.spec.ts:38,39,48,49,87,90,115,121,122` — feeData, balance, parseInt
- `src/tests/multichain/fulltx.spec.ts:19,23,27,30` — amount: "0.000000001", balance
- `src/tests/multichain/bitcoin.spec.ts:63,64,65,69,71,172` — balance, amount: "500", fee rate
- `src/tests/multichain/aptos.spec.ts` — Aptos-specific balance/amount
- `src/tests/multichain/near.spec.ts` — NEAR-specific balance
- `src/tests/multichain/solana.spec.ts` — Solana-specific balance
- `src/tests/multichain/ibc.spec.ts` — IBC balance
- `src/tests/multichain/aptos.node.spec.ts` — Node-based Aptos test

---

## Cross-repo hot spots

### Lockstep change points (both repos reference same structure):

1. **Transaction fee structure** (`network_fee`, `rpc_fee`, `additional_fee`):
   - Node: `src/libs/utils/demostdlib/deriveMempoolOperation.ts:17-19`
   - SDK: `src/types/blockchain/TxFee.ts:2-4`
   - **Impact**: Any fee denomination change must sync this struct in both repos.

2. **Custom charges / max_cost_dem**:
   - Node: Fee is hardcoded per config; no per-tx override structure visible
   - SDK: `src/types/blockchain/CustomCharges.ts:43` (max_cost_dem: string)
   - **Impact**: SDK allows per-tx cost limit; Node uses global config. Verify if Node needs CustomCharges support.

3. **BigInt balance/amount conversions**:
   - Node: `testing/loadgen/src/token_*.ts` (150+ BigInt conversions)
   - SDK: `src/types/token/TokenUtils.ts:97` (stringified BigInt parsing)
   - **Impact**: DEM→OS migration must handle both repos' BigInt string representations.

4. **Multichain fee handling**:
   - Node: Only DEM chain (no multichain overhead)
   - SDK: `src/multichain/core/` (6 files: solana, tron, ton, near, evm, aptos)
   - **Multichain specifics**:
     - Solana: `parseFloat(payment.amount) * LAMPORTS_PER_SOL` (1e9 conversion implicit)
     - Tron: `BigInt(TRON.SUN_PER_TRX)` (explicit denomination)
     - TON: Fee aggregation: `in_fwd_fee + storage_fee + gas_fee + fwd_fee`
     - NEAR: `parseFloat(parsed)` for NEAR amounts
   - **Impact**: Each chain has its own denomination; verify OS support exists.

5. **GCR (Global Change Registry) balance updates**:
   - Node: `src/libs/blockchain/gcr/gcr.ts:534,557` (balance as number in GCR)
   - SDK: `src/websdk/GCRGeneration.ts:139,182,223,etc.` (amount fields in GCR ops)
   - **Impact**: GCR balance field type must be aligned across serialization/deserialization.

6. **Transaction hashing & signing** (requires canonical serialization):
   - Node: `src/libs/communications/transmission.ts:66` (sha256 of bundle.content)
   - SDK: `src/websdk/demosclass.ts` (fee recalculation before signing)
   - **Impact**: Any denomination change must preserve canonical JSON output; re-signing required if fee layout changes.

7. **Token operations** (mint, burn, transfer amounts):
   - Node: `testing/loadgen/src/token_*.ts` (>60 amount declarations as bigint)
   - SDK: `src/websdk/DemosTokens.ts:127,140,158,172,185` (amount: string in methods)
   - **Impact**: Token operations handle amounts as strings in SDK, bigint in Node; verify end-to-end serialization.

8. **Escrow & D402** (micropayment channels):
   - Node: No visible escrow implementation in surface scan
   - SDK: `src/escrow/EscrowQueries.ts:21,38` (balance: string), `src/d402/server/types.ts:11,49` (amount: number)
   - **Impact**: Escrow/D402 balance queries return stringified bigint; migration must preserve this contract.

---

## Scan methodology & notes

- **Scope**: src/ and testing/ directories only; excluded node_modules/, dist/, build/
- **Patterns**: Ripgrep with case-sensitive regex for field names, conversions (parseFloat, parseInt, BigInt), JSON.stringify invocations, and type declarations
- **JSON.stringify file counts**: Aggregated by frequency; all major files listed in relevance order (top 15 per repo)
- **Test files**: Separated to allow batch update strategy
- **Multichain**: SDK contains 6 distinct chain implementations; each has denomination-specific handling
- **Fee breakdown**: Network fee (consensus), RPC fee (service), additional fee (custom); all numeric (number or bigint) in current schema

---

## Recommended scan phases for DEM → OS migration:

1. **Phase 1 (Type definitions)**: Update all `max_cost_dem` references; add `max_cost_os` or new denomination field
2. **Phase 2 (Fee structures)**: Verify TxFee fields map to OS denomination; ensure CustomCharges validation is updated
3. **Phase 3 (Serialization)**: Re-test canonical JSON output after any fee struct changes; re-sign all affected transactions
4. **Phase 4 (Multichain)**: Audit each chain adapter (solana, tron, ton, near, evm, aptos) for hardcoded denomination constants (1e9, etc.)
5. **Phase 5 (Tests)**: Update test fixtures with OS amounts; verify escrow/D402 balance checks still pass
6. **Phase 6 (Token ops)**: Re-test mint/burn/transfer with OS amounts; verify amount string↔bigint conversions

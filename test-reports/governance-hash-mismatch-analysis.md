# Governance hash mismatch — root-cause analysis

**Discovered:** 2026-05-29, while running `scripts/dev-node-battery.ts` against
`http://dev.node2.demos.sh:53552` (node v0.9.8, commit `a0957941`, branch
`stabilisation`, dirty=true, osDenomination fork active).

## TL;DR

`DemosTransactions.proposeNetworkUpgrade()` + `demos.sign()` produces a
transaction whose `tx.hash` does not match the hash the receiving node
re-derives in `Transaction.isCoherent()`. The node rejects the tx with:

```
[Tx Validation] [SIGNATURE ERROR] Transaction hash mismatch
```

Same boundary works fine for `pay()`, `stake()`, `unstake()` on the same
node, same fork, same wallet. The break is specific to the `networkUpgrade`
(and by extension `networkUpgradeVote`) content shape.

The reason a wide test suite (10 governance test files, an SDK builder
smoke test, full unit suite passing) shipped without catching it: **the
SDK-builder→node-validator boundary is never exercised end-to-end for
governance txs.** Every test cuts the wire at exactly the spot where the
bug lives.

## Reproduction

```bash
# stress-test-mnemonic at repo root is funded on dev.node2
RPC=http://dev.node2.demos.sh:53552 bunx tsx scripts/dev-node-battery.ts
```

Stages 0/1/3/3a/5a/6/7 pass. Stages 4 (propose) and 5 (vote) fail —
[test-reports/dev-node-battery-FINAL.md](dev-node-battery-FINAL.md).

## What the node check actually does

[src/libs/blockchain/transaction.ts:289-304](../src/libs/blockchain/transaction.ts#L289-L304)

```ts
public static isCoherent(tx: Transaction, blockHeight?: number) {
    const height = blockHeight ?? getSharedState.lastBlockNumber ?? 0
    const derivedHash = Hashing.sha256(
        serializeTransactionContent(tx.content, height),
    )
    return derivedHash === tx.hash
}
```

The node takes the wire `tx.content`, runs it through
`serializeTransactionContent` ([src/forks/serializerGate.ts:128-136](../src/forks/serializerGate.ts#L128-L136)),
sha256's the result, and compares to the `tx.hash` the SDK shipped.

## What the SDK check is supposed to mirror

[node_modules/@kynesyslabs/demosdk/build/websdk/demosclass.js:523-540](../node_modules/@kynesyslabs/demosdk/build/websdk/demosclass.js#L523-L540)

```js
const isPostFork = await this._isPostForkCached();
const serialized = serializeTransactionContent(raw_tx.content, isPostFork);
raw_tx.hash = Hashing.sha256(serialized);
raw_tx.content = JSON.parse(serialized);   // normalise wire shape to bytes that committed to the hash
```

Both sides ostensibly call the "same" `serializeTransactionContent`.
Module identity differs (SDK ships its own copy under
`@kynesyslabs/demosdk/build/denomination/serializerGate.js`; node imports
from `@/forks`), but the post-fork branch was meant to be byte-identical.

## The divergence

There are **two** semantic differences between the SDK's serializer and
the node's serializer, both in the post-fork (`osDenomination` active)
branch:

### Divergence 1 — `gcr_edits[]` walking

**SDK** ([build/denomination/serializerGate.js:203-225](../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js#L203-L225)) walks `gcr_edits[]` and rewrites
`balance.amount`, `escrow.data.amount`, and `validatorStake.amount`
through `toPostForkWireString`.

**Node** ([src/forks/serializerGate.ts:73-108](../src/forks/serializerGate.ts#L73-L108)) does **not** walk `gcr_edits[]`. The
docstring (line 63-67) is explicit: "Fields other than `amount` and
`transaction_fee` are passed through verbatim. In particular,
`gcr_edits[].amount` is not transformed here."

The intent (line 64-68): SDK is the source of truth for gcr_edits; the
node's serializer just passes them through.

**This only works as long as the SDK has already canonicalised every
amount carrier in `gcr_edits` to a string before `serialize` runs.** Any
internal `bigint` (or DEM `number`) left in `gcr_edits` will be
re-stringified by the SDK but pass through unchanged on the node →
mismatched bytes.

### Divergence 2 — `transaction_fee` key order / extra fields

**SDK** ([build/denomination/serializerGate.js:215-220](../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js#L215-L220)):

```js
transformed.transaction_fee = {
    ...fee,
    network_fee: toPostForkWireString(fee.network_fee),
    rpc_fee: toPostForkWireString(fee.rpc_fee),
    additional_fee: toPostForkWireString(fee.additional_fee),
};
```

Spreads the source `fee` (preserving insertion order + any extra fields
the SDK doesn't know about), then overwrites the three numeric carriers
in place.

**Node** ([src/forks/serializerGate.ts:88-105](../src/forks/serializerGate.ts#L88-L105)):

```ts
transformed.transaction_fee = {
    network_fee: denomination.toOsString(toOsBigint(fee.network_fee)),
    rpc_fee: denomination.toOsString(toOsBigint(fee.rpc_fee)),
    additional_fee: denomination.toOsString(toOsBigint(fee.additional_fee)),
    rpc_address: fee.rpc_address ?? null,
}
```

Builds a fresh 4-key object in fixed order. Drops any extra fields the
SDK might pass through, and pins the order to
`network_fee, rpc_fee, additional_fee, rpc_address`.

**The order is consensus-critical** (JSON.stringify uses insertion
order). If `_calculateAndApplyGasFee` or `_getNetworkParametersCached`
ever populates `transaction_fee` with a different key order — say the
SDK happens to read `rpc_address` first from the cached network-info
response — the spread-then-overwrite keeps `rpc_address` at position 0
while the node's rebuild puts it at position 3 → divergent bytes → hash
mismatch.

### Why this fires for `networkUpgrade` but not `pay`

I haven't proved which divergence is the proximate cause on dev.node2
(I'd need its debug log of `derivedHash` vs `tx.hash` plus the raw
serialised bytes). My probe locally reproduces the SDK-side hash exactly
on both PAY and PROPOSE — meaning the divergence is sensitive to
something the SDK runs *on the wire*, not in pure serializer logic.

The two prime suspects on dev.node2:

1. **Node version says `"dirty": true`** — the deployed node was built
   from a working tree with uncommitted local changes. The committed
   `a0957941` matches the source I read, but the running binary may have
   extra modifications that touch `serializeTransactionContent` or the
   handler path. I cannot inspect those without log access.

2. **`networkUpgrade` happens to enter `_calculateAndApplyGasFee` /
   `_getNetworkParametersCached` differently than `pay`.** The SDK code
   path is shared, but `networkUpgrade` has `amount: 0` while `pay` has
   a real OS amount; if any helper short-circuits on zero or
   re-canonicalises `"0"` differently than `"1000000000"`, the resulting
   `transaction_fee` object can come out in a different key order.

## Why the test suite never caught it

I checked every file that mentions governance or proposeNetworkUpgrade:

| File | What it does | What it skips |
|------|--------------|---------------|
| [scripts/upgradable-network/sdk-builders.test.ts](../scripts/upgradable-network/sdk-builders.test.ts) | Calls `DemosTransactions.proposeNetworkUpgrade(...)` → `assertShape(tx)` | **Never sends the tx to a node.** `assertShape` checks `tx.content.type`, the `[type, payload]` tuple, that `tx.hash` is *populated* (truthy), that `tx.signature` is *populated*. Does NOT compare `tx.hash` to a node-derived hash. Does NOT call `confirm()`. |
| [tests/governance/e2e.test.ts](../tests/governance/e2e.test.ts) | Asserts proposal lifecycle, voting weights, activation, tally edges | **Explicit comment line 411-413: "Tests bypass the SDK so we replay this step inline."** Constructs `gcr_edits` manually via `attachGovernanceEdit(tx)` — never goes through `DemosTransactions.proposeNetworkUpgrade` + `demos.sign()`. |
| [tests/governance/handleGovernanceTx.test.ts](../tests/governance/handleGovernanceTx.test.ts) | Validates `handleGovernanceTx` semantics (validator status, safety bounds, replay) | Hand-crafted tx fixtures, never wires through `confirmTx` / `isCoherent`. |
| [tests/governance/applyNetworkUpgrade.test.ts](../tests/governance/applyNetworkUpgrade.test.ts) | Validates `GCRNetworkUpgradeRoutines.applyProposal` | Constructs `GCREdit` objects directly. Pure node-side logic. |
| [tests/governance/concurrentProposals.test.ts](../tests/governance/concurrentProposals.test.ts) | Multi-proposer races, key overlap | Same — pure node-side. |
| [tests/governance/safetyBounds.test.ts](../tests/governance/safetyBounds.test.ts) | 50%-change rule, absolute floors | Pure validator on `proposedParameters`. |
| [tests/governance/snapshotWeightIntegrity.test.ts](../tests/governance/snapshotWeightIntegrity.test.ts) | Validator-snapshot pinning at confirm time | Pure node-side. |

**Pattern:** every governance test cuts the wire at one of two places:

```
SDK builder ─── sign ─── confirm ─── isCoherent ─── handleGovernanceTx ─── GCR apply
       │                    │                              │                      │
       └─ sdk-builders test  │                              └─ handleGovernanceTx  └─ applyNetworkUpgrade
          stops HERE         │                                 test starts HERE      test starts HERE
                             │
                             └─ no test crosses this boundary for governance txs
```

The `isCoherent` step is the one that fires. **No governance test wires
the SDK builder through `confirm` end-to-end.**

By contrast, the native-pay boundary IS exercised end-to-end — both by
the agent-commerce-demo broadcast pipeline (which `demos.pay()` →
`demos.confirm()` → `demos.broadcast()` against a real node) and by
[`node_modules/@kynesyslabs/demosdk/build/denomination/roundTripHash.test.js`](../node_modules/@kynesyslabs/demosdk/build/denomination/roundTripHash.test.js), which inlines the node's exact serializer
algorithm and compares it to the SDK's serializer for several content
shapes. **That round-trip test does not include a `networkUpgrade`
fixture** — only `native`, `validatorStake`, `validatorUnstake`,
`escrow`. So governance content shapes never hit the canonical
byte-equality check.

This is why staking works against the same deployed node from the same
SDK call: there's a round-trip test for it, the agent-commerce broadcast
path exercises an isomorphic flow, and the local devnet harness runs
stake end-to-end.

## How to fix

### Fix the test gap (must-do, regardless of root cause)

1. **Add a `networkUpgrade` fixture to
   [`node_modules/@kynesyslabs/demosdk/build/denomination/roundTripHash.test.js`](../node_modules/@kynesyslabs/demosdk/build/denomination/roundTripHash.test.js)** (in the SDK repo, of
   course — `sdks/src/denomination/roundTripHash.test.ts`). The test
   already inlines the node's serializer for byte equality. Add a
   propose payload and a vote payload. This single test would have
   tripped on either divergence.

2. **Extend
   [`scripts/upgradable-network/sdk-builders.test.ts`](../scripts/upgradable-network/sdk-builders.test.ts) to assert hash
   equality with a node-side serializer**, not just `Boolean(tx.hash)`.
   At minimum: `expect(tx.hash).toBe(Hashing.sha256(nodeSerialize(tx.content)))`.

3. **Add an integration test** that boots a local devnet, builds via
   SDK, calls `demos.confirm(tx)`, asserts `result === 200 &&
   data.valid === true` for each governance tx type. Both the
   agent-commerce-demo and the node repo have local devnet harnesses
   (`./devnet up`, the e2e harness from the L2PS pipeline). One
   short Jest test wiring SDK→devnet for propose + vote closes the
   coverage gap permanently.

### Fix the bug itself

Until the root cause is pinned down with node logs from dev.node2, the
two divergences are both worth closing:

1. **Bring the node-side `transformToOsTransactionContent` in
   [src/forks/serializerGate.ts:88-104](../src/forks/serializerGate.ts#L88-L104) into shape-parity with the
   SDK** — spread `fee` first, then overwrite numeric carriers, mirror
   the SDK comment "PR-86 myc#19". This eliminates Divergence 2 even
   for callers that pass non-canonical key orders.

2. **Make the node-side serializer walk `gcr_edits[]`** the same way
   the SDK does (transformEditPostFork). Today the contract is "SDK
   normalises gcr_edits, node passes through"; that contract is fragile
   because a single SDK call site that forgets to canonicalise an
   amount produces a divergence the node has no way to detect.
   Walking on both sides makes the serialization idempotent.

3. **In the SDK** ([build/websdk/demosclass.js:496-510](../node_modules/@kynesyslabs/demosdk/build/websdk/demosclass.js#L496-L510)) — guarantee
   `transaction_fee` is always constructed in the canonical order
   `{network_fee, rpc_fee, additional_fee, rpc_address}` regardless of
   where the source object came from. This is already true for the
   fast-path (line 503-508), but `_calculateAndApplyGasFee` (line 632
   onward) reads `tx.content.transaction_fee` as an `existing` object
   and may shadow the order.

### Workaround for production right now

- Native flow (pay / stake / unstake / L2PS broadcast) is unaffected and
  proven against dev.node2 — battery report confirms 7/10 stages pass.
- Governance proposals can be submitted by a node operator directly
  (admin/CLI path) until the SDK boundary is patched. The
  `handleGovernanceTx.test.ts` suite proves the node-side validation
  works once the tx is in; only the SDK-built tx fails ingress.

## Verification checklist before declaring fixed

- [ ] `scripts/dev-node-battery.ts` stages 4 + 5 turn green against
      dev.node2 (no manual proposal injection).
- [ ] New roundTripHash test in SDK with `networkUpgrade` +
      `networkUpgradeVote` content fixtures.
- [ ] New integration test boots devnet + SDK-confirm round-trips both
      governance txs.
- [ ] `tests/governance/e2e.test.ts` removes the "bypass the SDK"
      shortcut, or a sibling test file covers SDK→node end-to-end for
      governance.
- [ ] Re-deploy dev.node2 from a clean (non-dirty) build of the fixed
      branch.

---

_Battery run that surfaced this:
[test-reports/dev-node-battery-FINAL.md](dev-node-battery-FINAL.md)
(7/10 passed; stages 4 + 5 failed with the hash mismatch documented
above)._

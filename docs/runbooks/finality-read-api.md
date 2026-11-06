---
type: runbook
title: Finality and Storage Read Calls for Clients
date: 2026-11-06
status: active
---

# Finality and Storage Read Calls for Clients

The read-only nodeCalls a client uses to check, without trusting the node it
asks, that a transaction is final and what it did, and what a storage
program holds at a final block. All are sent as
`{ method: "nodeCall", params: [{ message: <name>, data: {...} }] }` over
HTTP, or as an OmniProtocol `nodeCall`; both reach the same handlers.

The reference offline verifier is `src/libs/blockchain/finality/verify.ts`
(`verifyTransactionProof`, `verifyStorageProof`). It reads nothing from the
network and needs a validator set the client trusts.

Every refusal carries its reason in the body (`{ error: <reason>, ... }`) and
in `extra.reason`. `404 not_found`, `500 lookup_failed` and
`503 node_not_synced` are never merged.

## Pin the network: `getChainIdentity`

`data: {}` → `{ chainId, genesisHash, genesisDataHash }`

| Field | Value | What the node does with it |
|---|---|---|
| `chainId` | genesis `properties.id`, or `null` when the genesis declares none | under `signatureDomain` every transaction signature covers `demos-tx:v1:<chainId>:<hash>` |
| `genesisHash` | hash of block 0 | every block chain a proof walks ends at it; `EXPECTED_GENESIS_BLOCK_HASH` pins it |
| `genesisDataHash` | hash of the genesis data stored in block 0 | `EXPECTED_GENESIS_HASH` pins it; peers compare it at bootstrap |

These are the values the node itself enforces, so a client that pins them
pins the same network. `503 state_not_ready` while block 0 is not loaded,
`500 lookup_failed` when it cannot be read.

## Transaction outcome

### `getTransactionStatus {hash}`

`{ state: "pending" | "included" | "failed" | "unknown", blockNumber?, code?, message?, checkedThroughBlock, resultCommittedInBlock? }`.
`included` means in a block and executed; a transaction a block keeps but
does not execute is `failed`, never `included`. An unknown hash is `404`
(`503 node_not_synced` while the node is behind).

### `getTransactionProof {hash}`

The result of a transaction in block m is committed by block m + 1
(`parent_results_root`). The answer:

| Field | Meaning |
|---|---|
| `hash`, `blockNumber` (m), `leafIndex`, `treeSize` | where the transaction sits in block m's `ordered_transactions` |
| `leaf` | `JCS({code, hash, status})`, status `confirmed` or `failed` |
| `auditPath` | RFC 6962 path from the leaf to block m + 1's `parent_results_root` |
| `committedIn` | m + 1 |
| `inclusionBlock` | block m: `{ number, hash, contentBytes }` |
| `commitBlock` | block m + 1 with `round`, `signedMessage` and `signatures` |
| `tx` | the transaction: `{ hash, contentBytes, signature, ed25519_signature }` |

`tx.contentBytes` is the exact text the transaction hash is the sha256 of,
serialized as validation hashes it at height m (amounts and fees are OS
decimal strings once `osDenomination` applies, which mainnet runs from block
0). Read `from`, `to`, `amount` and `nonce` from these bytes, never from
`getTxByHash`: its columns are re-encoded views of the stored row.

Refusals: `400 invalid_hash`; `404 not_found` (`503 node_not_synced`);
`404 no_result_commitment` before `finalityProofs` or for genesis;
`409 not_yet_committed` until block m + 1 exists; `500 content_unrecoverable`
when a block or the transaction no longer hashes to its hash (the body then
names `blockNumber`, and `txHash` for a transaction); `500 lookup_failed`.

Offline check:

```ts
verifyTransactionProof(proof, trustedSet, rules, {
    from: "0x…", to: "0x…", amount: 9_500_000_000n, nonce: 7,
})
// → { verdict: "final-executed" | "final-failed" | "invalid" | "indeterminate", reason?, content? }
```

- With `tx`, its bytes must hash to `proof.hash`; otherwise the proof is
  `invalid`. The verdict returns the parsed `content`.
- Each expected field given must match: addresses without case or `0x`,
  `amount` and `nonce` as integers in the units the signed content carries
  (OS for amounts). A mismatch is `invalid`.
- Without `tx` (an older node) and no expectations, the verdict is as before.
  Expecting a field of a proof without `tx` is `indeterminate`.
- `final-failed` means final and not executed: the transfer did not pay.

### Walking from a checkpoint

- `getFinalizedHead {}`: the node's head with `timestamp`, `ageSeconds`,
  `nodeSynced`, `signatures`, `round` and `signedMessage`.
- `getBlockSegment {from, to}`: signed headers with the bytes each hash is
  taken of. Cut at the head and at a byte cap; `to` in the answer is the last
  one served.
- `getValidatorSet {blockNumber}`: the validator set after that block, the
  preimage of the `validator_set_hash` the next block commits. Check
  `sha256(JCS(validators))` against the signed block, not `setHash`.

## Storage programs

### `getStorageProgram {storageAddress}` returns `null` for two cases

It answers `200 null` both for an address never created and for a program
that was soft-deleted, and that answer will not change because clients rely
on it. To tell them apart, or to know the value is current, use
`getStorageProof`: an absent program has `record: null` with a
non-membership path, and a deleted one has a record with `isDeleted: true`.

### `getStorageProof {storageAddresses: string[1..16], blockNumber?}`

Sparse Merkle proofs against `native_tables_hashes.native_storage_programs`
of block B (default the node's head). B's root covers the state after
B - 1, which the answer names as `asOfBlock`; `anchor` is block B with its
certificate and `anchorParent` is block B - 1. Each entry is
`{ storageAddress, record | null, siblings, terminal }`, and a record is
`{ storageAddress, owner, programName, encoding, dataHash, sizeBytes, aclHash, metadataHash, createdByTx, lastModifiedByTx, isDeleted }`.
All addresses of one call are read at the same block. B may be any of the
last `historyBlocks` blocks.

### `getStorageProgramLimits {}`

| Field | Value |
|---|---|
| `maxDataBytes` | largest program data accepted, 1,048,576 |
| `measuredOver` | what that size counts: the data only, not the ACL or metadata. For `json`, the UTF-8 byte length of `JSON.stringify(data)` as submitted (for a field or item write, of the whole data after the write). For `binary`, the decoded length of the base64 data, `floor(length * 3 / 4)` minus its `=` padding characters |
| `maxJsonDepth` | deepest JSON data accepted, 64; a top-level object or array is depth 1 |
| `appliesFromBlock` | first block the size and depth limits apply at: 0, since no fork gates them |
| `maxAddressesPerProof` | 16 |
| `historyBlocks` | how far back `getStorageProof` can anchor, 64 |
| `pricingChunkBytes`, `feePerChunk` | 1 DEM (`feePerChunk`, a decimal string) per started 10,240 bytes |
| `maxProgramSizeBytes` | same as `maxDataBytes`, kept for older clients |

The size is measured on the data as submitted, so the bytes counted at write
time are not the bytes a read returns (stored JSON comes back with its keys
reordered); `sizeBytes` in the record is the size counted at write time.

The limits are consensus rules: every validator refuses a write that breaks
them, so they change only at a fork height, and `appliesFromBlock` will then
name that height.

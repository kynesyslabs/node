# OmniProtocol Wave 7 Progress

**Date**: 2025-10-31
**Phase**: Step 7 – Wave 7.2 (Binary handlers rollout)

## New Binary Handlers
- Control: `0x03 nodeCall` (method/param wrapper), `0x04 getPeerlist`, `0x05 getPeerInfo`, `0x06 getNodeVersion`, `0x07 getNodeStatus` with compact encodings (strings, JSON info) instead of raw JSON.
- Sync: `0x20 mempool_sync`, `0x21 mempool_merge`, `0x22 peerlist_sync`, `0x23 block_sync`, `0x24 getBlocks` now return structured metadata and parity hashes.
- Lookup: `0x25 getBlockByNumber`, `0x26 getBlockByHash`, `0x27 getTxByHash`, `0x28 getMempool` emit binary payloads with transaction/block metadata rather than JSON blobs.
- GCR: `0x4A gcr_getAddressInfo` encodes balance/nonce and address info compactly.

## Tooling & Serialization
- Added nodeCall request/response codec (type-tagged parameters, recursive arrays) plus string/JSON helpers.
- Transaction serializer encodes content fields (type, from/to, amount, fees, signature) for mempool and tx lookups.
- Block metadata serializer encodes previous hash, proposer, status, ordered transaction hashes for sync responses.
- Registry routes corresponding opcodes to new handlers with lazy imports.

## Compatibility & Testing
- HTTP endpoints remain unchanged; OmniProtocol stays optional behind `migration.mode`.
- Jest suite decodes all implemented opcode payloads and checks parity against fixtures or mocked data.
- Fixtures from https://node2.demos.sh cover peer/mempool/block/address lookups for regression.

## Pending Work
- Implement binary encodings for transaction execution (0x10–0x16), consensus messages (0x30–0x3A), and admin/browser operations.
- Further refine transaction/block serializers to cover advanced payloads (web2 data, signatures aggregation) as needed.
- Capture fixtures for consensus/authenticated flows prior to converting those opcodes.

# OmniProtocol Implementation Status

## Binary Handlers Completed
- `0x03 nodeCall`
- `0x04 getPeerlist`
- `0x05 getPeerInfo`
- `0x06 getNodeVersion`
- `0x07 getNodeStatus`
- `0x20 mempool_sync`
- `0x21 mempool_merge`
- `0x22 peerlist_sync`
- `0x23 block_sync`
- `0x24 getBlocks`
- `0x25 getBlockByNumber`
- `0x26 getBlockByHash`
- `0x27 getTxByHash`
- `0x28 getMempool`
- `0xF0 proto_versionNegotiate`
- `0xF1 proto_capabilityExchange`
- `0xF2 proto_error`
- `0xF3 proto_ping`
- `0xF4 proto_disconnect`
- `0x31 proposeBlockHash`
- `0x34 getCommonValidatorSeed`
- `0x35 getValidatorTimestamp`
- `0x36 setValidatorPhase`
- `0x37 getValidatorPhase`
- `0x38 greenlight`
- `0x39 getBlockTimestamp`
- `0x42 gcr_getIdentities`
- `0x43 gcr_getWeb2Identities`
- `0x44 gcr_getXmIdentities`
- `0x45 gcr_getPoints`
- `0x46 gcr_getTopAccounts`
- `0x47 gcr_getReferralInfo`
- `0x48 gcr_validateReferral`
- `0x49 gcr_getAccountByIdentity`
- `0x4A gcr_getAddressInfo`

- `0x10 execute`
- `0x11 nativeBridge`
- `0x12 bridge`
- `0x15 confirm`
- `0x16 broadcast`

## Binary Handlers Pending
- `0x13 bridge_getTrade` (may be redundant with 0x12)
- `0x14 bridge_executeTrade` (may be redundant with 0x12)
- `0x17`–`0x1F` reserved
- `0x2B`–`0x2F` reserved
- `0x30 consensus_generic` (wrapper opcode - low priority)
- `0x32 voteBlockHash` (deprecated - may be removed)
- `0x3B`–`0x3F` reserved
- `0x40 gcr_generic` (wrapper opcode - low priority)
- `0x41 gcr_identityAssign` (internal operation - used by identity verification flows)
- `0x4B gcr_getAddressNonce` (can be extracted from gcr_getAddressInfo response)
- `0x4C`–`0x4F` reserved
- `0x50`–`0x5F` browser/client ops
- `0x60`–`0x62` admin ops
- `0x63`–`0x6F` reserved

_Last updated: 2025-11-02_

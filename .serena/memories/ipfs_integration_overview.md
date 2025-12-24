# IPFS Integration for Demos Network

## Overview
Full blockchain integration of IPFS (Kubo) into Demos Network for decentralized file storage and P2P content distribution.

## Architecture Decisions
- **Reads**: `demosCall` (gas-free) → `ipfsStatus`, `ipfsGet`, `ipfsPin`, `ipfsUnpin`, `ipfsListPins`, `ipfsPins`
- **Writes**: Demos Transactions (on-chain) → `IPFS_ADD`, `IPFS_PIN`, `IPFS_UNPIN`
- **State**: Account-level `ipfs_pins` field in GCR StateDB
- **Economics**: Full tokenomics planned (pay to pin, earn to host)
- **Infrastructure**: Kubo v0.26.0 via Docker Compose (internal network)

## Phase Tracking

### Phase 1: Infrastructure ✅
- Docker Compose configuration for Kubo container
- IPFSManager class wrapping Kubo HTTP API
- Internal network isolation (demos-ipfs:5001)

### Phase 2: demosCall Handlers ✅
- `ipfsStatus` - Node IPFS health check
- `ipfsAdd` - Upload content (gas-free read for testing)
- `ipfsGet` - Retrieve content by CID
- `ipfsPin` - Pin existing CID
- `ipfsUnpin` - Remove pin
- `ipfsListPins` - List all pinned CIDs
- `ipfsPins` - Account-based pins query

### Phase 3: Account State Schema ✅
- `AccountIPFSState` interface in GCR
- `GCRIPFSRoutines` class for state management
- `PinnedContent` type for pin records
- Methods: `addPin`, `removePin`, `getIPFSState`, `isPinned`

### Phase 4: Transaction Types ✅
- SDK types published in v2.6.0:
  - `IPFSOperationType`: "IPFS_ADD" | "IPFS_PIN" | "IPFS_UNPIN"
  - `IPFSAddPayload`, `IPFSPinPayload`, `IPFSUnpinPayload`
  - Type guards: `isIPFSAddPayload`, `isIPFSPinPayload`, `isIPFSUnpinPayload`
- Node handlers in `ipfsOperations.ts`:
  - `IPFSOperations.ipfsAdd()` - Upload + auto-pin
  - `IPFSOperations.ipfsPin()` - Pin existing CID
  - `IPFSOperations.ipfsUnpin()` - Remove pin
- Integration in `executeOperations.ts` switch dispatch

### Phase 5: Tokenomics 🔲
- Pricing formula for pinning
- Cost calculation in TX handlers
- Reward distribution for hosts
- IPFS_CLAIM_REWARDS transaction

### Phase 6: SDK Integration 🔲
- sdk.ipfs module in @kynesyslabs/demosdk
- Read methods (demosCall wrappers)
- Transaction builders for writes

### Phase 7: Streaming 🔲
- Large file upload/download
- Memory-efficient chunked transfers

### Phase 8: Cluster Sync 🔲
- Private IPFS network configuration
- Swarm key management
- Cluster-wide pinning

### Phase 9: Public Bridge 🔲
- Optional public IPFS gateway access
- Dual-network routing

## Related Beads Issues
- Epic: `node-qz1` - IPFS Integration for Demos Network
- Phase 4: `node-xhh` - Transaction Types (CLOSED)
- Phase 5: `node-5l8` - Tokenomics
- Phase 6: `node-9pb` - SDK Integration

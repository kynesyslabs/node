# IPFS Integration for Demos Network

## Overview
Full blockchain integration of IPFS (Kubo) into Demos Network for decentralized file storage and P2P content distribution.

## Architecture Decisions
- **Reads**: `demosCall` (gas-free) → `ipfsStatus`, `ipfsGet`, `ipfsPin`, `ipfsUnpin`, `ipfsListPins`, `ipfsPins`
- **Writes**: Demos Transactions (on-chain) → `IPFS_ADD`, `IPFS_PIN`, `IPFS_UNPIN`
- **State**: Account-level `ipfs_pins` field in GCR StateDB
- **Economics**: Full tokenomics (pay to pin, earn to host)
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
- SDK types published in v2.6.0
- Node handlers in `ipfsOperations.ts`
- Integration in `executeOperations.ts` switch dispatch

### Phase 5: Tokenomics ✅
- Pricing formula: 1 DEM per 100MB (regular), 1GB free + 1 DEM per GB (genesis)
- Cost calculation in ipfsTokenomics.ts
- Fee distribution: 100% to host (MVP)

### Phase 6: SDK Integration ✅
- sdk.ipfs module in @kynesyslabs/demosdk
- IPFSOperations class with static payload creators
- Validation and encoding utilities

### Phase 7: RPC Handler Integration ✅
- SDK integrated with node RPC handlers
- Transaction handlers connected with tokenomics
- End-to-end flow complete

### Phase 8: Streaming ✅
- `addStream()` for chunked uploads with progress callbacks
- `getStream()` for streaming downloads
- Memory-efficient large file handling (1GB+ without issues)

### Phase 9: Peer Discovery via hello_peer ✅
- IPFS capabilities exchange during hello_peer handshake
- Dynamic IPFS swarm formation through Demos peer network
- Local/public address filtering based on peer network location
- Docker swarm port exposed (4001 TCP/UDP)
- PeerCapabilities interface with ipfs.peerId and ipfs.addresses

### Phase 10: Cluster Sync ✅
- Private IPFS network configuration via swarm.key
- Swarm key written automatically by init-ipfs.sh
- LIBP2P_FORCE_PNET=1 enforces private network mode
- All nodes use same DEMOS_IPFS_SWARM_KEY for isolated swarm
- **Beads**: `node-zmh` (closed)

### Phase 11: Public Bridge 🔲
- Optional public IPFS gateway access
- Dual-network routing
- **Beads**: `node-6qh` (open, P3)

## Network Ports (Node Operators)

| Port | Protocol | Purpose |
|------|----------|---------|
| **53550** | TCP | Demos RPC (main node API) |
| **53551** | TCP | OmniProtocol (Demos P2P communications) |
| **7047** | TCP | TLSNotary Service |
| **4001** | TCP + UDP | IPFS Swarm (P2P peer discovery) |
| **5001** | TCP | IPFS API (localhost only) |
| **55000-60000** | TCP | TLSNotary WebSocket proxies |

## Key Files
- `src/features/ipfs/IPFSManager.ts` - Core operations + streaming
- `src/features/ipfs/types.ts` - Type definitions
- `src/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines.ts` - State management
- `src/libs/blockchain/routines/ipfsOperations.ts` - Transaction handlers
- `docker-compose.yml` - Kubo v0.26.0 container

# IPFS Integration for Demos Network

## Overview
Full blockchain integration of IPFS (Kubo) into Demos Network for decentralized file storage and P2P content distribution.

## Architecture Decisions
- **Reads**: `demosCall` (gas-free) → `ipfsStatus`, `ipfsGet`, `ipfsPin`, `ipfsUnpin`, `ipfsListPins`, `ipfsPins`
- **Writes**: Demos Transactions (on-chain) → `IPFS_ADD`, `IPFS_PIN`, `IPFS_UNPIN`
- **State**: Account-level `ipfs_pins` field in GCR StateDB
- **Economics**: Full tokenomics (pay to pin, earn to host)
- **Infrastructure**: Kubo v0.26.0 via Docker Compose (internal network)

## Phase Status (All Complete)

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ | Infrastructure (Docker Compose, IPFSManager) |
| 2 | ✅ | demosCall Handlers (ipfsStatus, ipfsGet, etc.) |
| 3 | ✅ | Account State Schema (GCRIPFSRoutines) |
| 4 | ✅ | Transaction Types (SDK v2.6.0) |
| 5 | ✅ | Tokenomics (pricing, fee distribution) |
| 6 | ✅ | SDK Integration (@kynesyslabs/demosdk) |
| 7 | ✅ | RPC Handler Integration |
| 8 | ✅ | Streaming (large file upload/download) |
| 9 | ✅ | Peer Discovery via hello_peer |
| 10 | ✅ | Cluster Sync (private IPFS network) |
| 11 | 🔲 | Public Bridge (optional gateway access) |

## Network Ports (Node Operators)

| Port | Protocol | Purpose |
|------|----------|---------|
| **53550** | TCP | Demos RPC (main node API) |
| **53551** | TCP | OmniProtocol (Demos P2P) |
| **7047** | TCP | TLSNotary Service |
| **4001** | TCP + UDP | IPFS Swarm (P2P peer discovery) |
| **5001** | TCP | IPFS API (localhost only) |

## Key Files
- `src/features/ipfs/IPFSManager.ts` - Core operations + streaming
- `src/features/ipfs/types.ts` - Type definitions
- `src/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines.ts` - State management
- `src/libs/blockchain/routines/ipfsOperations.ts` - Transaction handlers
- `docker-compose.yml` - Kubo v0.26.0 container
/**
 * OmniProtocol Integration Module
 *
 * Exports adapters and utilities for integrating OmniProtocol
 * with existing node components.
 */

// Base adapter class for creating custom adapters
export { BaseOmniAdapter, type BaseAdapterOptions } from "./BaseAdapter"

// Peer adapter for Peer.call() integration
export { PeerOmniAdapter, type AdapterOptions } from "./peerAdapter"

// Consensus adapter for dedicated consensus opcodes
export {
    ConsensusOmniAdapter,
    type ConsensusAdapterOptions,
} from "./consensusAdapter"

// Key management utilities
export {
    getNodePrivateKey,
    getNodePublicKey,
    getNodeIdentity,
    hasNodeKeys,
    validateNodeKeys,
} from "./keys"

// Server startup utilities
export { startOmniProtocolServer } from "./startup"

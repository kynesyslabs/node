/**
 * Tag to Category Mapping - Shared module for log tag categorization
 *
 * This module provides the authoritative mapping from legacy log tags
 * to the new LogCategory system. Used by both LegacyLoggerAdapter and TUIManager.
 */

import type { LogCategory } from "./CategorizedLogger"

/**
 * Maps old log tags to new categories.
 * This is the single source of truth for tag-to-category mapping.
 */
export const TAG_TO_CATEGORY: Record<string, LogCategory> = {
    // CORE - Main bootstrap, warmup, general operations
    MAIN: "CORE",
    BOOTSTRAP: "CORE",
    GENESIS: "CORE",
    WARMUP: "CORE",
    ERROR: "CORE",
    WARNING: "CORE",
    OK: "CORE",
    RESULT: "CORE",
    FAILED: "CORE",
    REQUIRED: "CORE",
    ONLY: "CORE",

    // NETWORK - RPC server, connections, HTTP endpoints
    RPC: "NETWORK",
    SERVER: "NETWORK",
    HTTP: "NETWORK",
    SERVERHANDLER: "NETWORK",
    "SERVER ERROR": "NETWORK",
    "SOCKET CONNECTOR": "NETWORK",
    NETWORK: "NETWORK",
    PING: "NETWORK",
    TRANSMISSION: "NETWORK",

    // PEER - Peer management, peer gossip, peer bootstrap
    PEER: "PEER",
    PEERROUTINE: "PEER",
    PEERGOSSIP: "PEER",
    PEERMANAGER: "PEER",
    "PEER TIMESYNC": "PEER",
    "PEER AUTHENTICATION": "PEER",
    "PEER RECHECK": "PEER",
    "PEER CONNECTION": "PEER",
    PEERBOOTSTRAP: "PEER",
    "PEER BOOTSTRAP": "PEER",

    // CHAIN - Blockchain, blocks, mempool, transactions
    CHAIN: "CHAIN",
    BLOCK: "CHAIN",
    MEMPOOL: "CHAIN",
    "TX RECEIVED": "CHAIN",
    "TX VALIDATION ERROR": "CHAIN",
    TRANSACTION: "CHAIN",
    "BALANCE ERROR": "CHAIN",
    "NONCE ERROR": "CHAIN",
    "FROM ERROR": "CHAIN",
    "NOT PROCESSED": "CHAIN",

    // SYNC - Synchronization operations
    SYNC: "SYNC",
    MAINLOOP: "SYNC",
    "MAIN LOOP": "SYNC",

    // CONSENSUS - PoR BFT consensus operations
    CONSENSUS: "CONSENSUS",
    PORBFT: "CONSENSUS",
    POR: "CONSENSUS",
    "SECRETARY ROUTINE": "CONSENSUS",
    "SECRETARY MANAGER": "CONSENSUS",
    WAITER: "CONSENSUS",
    PROVER: "CONSENSUS",
    VERIFIER: "CONSENSUS",
    "CONSENSUS TIME": "CONSENSUS",
    "CONSENSUS ROUTINE": "CONSENSUS",
    "SEND OUR VALIDATOR PHASE": "CONSENSUS",

    // IDENTITY - GCR, identity management, cryptography
    GCR: "IDENTITY",
    IDENTITY: "IDENTITY",
    UD: "IDENTITY",
    DECRYPTION: "IDENTITY",
    "SIGNATURE ERROR": "IDENTITY",

    // MCP - MCP server operations
    MCP: "MCP",
    "START OF AVAILABLE MODULES": "MCP",

    // MULTICHAIN - Cross-chain/XM operations
    XM: "MULTICHAIN",
    MULTICHAIN: "MULTICHAIN",
    CROSSCHAIN: "MULTICHAIN",
    "XM EXECUTE": "MULTICHAIN",
    L2PS: "MULTICHAIN",
    PROTOCOL: "MULTICHAIN",
    "MULTI CALL": "MULTICHAIN",
    "LONG CALL": "MULTICHAIN",
    POC: "MULTICHAIN",

    // IPFS - IPFS storage operations
    IPFS: "IPFS",
    "IPFS MANAGER": "IPFS",
    "IPFS UPLOAD": "IPFS",
    "IPFS DOWNLOAD": "IPFS",
    "IPFS PIN": "IPFS",
    "IPFS UNPIN": "IPFS",
    "IPFS ERROR": "IPFS",

    // DAHR - DAHR-specific operations, instant messaging, social
    DAHR: "DAHR",
    WEB2: "DAHR",
    ACTIVITYPUB: "DAHR",
    IM: "DAHR",
    "DEMOS FOLLOW": "DAHR",
    "PAYLOAD FOR WEB2": "DAHR",
    "REQUEST FOR WEB2": "DAHR",
}

// Re-export LogCategory for convenience
export type { LogCategory } from "./CategorizedLogger"

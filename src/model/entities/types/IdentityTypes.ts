import { Web2GCRData, SignatureType } from "@kynesyslabs/demosdk/types"
import { DemosOwnershipProof } from "@kynesyslabs/demosdk/abstraction"

export interface NomisWalletIdentity {
    chain: string
    subchain: string
    address: string
    score: number
    scoreType: number
    mintedScore?: number | null
    lastSyncedAt: string
    metadata?: {
        referralCode?: string
        referrerCode?: string
        deadline?: number
        nonce?: number
        apiVersion?: string
        [key: string]: unknown
    }
}

export interface SavedXmIdentity {
    // NOTE: We don't store the message here
    // The signed message is the ed25519 address (with 0x prefix) of the sender which can
    // be obtained from the tx.content or the public key column of the gcr_main table
    address: string
    signature: string
    publicKey: string
    timestamp: number
    signedData: string
}
export interface SavedNomisIdentity {
    address: string
    score: number
    scoreType: number
    mintedScore?: number | null
    lastSyncedAt: string
    metadata?: {
        referralCode?: string
        referrerCode?: string
        deadline?: number
        nonce?: number
        apiVersion?: string
        [key: string]: unknown
    }
}

/**
 * The PQC identity saved in the GCR
 */
export interface SavedPqcIdentity {
    address: string
    signature: string
    timestamp: number
}

/**
 * The PQC identity GCR edit operation data
 */
export interface PqcIdentityEdit extends SavedPqcIdentity {
    algorithm: string
}

/**
 * The Unstoppable Domains identity saved in the GCR
 *
 * PHASE 5 UPDATE: Multi-address verification support
 * - Users can sign with ANY address in their domain records (not just owner)
 * - Supports both EVM (secp256k1) and Solana (ed25519) signatures
 * - Multi-chain support: Polygon L2, Base L2, Sonic, Ethereum L1, and Solana
 *
 * BREAKING CHANGE from Phase 4:
 * - resolvedAddress → signingAddress (the address that signed, not the domain owner)
 * - Added signatureType field to indicate EVM or Solana signature
 * - Added "solana" to network options
 */
export interface SavedUdIdentity {
    domain: string // e.g., "brad.crypto" or "example.demos"
    signingAddress: string // The address that signed the challenge (can be any authorized address)
    signatureType: SignatureType // "evm" or "solana" - indicates signature verification method
    signature: string // Signature from signingAddress
    publicKey: string // Public key of signingAddress
    timestamp: number
    signedData: string // Challenge message that was signed
    network: "polygon" | "ethereum" | "base" | "sonic" | "solana" // Network where domain is registered
    registryType: "UNS" | "CNS" // Which registry was used
}

/**
 * ERC-8004 Agent Identity saved in the GCR
 *
 * Links an ERC-8004 agent NFT (registered on Base Sepolia) to a Demos identity.
 * The agent NFT represents an AI agent's on-chain identity.
 *
 * Requirements:
 * - User must have an EVM wallet linked to their Demos identity
 * - The EVM wallet must own the ERC-8004 agent NFT
 * - User must sign ownership proof with their Demos wallet
 */
export interface SavedAgentIdentity {
    agentId: string // ERC-8004 token ID
    evmAddress: string // EVM address that owns the agent NFT
    chain: string // Chain where agent is registered (e.g., "base.sepolia")
    txHash: string // Transaction hash of agent registration
    tokenUri: string // Token URI pointing to agent card metadata
    proof: DemosOwnershipProof // Ownership proof signed by Demos wallet
    timestamp: number // When the identity was linked
    resolverUrl?: string // Optional resolver URL for the agent
}

export type StoredIdentities = {
    xm: {
        [chain: string]: {
            [subchain: string]: SavedXmIdentity[]
        }
    }
    web2: {
        [context: string]: Web2GCRData["data"][]
    }
    pqc: {
        // A mapping of the algorithm identifier a list of the signature and address objects
        // eg. falcon: [{address: "pubkey1", signature: "signature1"}, {address: "pubkey2", signature: "signature2"}]
        [algorithm: string]: SavedPqcIdentity[]
    }
    ud: SavedUdIdentity[] // Unstoppable Domains identities
    agent: {
        // A mapping of chain (e.g., "base.sepolia") to array of agent identities
        [chain: string]: SavedAgentIdentity[]
    }
    nomis?: {
        [chain: string]: {
            [subchain: string]: SavedNomisIdentity[]
        }
    }
}

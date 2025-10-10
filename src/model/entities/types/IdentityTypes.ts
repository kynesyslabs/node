import { Web2GCRData } from "@kynesyslabs/demosdk/types"

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
 * Multi-chain support: Polygon L2, Base L2, Sonic, and Ethereum L1
 */
export interface SavedUdIdentity {
    domain: string // e.g., "brad.crypto"
    resolvedAddress: string // Ethereum address domain resolves to
    signature: string // Signature from resolvedAddress
    publicKey: string // Public key of resolvedAddress
    timestamp: number
    signedData: string // Challenge message that was signed
    network: "polygon" | "ethereum" | "base" | "sonic" // Network where domain is registered
    registryType: "UNS" | "CNS" // Which registry was used
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
}

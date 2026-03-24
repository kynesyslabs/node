/**
 * L2PS Types - Local definitions for types not exported from SDK
 *
 * These types exist in @kynesyslabs/demosdk but are not exported from the public API.
 * Defined locally until SDK exports are updated.
 */

import type * as forge from "node-forge"

/**
 * Encrypted transaction for L2PS (Layer 2 Parallel Subnets)
 * Mirrors @kynesyslabs/demosdk/build/types/blockchain/encryptedTransaction
 */
export interface EncryptedTransaction {
    hash: string
    encryptedHash: string
    encryptedTransaction: string
    blockNumber: number
    L2PS: forge.pki.rsa.PublicKey
}

/**
 * Payload for subnet transactions
 */
export interface SubnetPayload {
    uid: string
    data: string
}

/**
 * L2PS Batch Payload Interface
 *
 * Represents the encrypted batch data submitted to the main mempool
 */
export interface L2PSBatchPayload {
    /** L2PS network identifier */
    l2ps_uid: string
    /** Base64 encrypted blob containing all transaction data */
    encrypted_batch: string
    /** Number of transactions in this batch */
    transaction_count: number
    /** Deterministic hash of the batch for integrity verification */
    batch_hash: string
    /** Array of original transaction hashes included in this batch */
    transaction_hashes: string[]
    /** HMAC-SHA256 authentication tag for tamper detection */
    authentication_tag: string
    /** ZK-SNARK PLONK proof for batch validity (optional during transition) */
    zk_proof?: {
        proof: any
        publicSignals: string[]
        batchSize: number
        finalStateRoot: string
        totalVolume: string
    }
}

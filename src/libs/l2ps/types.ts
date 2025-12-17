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

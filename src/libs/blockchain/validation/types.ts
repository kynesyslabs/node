import { SavedPqcIdentity } from "@/model/entities/types/IdentityTypes"

export interface TxValidationResult {
    hash: string
    valid: boolean
    reason?: string
}

export type PqcIdentityHint = SavedPqcIdentity | null

/** Keyed by tx.hash. Only populated for PQC txs without an ed25519 co-signature. */
export type IdentityHintMap = Record<string, PqcIdentityHint>

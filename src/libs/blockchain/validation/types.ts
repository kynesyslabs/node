import type { SavedPqcIdentity } from "../../../model/entities/types/IdentityTypes"
import type { Transaction } from "@kynesyslabs/demosdk/types"

export interface TxValidationResult {
    hash: string
    valid: boolean
    reason?: string
}

export type PqcIdentityHint = SavedPqcIdentity | null

/** Keyed by tx.hash. Only populated for PQC txs without an ed25519 co-signature. */
export type IdentityHintMap = Record<string, PqcIdentityHint>

/** Parent → worker messages. */
export type WorkerRequest =
    | {
          type: "validate"
          requestId: string
          txs: Transaction[]
          identityHints: IdentityHintMap
      }
    | { type: "shutdown" }

/** Worker → parent messages. */
export type WorkerResponse =
    | {
          type: "validateResult"
          requestId: string
          results: TxValidationResult[]
      }
    | {
          type: "fatal"
          requestId?: string
          error: string
      }

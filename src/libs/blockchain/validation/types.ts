import type { SavedPqcIdentity } from "../../../model/entities/types/IdentityTypes"
import type {
    SigningAlgorithm,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import type { signedObject } from "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto"

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
          // osDenomination fork state at the node-local chain tip, computed on
          // the main thread (the worker has no forkConfig/height). Drives the
          // coherence serializer's amount canonicalization (audit H1).
          isPostFork: boolean
      }
    | {
          type: "sign"
          requestId: string
          algorithm: SigningAlgorithm
          data: Uint8Array
      }
    | {
          type: "verify"
          requestId: string
          signedObject: signedObject
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
          type: "signResult"
          requestId: string
          signedObject: signedObject
      }
    | {
          type: "verifyResult"
          requestId: string
          result: boolean
      }
    | {
          type: "fatal"
          requestId?: string
          error: string
      }
    | { type: "ready" }

/** Data passed via Worker `workerData` at spawn time. */
export interface WorkerInitData {
    /**
     * The node's master seed. Workers call ucrypto.ensureSeed +
     * generateAllIdentities so they can sign as the node.
     */
    masterSeed: Uint8Array
}

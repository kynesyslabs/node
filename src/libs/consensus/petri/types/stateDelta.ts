import type { GCREdit } from "@kynesyslabs/demosdk/types"

/**
 * A StateDelta represents the deterministic result of speculatively executing
 * a transaction's GCR edits against the current confirmed state.
 *
 * The `edits` array is the raw GCR edit output from SDK generation.
 * The `hash` is computed via canonical JSON serialization (sorted keys) + SHA-256.
 * Two honest nodes processing the same tx against the same state MUST produce the same hash.
 */
export interface StateDelta {
    txHash: string
    edits: GCREdit[]
    hash: string // SHA-256 of canonicalJson(edits)
    executedAt: number // timestamp of speculative execution
    blockRef: number // block number of the confirmed state used for execution
}

/**
 * A delta received from a shard member during the delta exchange phase.
 */
export interface PeerDelta {
    peerKey: string // public key of the shard member
    txHash: string
    deltaHash: string
    receivedAt: number
}

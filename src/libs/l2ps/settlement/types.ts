/** Module boundary between the aggregator, the planner/prover and validation. */

/** A member-decrypted transfer, already checked against its commitment. */
export interface DecryptedTransfer {
    /** Hash of the encrypted L2PS transaction carrying it. */
    txHash: string
    from: string
    to: string
    amount: bigint
    fee: bigint
    nonce: bigint
    salt: bigint
    commitment: bigint
    /** 0x-hex ed25519 signature over settlementSignatureMessage. */
    signature: string
}

export interface SettlementChange {
    account: string
    delta: bigint
}

export interface SettlementPlan {
    /** Transfers in the batch, in batch order (at most SETTLEMENT_TRANSFERS). */
    transfers: DecryptedTransfer[]
    /** Left out: would overdraft, exceed the slots, or reuse a nonce. */
    deferred: { transfer: DecryptedTransfer; reason: string }[]
    /** Sorted by account, unique; fees included in the senders' deltas. */
    changes: SettlementChange[]
    /** Balances before the batch that the proof binds, by account. */
    balancesBefore: Map<string, bigint>
}

/** snarkjs PLONK proof JSON, opaque outside the prover. */
export type SettlementProof = Record<string, unknown>

export interface SettlementProofResult {
    proof: SettlementProof
    /** Decimal strings, in the circuit's public signal order. */
    publicSignals: string[]
}

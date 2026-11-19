// Staking types. The Phase 0 payloads are owned by @kynesyslabs/demosdk and
// re-exported so node-side imports stay stable.

import type {
    GCREditValidatorStake as SdkGCREditValidatorStake,
    ValidatorStakePayload as SdkValidatorStakePayload,
} from "@kynesyslabs/demosdk/types"

export type {
    ValidatorUnstakePayload,
    ValidatorExitPayload,
} from "@kynesyslabs/demosdk/types"

// The NFT shapes of nftValidatorGating are this node's consensus rule, so
// they are declared here rather than taken from whichever SDK release the
// node is built with; they match the SDK's validator NFT gating types.

/**
 * Proof that a Solana wallet holding an eligible node NFT consents to
 * backing this validator. `proofTx` is the signature of a finalized Solana
 * transaction signed by `owner` that self-transfers `mint` and carries the
 * memo `demos-validator:<validator address>`.
 */
export interface ValidatorNftProof {
    /** Base58 mint address of the node NFT. */
    mint: string
    /** Base58 wallet address holding the NFT and signing the proof. */
    owner: string
    /** Base58 signature of the proof transaction. */
    proofTx: string
}

/** Payload for a `validatorStake` tx; `nft` takes a seat under nftValidatorGating. */
export interface ValidatorStakePayload extends SdkValidatorStakePayload {
    nft?: ValidatorNftProof
}

/**
 * Payload for a `validatorChallenge` tx. Anyone may submit one: it evicts
 * `validator` when `evidenceTx` is a finalized Solana transaction that moved
 * the validator's NFT out of the wallet recorded at stake time.
 */
export interface ValidatorChallengePayload {
    /** Address of the validator whose seat is challenged. */
    validator: string
    /** Base58 signature of the Solana transfer that moved the NFT. */
    evidenceTx: string
    /** The seat's recorded proof; the eviction applies only while the seat still rests on it. */
    proofTx: string
}

/** A validatorStake edit, with the NFT fields of nftValidatorGating. */
export type GCREditValidatorStake = Omit<SdkGCREditValidatorStake, "operation"> & {
    operation: SdkGCREditValidatorStake["operation"] | "evict"
    /** Present on the stake that takes a seat. */
    nft?: ValidatorNftProof
    /** Evict only: the Solana transfer that moved the NFT. */
    evidenceTx?: string
    /** Evict only: the proof the seat was taken with. */
    proofTx?: string
}

/** String-literal tx-type values for Phase 0 staking. */
export type StakingTxType =
    | "validatorStake"
    | "validatorUnstake"
    | "validatorExit"
    | "validatorChallenge"

export const STAKING_TX_TYPES: readonly StakingTxType[] = [
    "validatorStake",
    "validatorUnstake",
    "validatorExit",
    "validatorChallenge",
] as const

export function isStakingTxType(value: string): value is StakingTxType {
    return (STAKING_TX_TYPES as readonly string[]).includes(value)
}

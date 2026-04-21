// Phase-0 staking types.
//
// Scoped to the node for now; the plan (`planning/adversarial_review/
// staking_research/plan/plan.md`) migrates these into @kynesyslabs/demosdk in
// SDK Batch 1. When that ships, re-export from the SDK path and delete the
// local definitions here.

/** Payload for a `validatorStake` tx. */
export interface ValidatorStakePayload {
    amount: string // bigint-as-string
    connectionUrl: string
}

/** Payload for a `validatorUnstake` tx. Sender is implicit. */
export type ValidatorUnstakePayload = Record<string, never>

/** Payload for a `validatorExit` tx. Sender is implicit. */
export type ValidatorExitPayload = Record<string, never>

/**
 * GCR edit emitted by validator-staking transactions.
 * Applied by GCRValidatorStakeRoutines against the Validators table.
 */
export interface GCREditValidatorStake {
    type: "validatorStake"
    isRollback: boolean
    account: string // validator ed25519 pubkey hex
    operation: "stake" | "unstake" | "exit"
    amount: string // bigint-as-string (ignored for unstake/exit)
    connectionUrl?: string // only meaningful for the initial stake
    txhash: string
}

/** The string literal tx-type values for Phase 0 staking. */
export type StakingTxType =
    | "validatorStake"
    | "validatorUnstake"
    | "validatorExit"

export const STAKING_TX_TYPES: readonly StakingTxType[] = [
    "validatorStake",
    "validatorUnstake",
    "validatorExit",
] as const

export function isStakingTxType(value: string): value is StakingTxType {
    return (STAKING_TX_TYPES as readonly string[]).includes(value)
}

// Re-exports from the SDK. Phase 0 types were originally authored here
// before SDK Batch 1 landed; they're now owned by @kynesyslabs/demosdk and
// this module is a thin surface to keep existing node-side imports stable.

export type {
    ValidatorStakePayload,
    ValidatorUnstakePayload,
    ValidatorExitPayload,
} from "@kynesyslabs/demosdk/types"

export type { GCREditValidatorStake } from "@kynesyslabs/demosdk/types"

/** String-literal tx-type values for Phase 0 staking. */
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

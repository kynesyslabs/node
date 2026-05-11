import type { NetworkParameterKey, NetworkParameters } from "./types"
import { DEFAULT_MIN_VALIDATOR_STAKE } from "@/features/staking/constants"
import { Config } from "@/config"

/** Blocks the voting window lasts after proposal confirmation. */
export const VOTING_WINDOW_BLOCKS = 100

/** Blocks the grace period lasts between tally and activation. */
export const GRACE_PERIOD_BLOCKS = 50

/** Bytes — max length of a proposal rationale. */
export const MAX_RATIONALE_LENGTH = 1024

/** 2/3 supermajority. Immutable, non-governable. Stored as numerator/denominator
 * so we can do exact bigint arithmetic and avoid floating-point drift. */
export const SUPERMAJORITY_NUMERATOR = 2n
export const SUPERMAJORITY_DENOMINATOR = 3n

/** Max single-proposal change cap — 50% in either direction. Immutable. */
export const MAX_CHANGE_PERCENT = 50

/**
 * DEM-665: tighter per-proposal change cap for fee-distribution
 * percentage keys. The default ±50% would let a single passing proposal
 * shift 50% of treasury share into burn (or vice versa) in one cycle;
 * the tighter ±10% forces multi-cycle steering and gives observers time
 * to react.
 *
 * Applied by `safetyBounds.ts` after looking up the key in
 * `DISTRIBUTION_KEYS`.
 */
export const DISTRIBUTION_MAX_CHANGE_PERCENT = 10

/**
 * DEM-665: keys that participate in the cross-key sum-100 invariant and
 * the tighter ±DISTRIBUTION_MAX_CHANGE_PERCENT cap.
 *
 * Order is meaningful only as documentation — the safetyBounds checks
 * iterate this set as a `Set<NetworkParameterKey>`.
 */
export const DISTRIBUTION_KEYS: ReadonlySet<NetworkParameterKey> = new Set([
    "networkFeeBurnPct",
    "networkFeeTreasuryPct",
    "additionalFeeBurnPct",
    "additionalFeeTreasuryPct",
    "specialOpsBurnPct",
    "specialOpsTreasuryPct",
    "specialOpsRpcPct",
])

/**
 * Phase 1 governable parameter set. Phase 2 adds blockTimeMs + shardSize.
 * Proposals touching keys outside this set are rejected at validation.
 *
 * DEM-665: extended with `additionalFee` + every entry of
 * `DISTRIBUTION_KEYS`. Distribution percentages are governable from day
 * 1 with tighter bounds + the sum-100 cross-key invariant; the
 * treasury and burn addresses remain immutable fork-payload (handled
 * outside this set).
 */
export const PHASE_1_GOVERNABLE_KEYS: ReadonlySet<NetworkParameterKey> =
    new Set<NetworkParameterKey>([
        "minValidatorStake",
        "networkFee",
        "rpcFee",
        "additionalFee",
        ...DISTRIBUTION_KEYS,
        "featureFlags",
    ])

/** Hardcoded last-resort fallback for NetworkParameters. Real precedence is
 *  governance (DB) > env (Config) > these values. Use `getGenesisNetworkParameters()`
 *  to get the env-resolved view.
 *
 *  Pre-DEM-665 fees summed to 1 (networkFee) + 1 (rpcFee) + 1 (burnFee,
 *  node-local config) = 3. Post-DEM-665 burnFee is retired (P8/P13);
 *  the burned share comes out of the per-component percentages below.
 *  Default distribution mirrors the DEM-665 SPEC table: network_fee
 *  50/50 burn/treasury, additional_fee 25/75 burn/treasury, special_ops
 *  25/50/25 burn/rpc/treasury. */
export const HARDCODED_FALLBACK_NETWORK_PARAMETERS: NetworkParameters = {
    blockTimeMs: 1000,
    shardSize: 4,
    minValidatorStake: DEFAULT_MIN_VALIDATOR_STAKE,
    networkFee: 1,
    rpcFee: 1,
    additionalFee: 0,
    networkFeeBurnPct: 50,
    networkFeeTreasuryPct: 50,
    additionalFeeBurnPct: 25,
    additionalFeeTreasuryPct: 75,
    specialOpsBurnPct: 25,
    specialOpsTreasuryPct: 25,
    specialOpsRpcPct: 50,
    featureFlags: {
        l2ps: true,
        tlsn: true,
    },
}

/** Returns the chain's "genesis-state" NetworkParameters as resolved from
 *  the operator's env/config. Governance proposals will activate ON TOP of
 *  this. Hardcoded fallback applies only if Config can't be loaded. */
export function getGenesisNetworkParameters(): NetworkParameters {
    let core: ReturnType<typeof Config.getInstance>["core"] | null = null
    try {
        core = Config.getInstance().core
    } catch {
        // Config not initialised — return hardcoded fallback verbatim.
        return {
            ...HARDCODED_FALLBACK_NETWORK_PARAMETERS,
            featureFlags: {
                ...HARDCODED_FALLBACK_NETWORK_PARAMETERS.featureFlags,
            },
        }
    }
    const f = HARDCODED_FALLBACK_NETWORK_PARAMETERS
    const consensusSeconds = core.consensusTime
    return {
        blockTimeMs:
            consensusSeconds && consensusSeconds > 0
                ? consensusSeconds * 1000
                : f.blockTimeMs,
        shardSize: core.shardSize ?? f.shardSize,
        minValidatorStake: core.minValidatorStake || f.minValidatorStake,
        networkFee: core.networkFee ?? f.networkFee,
        rpcFee: core.rpcFee ?? f.rpcFee,
        // DEM-665: distribution percentages are governance-mutable but
        // their genesis-state defaults are sourced from the hardcoded
        // fallback (operators don't override them via env today; that's
        // a future config knob if ever needed).
        additionalFee: f.additionalFee,
        networkFeeBurnPct: f.networkFeeBurnPct,
        networkFeeTreasuryPct: f.networkFeeTreasuryPct,
        additionalFeeBurnPct: f.additionalFeeBurnPct,
        additionalFeeTreasuryPct: f.additionalFeeTreasuryPct,
        specialOpsBurnPct: f.specialOpsBurnPct,
        specialOpsTreasuryPct: f.specialOpsTreasuryPct,
        specialOpsRpcPct: f.specialOpsRpcPct,
        featureFlags: { ...f.featureFlags },
    }
}

/** @deprecated Use `getGenesisNetworkParameters()` — it resolves from env.
 *  Re-exported as the hardcoded view for tests that don't load Config. */
export const GENESIS_NETWORK_PARAMETERS = HARDCODED_FALLBACK_NETWORK_PARAMETERS

/**
 * Absolute floors/ceilings — non-governable safety bounds.
 *
 * Numeric fields: a proposal that sets the field below `floor` or above
 * `ceiling` is rejected. For bigint-as-string fields, `floor`/`ceiling` are
 * also strings.
 *
 * `floor` for minValidatorStake is calibrated to 1% of genesis value, per
 * the v2 spec. Other numeric floors come directly from the spec table.
 */
interface NumericBounds {
    floor: number
    ceiling: number
}
interface BigintBounds {
    floor: string
    ceiling: string | null
}

export const NUMERIC_BOUNDS: Partial<Record<NetworkParameterKey, NumericBounds>> = {
    networkFee: { floor: 0, ceiling: 5000 },
    rpcFee: { floor: 0, ceiling: 5000 },
    additionalFee: { floor: 0, ceiling: 5000 },
    blockTimeMs: { floor: 1000, ceiling: 60000 },
    shardSize: { floor: 3, ceiling: 100 },
    // DEM-665: percentage fields are [0, 100]; the cross-key sum-100
    // invariant is enforced separately by `safetyBounds.ts`.
    networkFeeBurnPct: { floor: 0, ceiling: 100 },
    networkFeeTreasuryPct: { floor: 0, ceiling: 100 },
    additionalFeeBurnPct: { floor: 0, ceiling: 100 },
    additionalFeeTreasuryPct: { floor: 0, ceiling: 100 },
    specialOpsBurnPct: { floor: 0, ceiling: 100 },
    specialOpsTreasuryPct: { floor: 0, ceiling: 100 },
    specialOpsRpcPct: { floor: 0, ceiling: 100 },
}

// Floor for `minValidatorStake` is 1% of the **resolved** genesis value
// (Config-derived if env set, hardcoded fallback otherwise) rather than the
// static default — so an operator that sets MIN_VALIDATOR_STAKE in env gets
// a proportional floor instead of one frozen at the source-default.
export function getBigintBounds(): Partial<
    Record<NetworkParameterKey, BigintBounds>
> {
    const genesisStake = getGenesisNetworkParameters().minValidatorStake
    let floorStake: string
    try {
        floorStake = (BigInt(genesisStake) / 100n).toString()
    } catch {
        floorStake = (BigInt(DEFAULT_MIN_VALIDATOR_STAKE) / 100n).toString()
    }
    return {
        minValidatorStake: {
            floor: floorStake,
            ceiling: null,
        },
    }
}


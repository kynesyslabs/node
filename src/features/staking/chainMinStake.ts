import { getSharedState } from "src/utilities/sharedState"
import Datasource from "@/model/datasource"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { readState } from "@/libs/blockchain/gcr/stateReadError"
import { DEFAULT_MIN_VALIDATOR_STAKE } from "./constants"

/**
 * The minimum stake the node last read from the active network upgrades,
 * else the protocol default. Never the operator's own setting. For the entry
 * node's checks; block apply reads the chain itself.
 */
export function chainMinValidatorStake(): bigint {
    return minStakeOf(getSharedState.governedMinValidatorStake)
}

/**
 * The minimum stake block apply holds a validator to, read from the active
 * network upgrades as the chain holds them. The node's copy is refreshed
 * after a block and keeps the last value it read, which can be stale: a
 * node judging a stake on it would apply the block differently from the
 * rest. A failed read stops the block instead.
 */
export async function chainMinValidatorStakeAtApply(): Promise<bigint> {
    const active = await readState("active network upgrades", async () =>
        (await Datasource.getInstance())
            .getDataSource()
            .getRepository(NetworkUpgrade)
            .find({
                where: { status: "active" },
                order: { effectiveAtBlock: "ASC", proposalId: "ASC" },
            }),
    )
    return minStakeOf(governedMinValidatorStake(active))
}

/** The minimum stake the latest active upgrade that sets one sets, or null. */
export function governedMinValidatorStake(
    active: Pick<NetworkUpgrade, "proposedParameters">[],
): string | null {
    let value: string | null = null
    for (const upgrade of active) {
        const proposed = upgrade.proposedParameters as
            | { minValidatorStake?: unknown }
            | null
            | undefined
        if (typeof proposed?.minValidatorStake === "string") {
            value = proposed.minValidatorStake
        }
    }
    return value
}

function minStakeOf(governed: string | null): bigint {
    if (typeof governed === "string" && governed.length > 0) {
        try {
            return BigInt(governed)
        } catch {
            /* fall through */
        }
    }
    return BigInt(DEFAULT_MIN_VALIDATOR_STAKE)
}

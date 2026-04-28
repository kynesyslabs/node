import Datasource from "@/model/datasource"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { getSharedState } from "@/utilities/sharedState"
import { getGenesisNetworkParameters } from "@/features/networkUpgrade/constants"
import type { NetworkParameters } from "@/features/networkUpgrade/types"
import log from "@/utilities/logger"

// Precedence: governance (DB active rows) > env (Config) > hardcoded fallback.
// Folds active upgrades onto env-resolved genesis in activation order;
// later proposals overwrite earlier ones key-by-key.
export async function loadNetworkParameters(
    repo?: Awaited<
        ReturnType<typeof Datasource.getInstance>
    >["getDataSource"] extends () => infer DS
        ? DS extends { getRepository: (e: typeof NetworkUpgrade) => infer R }
            ? R
            : never
        : never,
): Promise<NetworkParameters> {
    let resolvedRepo = repo as
        | import("typeorm").Repository<NetworkUpgrade>
        | undefined
    if (!resolvedRepo) {
        const db = await Datasource.getInstance()
        resolvedRepo = db.getDataSource().getRepository(NetworkUpgrade)
    }

    let active: NetworkUpgrade[] = []
    try {
        active = await resolvedRepo.find({
            where: { status: "active" },
            order: { effectiveAtBlock: "ASC", proposalId: "ASC" },
        })
    } catch (e) {
        log.error(
            "NETWORK_PARAMETERS",
            `Failed to read active upgrades; falling back to genesis defaults: ${(e as Error).message}`,
        )
    }

    const genesis = getGenesisNetworkParameters()
    const params: NetworkParameters = {
        ...genesis,
        featureFlags: { ...genesis.featureFlags },
    }

    for (const upgrade of active) {
        if (!upgrade.proposedParameters) continue
        for (const [key, value] of Object.entries(upgrade.proposedParameters)) {
            if (key === "featureFlags" && value && typeof value === "object") {
                Object.assign(
                    params.featureFlags,
                    value as Record<string, boolean>,
                )
            } else {
                ;(params as unknown as Record<string, unknown>)[key] = value
            }
        }
    }

    getSharedState.networkParameters = params
    // Mirror onto legacy flat fields still read by calculateCurrentGas / getShard.
    ;(getSharedState as unknown as { rpcFee: number }).rpcFee = params.rpcFee
    ;(getSharedState as unknown as { shardSize: number }).shardSize =
        params.shardSize
    log.info(
        "NETWORK_PARAMETERS",
        `Loaded NetworkParameters from ${active.length} active upgrade(s): ${JSON.stringify(params)}`,
    )
    return params
}

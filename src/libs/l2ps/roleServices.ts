import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"
import { L2PSHashService } from "./L2PSHashService"
import { L2PSBatchAggregator } from "./L2PSBatchAggregator"

/**
 * L2PS services change network state (they submit hash updates and batch
 * txs), so they run only while this node is staked and has joined at
 * least one L2PS network. Driven by the staked-set change hook; both
 * services have idempotent start/stop.
 */
export async function syncL2PSServices(staked: boolean): Promise<void> {
    const joined = getSharedState.l2psJoinedUids?.length ?? 0
    const shouldRun = staked && joined > 0
    const hashService = L2PSHashService.getInstance()
    const aggregator = L2PSBatchAggregator.getInstance()
    try {
        if (shouldRun) {
            await hashService.start()
            await aggregator.start()
            log.info(
                `[L2PS] services running: node staked, ${joined} joined network(s)`,
            )
        } else {
            await hashService.stop(3000)
            await aggregator.stop(3000)
            log.info(
                `[L2PS] services stopped: ${staked ? "no joined networks" : "node not staked"}`,
            )
        }
    } catch (e) {
        log.error(
            `[L2PS] service toggle failed: ${e instanceof Error ? e.message : String(e)}`,
        )
    }
}

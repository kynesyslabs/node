import Alea from "alea"

import Chain from "src/libs/blockchain/chain"
import Block from "src/libs/blockchain/block"
import { Peer } from "src/libs/peer"
import { Config } from "src/config"
import { getSharedState } from "src/utilities/sharedState"
import log from "src/utilities/logger"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import { SECRETARY_ROTATION_GRACE_SECONDS } from "../../routines/consensusTime"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import { getEligiblePool, pinShardIdentities } from "./getShard"

const FRESHNESS_WINDOWS = 2

export async function recordSyncedBlock(block: Block): Promise<void> {
    try {
        const threshold = Config.getInstance().core.stallDetectionBlocks
        if (!threshold || threshold <= 0) {
            return
        }
        if (getSharedState.fastSyncCount === 0 || block.number === 0) {
            return
        }

        const ourKey = getSharedState.publicKeyHex
        const signatures = block.validation_data?.signatures ?? {}
        if (signatures[ourKey]) {
            getSharedState.consecutiveMissedShardBlocks = 0
            return
        }

        const blockTimestamp = block.content?.timestamp
        const freshnessWindow =
            FRESHNESS_WINDOWS *
            (getSharedState.getConsensusTime() +
                SECRETARY_ROTATION_GRACE_SECONDS)
        if (
            typeof blockTimestamp !== "number" ||
            getNetworkTimestamp() - blockTimestamp > freshnessWindow
        ) {
            return
        }

        if (!(await wasSelectedForBlock(block, ourKey))) {
            return
        }

        const missed = ++getSharedState.consecutiveMissedShardBlocks
        log.error(
            `[STALL DETECTION] Drawn into the shard for block ${block.number} but our signature is missing (${missed}/${threshold})`,
        )

        if (missed >= threshold) {
            log.error(
                `[STALL DETECTION] Missed ${missed} consecutive shard selections, last at block ${block.number}: ` +
                    "the node appears stalled — exiting for log investigation",
            )
            process.exit(0)
        }
    } catch (error) {
        log.error(
            `[STALL DETECTION] Detection failed for block ${block.number}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        )
    }
}

/* Detection-grade reconstruction of the forging shard: the draw's liveness
   filter is the forger's online view, which is not observable after the fact
   (see verifyBlock), so the block's committed peerlist stands in for it. */
async function wasSelectedForBlock(
    block: Block,
    ourKey: string,
): Promise<boolean> {
    const prevBlock = await Chain.getBlockByNumber(block.number - 1)
    if (!prevBlock) {
        return false
    }

    const committed = new Set<string>()
    const rawPeerlist = block.content?.peerlist as unknown as unknown[]
    if (Array.isArray(rawPeerlist)) {
        for (const entry of rawPeerlist) {
            if (typeof entry === "string" && entry.length > 0) {
                committed.add(entry.toLowerCase())
            }
        }
    }
    if (!committed.has(ourKey)) {
        return false
    }

    const pool = await getEligiblePool(block.number - 1)
    const candidates = pool.filter(id => committed.has(id))
    if (!candidates.includes(ourKey)) {
        return false
    }

    const { commonValidatorSeed } = await getCommonValidatorSeed(prevBlock)

    let committeeSize = getSharedState.shardSize
    if (candidates.length < committeeSize) {
        committeeSize = candidates.length
    }

    const deterministicRandomness = Alea(commonValidatorSeed)
    const available = candidates.map(id => new Peer("", id))
    const shard: Peer[] = []
    for (let i = 0; i < committeeSize && available.length > 0; i++) {
        const index = Math.floor(deterministicRandomness() * available.length)
        shard.push(available[index])
        available.splice(index, 1)
    }

    pinShardIdentities(
        shard,
        candidates.map(id => new Peer("", id)),
    )

    return shard.some(member => member.identity === ourKey)
}

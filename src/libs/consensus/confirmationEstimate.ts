import Chain from "src/libs/blockchain/chain"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import { getSharedState } from "src/utilities/sharedState"

/**
 * Which block a transaction accepted now is expected to land in.
 *
 * Rounds start when network time minus the last block's timestamp reaches
 * the consensus interval. A tx that arrives late in the interval — past
 * two thirds of it — or while a round is already running cannot make the
 * next block, so it is estimated one block further out. Tx propagation is
 * fire-and-forget, so this is an estimate for clients to poll against,
 * not a promise.
 */
export function estimateConfirmationBlock(input: {
    lastBlockNumber: number
    lastBlockTimestamp: number
    now: number
    blockTime: number
    inConsensusLoop: boolean
}): number {
    const age = Math.max(0, input.now - input.lastBlockTimestamp)
    const late = input.inConsensusLoop || age >= (2 * input.blockTime) / 3
    return input.lastBlockNumber + (late ? 2 : 1)
}

export async function estimateNextConfirmationBlock(): Promise<number> {
    const lastBlock = await Chain.getLastBlock()
    return estimateConfirmationBlock({
        lastBlockNumber: getSharedState.lastBlockNumber,
        lastBlockTimestamp: Number(lastBlock?.content?.timestamp ?? 0),
        now: getNetworkTimestamp(),
        blockTime: getSharedState.getConsensusTime(),
        inConsensusLoop: getSharedState.inConsensusLoop,
    })
}

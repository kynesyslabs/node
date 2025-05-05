import { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"
import { Blocks } from "src/model/entities/Blocks"
import Hashing from "src/libs/crypto/hashing"
import log from "src/utilities/logger"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function defaultLogger(message: string) {
    return log.debug(message)
}

// REVIEW Probably to improve entropy
export default async function getCommonValidatorSeed(
    lastBlock: Blocks = null,
    logger: (message: string) => void = defaultLogger,
): Promise<{
    commonValidatorSeed: string
    lastBlockNumber: number
}> {
    const blockCount = 3

    if (!lastBlock) {
        lastBlock = await Chain.getLastBlock()
    }

    const lastBlockNumber = lastBlock.number
    const lastFewBlocks: Blocks[] = [lastBlock]

    logger("LAST BLOCK NUMBER: " + lastBlock.number)
    logger("--------------------------------")
    logger("LAST BLOCK: " + lastBlock.hash)
    logger("--------------------------------")

    while (lastFewBlocks.length < blockCount) {
        const block = await Chain.getBlockByNumber(
            lastBlockNumber - lastFewBlocks.length,
        )

        if (block) {
            lastFewBlocks.push(block)
        } else {
            // INFO: Should only happen iff lastBlockNumber < 3
            break
        }
    }

    // Getting the proposers of the last three blocks
    const proposers = lastFewBlocks.map(block => block.proposer)
    const hashes = lastFewBlocks.map(block => block.hash)
    const lastTimestamps = lastFewBlocks.map(block => block.content.timestamp)

    logger("proposers: " + JSON.stringify(proposers))
    logger("hashes: " + JSON.stringify(hashes))
    logger("lastTimestamps: " + JSON.stringify(lastTimestamps))
    logger("--------------------------------")

    // Hash everything
    const hashedProposers = Hashing.sha256(JSON.stringify(proposers))
    const hashedHashes = Hashing.sha256(JSON.stringify(hashes))
    const hashedTimestamps = Hashing.sha256(JSON.stringify(lastTimestamps))

    logger("hashedProposers: " + hashedProposers)
    logger("hashedHashes: " + hashedHashes)
    logger("hashedTimestamps: " + hashedTimestamps)
    // Get the common validator seed
    const commonValidatorSeed = Hashing.sha256(
        hashedProposers + hashedHashes + hashedTimestamps,
    )

    // NOTE The common validator seed is set in the sharedState as soon as it is computed
    getSharedState.currentValidatorSeed = commonValidatorSeed
    logger(`Common validator seed: ${commonValidatorSeed}`)
    return { commonValidatorSeed, lastBlockNumber }
}

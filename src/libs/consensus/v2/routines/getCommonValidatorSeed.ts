import { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"
import { Blocks } from "src/model/entities/Blocks"
import Hashing from "src/libs/crypto/hashing"
import log from "src/utilities/logger"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// REVIEW Probably to improve entropy
export default async function getCommonValidatorSeed(
    lastBlock: Blocks = null,
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

    log.debug("LAST BLOCK NUMBER: " + lastBlock.number)
    log.debug("--------------------------------")
    log.debug("LAST BLOCK: " + lastBlock.hash)
    log.debug("--------------------------------")

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

    log.debug("proposers: " + JSON.stringify(proposers))
    log.debug("hashes: " + JSON.stringify(hashes))
    log.debug("lastTimestamps: " + JSON.stringify(lastTimestamps))
    log.debug("--------------------------------")

    // Hash everything
    const hashedProposers = Hashing.sha256(JSON.stringify(proposers))
    const hashedHashes = Hashing.sha256(JSON.stringify(hashes))
    const hashedTimestamps = Hashing.sha256(JSON.stringify(lastTimestamps))

    log.debug("hashedProposers: " + hashedProposers)
    log.debug("hashedHashes: " + hashedHashes)
    log.debug("hashedTimestamps: " + hashedTimestamps)
    // Get the common validator seed
    const commonValidatorSeed = Hashing.sha256(
        hashedProposers + hashedHashes + hashedTimestamps,
    )

    // NOTE The common validator seed is set in the sharedState as soon as it is computed
    getSharedState.currentValidatorSeed = commonValidatorSeed
    log.info(`Common validator seed: ${commonValidatorSeed}`)
    return { commonValidatorSeed, lastBlockNumber }
}

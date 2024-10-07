import { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"
import { Blocks } from "src/model/entities/Blocks"
import Hashing from "src/libs/crypto/hashing"
import log from "src/utilities/logger"

// REVIEW Probably to improve entropy
export default async function getCommonValidatorSeed(): Promise<string> {
    var lastThreeBlocks: Blocks[] = []
    const lastBlockNumber = await Chain.getLastBlockNumber()
    // If we have less than 3 blocks, the hash is calculated from the last block // ? Maybe we should revamp this a little
    if (lastBlockNumber < 3) {
        const block = await Chain.getBlockByNumber(lastBlockNumber)
        lastThreeBlocks.push(block)
    } else {
        // Get the last three blocks
        for (let i = 0; i < 3; i++) {
            const block = await Chain.getBlockByNumber(lastBlockNumber - i)
            lastThreeBlocks.push(block)
        }
    }
    // Getting the proposers of the last three blocks
    const proposers = lastThreeBlocks.map(block => block.proposer)
    const hashes = lastThreeBlocks.map(block => block.hash)
    const validationDatas = lastThreeBlocks.map(block => block.validation_data)
    const lastTimestamps = lastThreeBlocks.map(block => block.content.timestamp)
    // Hash everything
    const hashedProposers = Hashing.sha256(JSON.stringify(proposers))
    const hashedHashes = Hashing.sha256(JSON.stringify(hashes))
    const hashedValidationDatas = Hashing.sha256(
        JSON.stringify(validationDatas),
    )
    const hashedTimestamps = Hashing.sha256(JSON.stringify(lastTimestamps))
    // Get the common validator seed
    const commonValidatorSeed = Hashing.sha256(
        hashedProposers + hashedHashes + hashedValidationDatas + hashedTimestamps,
    )
    // NOTE The common validator seed is set in the sharedState as soon as it is computed
    getSharedState.currentValidatorSeed = commonValidatorSeed
    log.info(`Common validator seed: ${commonValidatorSeed}`)
    return commonValidatorSeed
}

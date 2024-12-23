import { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"
import { Blocks } from "src/model/entities/Blocks"
import Hashing from "src/libs/crypto/hashing"
import log from "src/utilities/logger"

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// REVIEW Probably to improve entropy
export default async function getCommonValidatorSeed(): Promise<{
    commonValidatorSeed: string
    lastBlockNumber: number
}> {
    var lastThreeBlocks: Blocks[] = []
    let lastBlock = await Chain.getLastBlock()

    log.debug("LAST BLOCK NUMBER: " + lastBlock.number)
    log.debug("--------------------------------")
    log.debug("LAST BLOCK: " + lastBlock.hash)
    log.debug("--------------------------------")

    if (lastBlock.number !== getSharedState.lastBlockNumber) {
        await sleep(250)

        lastBlock = await Chain.getLastBlock()
        log.debug("SLEPT LAST BLOCK NUMBER: " + lastBlock.number)
        log.debug("--------------------------------")
        log.debug("SLEPT LAST BLOCK: " + lastBlock.hash)
        log.debug("--------------------------------")
    }
    const lastBlockNumber = lastBlock.number

    // getSharedState.currentValidatorSeed = lastBlock.number.toString()
    // return { commonValidatorSeed: lastBlock.number.toString(), lastBlockNumber }

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
    const validationDatas = lastThreeBlocks.map(block => {
        // Sort the signatures by the key and create a string
        try {
            const signatures = JSON.parse(block.validation_data)["signatures"]
            const sortedSignatures = Object.keys(signatures)
                .sort()
                .map(key => "key:" + key + "signature:" + signatures[key] + ";")
                .join("")
            return sortedSignatures
        } catch (error) {
            return block.validation_data
        }
    })
    const lastTimestamps = lastThreeBlocks.map(block => block.content.timestamp)

    log.debug("proposers: " + JSON.stringify(proposers))
    log.debug("hashes: " + JSON.stringify(hashes))
    log.debug("validationDatas: " + JSON.stringify(validationDatas))
    log.debug("lastTimestamps: " + JSON.stringify(lastTimestamps))
    log.debug("--------------------------------")
    // Hash everything
    const hashedProposers = Hashing.sha256(JSON.stringify(proposers))
    const hashedHashes = Hashing.sha256(JSON.stringify(hashes))
    const hashedValidationDatas = Hashing.sha256(
        JSON.stringify(validationDatas),
    )
    const hashedTimestamps = Hashing.sha256(JSON.stringify(lastTimestamps))

    log.debug("hashedProposers: " + hashedProposers)
    log.debug("hashedHashes: " + hashedHashes)
    log.debug("hashedValidationDatas: " + hashedValidationDatas)
    log.debug("hashedTimestamps: " + hashedTimestamps)
    // Get the common validator seed
    const commonValidatorSeed = Hashing.sha256(
        hashedProposers +
            hashedHashes +
            hashedValidationDatas +
            hashedTimestamps,
    )

    // NOTE The common validator seed is set in the sharedState as soon as it is computed
    getSharedState.currentValidatorSeed = commonValidatorSeed
    log.info(`Common validator seed: ${commonValidatorSeed}`)
    return { commonValidatorSeed, lastBlockNumber }
}

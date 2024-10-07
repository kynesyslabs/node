import Transaction from "src/libs/blockchain/transaction"
import getCommonValidatorSeed from "./routines/getCommonValidatorSeed"
import getShard from "./routines/getShard"
import Mempool, { MempoolData } from "src/libs/blockchain/mempool"
import Block from "src/libs/blockchain/block"
import Hashing from "src/libs/crypto/hashing"
import Cryptography from "src/libs/crypto/cryptography"
import Chain from "src/libs/blockchain/chain"
import { getSharedState } from "src/utilities/sharedState"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"
import {
    ConsensusHashVote,
    ConsensusHashResponse,
    ValidationData,
} from "./interfaces"
import { mergeMempools } from "./routines/mergeMempools"
import { createBlock } from "./routines/createBlock"
import { orderTransactions } from "./routines/orderTransactions"
import { broadcastBlockHash } from "./routines/broadcastBlockHash"
import averageTimestamps from "./routines/averageTimestamp"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import { RPCRequest } from "@kynesyslabs/demosdk/types"
import ShardManager, {
    ValidatorStatus,
    getShardManager,
} from "./routines/shardManager"

/* INFO

# Semaphore system

 The consensus routine is the main function that runs the consensus algorithm.
 Within the consensus routine there is a semaphore system that ensure the shard
 to have a common state and to avoid race conditions such as node desynchronization.
 
 Each important step of the consensus routine broadcast a message to the shard
 to inform the other nodes that the step has been completed.
 
 All the nodes in the shard (including the local node) will wait for the step to be completed 
 before proceeding to the next step.
 
 This way we ensure that the shard will have a common state and will be able to
 continue the consensus routine.

 For example, the shard manager is initialized at the beginning of the consensus routine
 and the local status is updated to reflect that we are in consensus loop.
 Prior to continue the consensus routine, the local node will wait that also the
 other nodes in the shard are in consensus loop by checking the validator statuses.
    
 The semaphore system is implemented by the ShardManager class.

 # Synchronization of timestamps

 The local node timestamp is calculated from the NTP server pool so that is precise
 and UTC based.
 
 This happens at each mainLoop cycle, and is the basis to check if the consensus time
 is reached and to compute the average timestamp of the last block.

 This allows to have a precise time synchronization between the nodes in the shard within
 a +/-2 second range.
 
*/

// Main consensus routine calling all the subroutines
export async function consensusRoutine(): Promise<void> {
    if (isConsensusAlreadyRunning()) {
        log.warning(
            "[consensusRoutine] Consensus loop already running: keeping it running (returning)",
            false,
        )
        return
    }

    // Initialize the consensus state and check if the local node is in the shard
    initializeConsensusState()
    const shard = await initializeShard()

    if (!isInShard(shard)) {
        log.info(
            "[consensusRoutine] We are not in the shard, waiting for the block",
        )
        return
    }

    log.info("[consensusRoutine] We are in the shard, creating the block")
    log.info(`[consensusRoutine] shard: ${shard}`, false)

    // Initialize the shard manager transmitting that we are in consensus loop
    await initializeShardManager(shard)

    // Here we wait that the shard is ready by checking the validators statuses and if they are in consensus loop
    // We can't continue until the shard is ready and synced to our validator status
    // ? Should we use updateValidatorStatus instead of waitUntilShardIsReady directly?
    let shardIsReady = await getShardManager.waitUntilShardIsReady(
        getShardManager.getOurValidatorStatus(),
    )
    // See ShardManager.ts -> waitUntilShardIsReady for the above call
    // TODO Do something with the shardIsReady variable
    log.info("[consensusRoutine] Shard readiness is: " + shardIsReady)

    // synchronize and average the time between the shard and the local node
    await synchronizeAndAverageTime(shard)
    // Merge and order the mempools between the shard and the local node
    const mempool = await mergeAndOrderMempools(shard)

    log.info(
        "[consensusRoutine] mempool merged (aka ordered transactions)",
        true,
    )
    log.info(
        "[consensusRoutine] mempool: " + JSON.stringify(mempool, null, 2),
        true,
    )

    // Forge the block from the ordered transactions
    const block = await forgeBlock(mempool)
    // REVIEW Set last consensus time to the current block timestamp
    getSharedState.lastConsensusTime = block.content.timestamp

    // Vote on the block by broadcasting the block hash to the shard
    const [pro, con] = await voteOnBlock(block, shard)

    // Check if the block is valid using BFT
    if (isBlockValid(pro, shard.length)) {
        log.info(
            "[consensusRoutine] [result] Block is valid with " + pro + " votes",
        )
        await finalizeBlock(block, pro)
    } else {
        log.info(
            `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
        )
    }

    // Cleanup the consensus state
    cleanupConsensusState()
    // Destroy the shard manager to free it up for the next consensus routine
    ShardManager.destroy()
    log.info("[consensusRoutine] Consensus routine ended")
}

// Safeguard to prevent multiple consensus loops from running
export function isConsensusAlreadyRunning(): boolean {
    if (getSharedState.inConsensusLoop) {
        log.warning(
            "Consensus loop already running: keeping it running (returning)",
        )
        return true
    }
    return false
}

// Initialize the consensus state
function initializeConsensusState(): void {
    log.info("[consensusRoutine] Starting the consensus routine")
    getSharedState.consensusMode = true
    getSharedState.inConsensusLoop = true
    getSharedState.lastTimestamp = Date.now()
    // Reset the startingConsensus flag
    getSharedState.startingConsensus = false
}

// SECTION Initalizations

async function initializeShard(): Promise<Peer[]> {
    const commonValidatorSeed = await getCommonValidatorSeed()
    return await getShard(commonValidatorSeed)
}
// Initialize the shard manager
async function initializeShardManager(shard: Peer[]): Promise<void> {
    getShardManager.setShard(shard)
    const ourIdentity =
        getSharedState.identity.ed25519.publicKey.toString("hex")
    let validatorStatus = getShardManager.shardStatus.get(ourIdentity)
    validatorStatus.inConsensusLoop = true
    getShardManager.setValidatorStatus(ourIdentity, validatorStatus)
    await getShardManager.transmitOurValidatorStatus()
}

// SECTION Checks

// Check if the local node is in the shard
function isInShard(shard: Peer[]): boolean {
    const ourIdentity =
        getSharedState.identity.ed25519.publicKey.toString("hex")
    return shard.some(peer => peer.identity === ourIdentity)
}

// SECTION Routines

// Synchronize and average the time between the shard and the local node
async function synchronizeAndAverageTime(shard: Peer[]): Promise<void> {
    await fastSync(shard)
    var averageTimestamp = await averageTimestamps(shard)
    // Strip the decimal part
    if (!Number.isInteger(averageTimestamp)) {
        log.warning(
            "[synchronizeAndAverageTime] Average timestamp is not an integer",
        )
        averageTimestamp = Math.round(averageTimestamp)
    }
    getSharedState.lastConsensusTime = averageTimestamp
    await updateValidatorStatus("synchronizedTime", true, false, true)
}

// Merge and order the mempools between the shard and the local node    
async function mergeAndOrderMempools(shard: Peer[]): Promise<Transaction[]> {
    const ourMempool = await Mempool.getMempool()
    console.log("[consensusRoutine] Our mempool:")
    console.log(ourMempool)
    log.info("[consensusRoutine] Our mempool has been retrieved")
    const mergedMempool = await mergeMempools(ourMempool, shard)
    log.info("[consensusRoutine] Mempools have been merged")
    await updateValidatorStatus("mergedMempool", true, false, true)
    return await orderTransactions(mergedMempool)
}

// Forge the block from the ordered transactions
async function forgeBlock(orderedTransactions: Transaction[]): Promise<Block> {
    const previousBlockHash = await Chain.getLastBlockHash()
    const lastBlockNumber = await Chain.getLastBlockNumber()
    const commonValidatorSeed = await getCommonValidatorSeed()

    const block = await createBlock(
        orderedTransactions,
        commonValidatorSeed,
        previousBlockHash,
        lastBlockNumber + 1,
    )

    await updateValidatorStatus("forgedBlock", true, false, true)
    return block
}

// Vote on the block by broadcasting the block hash to the shard
async function voteOnBlock(
    block: Block,
    shard: Peer[],
): Promise<[number, number]> {
    log.info(
        `[consensusRoutine] Broadcasting block hash to the shard: ${block.hash}`,
    )
    const [pro, con] = await broadcastBlockHash(block, shard)
    await updateValidatorStatus("votedForBlock", true, false, true)

    log.info(
        `[consensusRoutine] Block hash broadcasted to the shard: ${block.hash}`,
    )
    log.info(`[consensusRoutine] Votes:\nPro: ${pro}\nCon: ${con}`)

    return [pro, con]
}

// Check if the block is valid using BFT
function isBlockValid(pro: number, totalVotes: number): boolean {
    const threshold = Math.floor((totalVotes * 2) / 3) + 1
    log.info(`[consensusRoutine] Threshold: ${threshold}`)
    log.info(`[consensusRoutine] Total votes: ${totalVotes}`)
    return pro >= threshold
}

// Finalize the block
async function finalizeBlock(block: Block, pro: number): Promise<void> {
    log.info(`[consensusRoutine] Block is valid with ${pro} votes`)
    console.log(block)
    await Chain.insertBlock(block)
    //getSharedState.consensusMode = false
    ///getSharedState.inConsensusLoop = false
    log.info("[consensusRoutine] Block added to the chain")
    const lastBlock = await Chain.getLastBlock()
    console.log(lastBlock)
}

// Cleanup the consensus state
function cleanupConsensusState(): void {
    getSharedState.candidateBlock = null
    getSharedState.lastConsensusTime = getSharedState.currentUTCTime // REVIEW Using the current UTC time as the last consensus time
    getSharedState.inConsensusLoop = false
    getSharedState.consensusMode = false
}

// REVIEW This function updates and transmits the validator status to the shard
// NOTE If wait is true, the function will try to wait for the shard to be ready
// before returning with a timeout to prevent the consensus routine from getting stuck
// NOTE If pull is true, the function will try to pull the status from each node
// in the shard before returning to ensure the status is up to date
async function updateValidatorStatus(
    status: string,
    wait: boolean = true,
    pull: boolean = false,
    stream: boolean = true,
): Promise<boolean> {
    const ourIdentity =
        getSharedState.identity.ed25519.publicKey.toString("hex")
    let validatorStatus = getShardManager.shardStatus.get(ourIdentity)
    validatorStatus[status] = true
    getShardManager.setValidatorStatus(ourIdentity, validatorStatus)
    if (stream) {
        await getShardManager.transmitOurValidatorStatus()
    }
    // If not specified otherwise, we wait for the shard to be ready
    let ourStatus = getShardManager.getOurValidatorStatus()
    if (wait) {
        let shardIsReady = await getShardManager.waitUntilShardIsReady(
            ourStatus,
            3000,
            pull,
        )
        if (!shardIsReady) {
            log.warning(
                "[updateValidatorStatus] [ERROR] Shard is not ready: " + status,
            )
            return false
        }
        return true
    }
    return true
}

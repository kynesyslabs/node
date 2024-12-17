import Transaction from "src/libs/blockchain/transaction"
import getCommonValidatorSeed from "./routines/getCommonValidatorSeed"
import Mempool from "src/libs/blockchain/mempool"
import Block from "src/libs/blockchain/block"
import Chain from "src/libs/blockchain/chain"
import { getSharedState } from "src/utilities/sharedState"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"
import { mergeMempools } from "./routines/mergeMempools"
import mergePeerlist from "./routines/mergePeerlist"
import { createBlock } from "./routines/createBlock"
import { orderTransactions } from "./routines/orderTransactions"
import { broadcastBlockHash } from "./routines/broadcastBlockHash"
import averageTimestamps from "./routines/averageTimestamp"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import applyGCROperation from "src/libs/blockchain/gcr/gcr_routines/applyGCROperation"
import { txToGCROperation } from "src/libs/blockchain/gcr/gcr_routines/txToGCROperation"
import SecretaryManager from "./types/secretaryManager"

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

    await initializeConsensusState()
    // await fastSync([], "consensusRoutine")
    // Initialize the consensus state and check if the local node is in the shard

    const manager = SecretaryManager.getInstance()

    if (manager.shard && manager.shard.CVSA) {
        // INFO: Testing if we start a new consensus round while the previous one is not over
        // TODO: Remove this block after when opening the PR
        log.debug("WE ARE ALREADY IN ANOTHER CONSENSUS ROUND. Killing node")
        process.exit(0)
    }

    // INFO: We won't use the shard returned by initializeShard
    // as it can change through the consensus routine
    await initializeShard()

    if (!isInShard(manager.shard.members)) {
        log.info(
            "[consensusRoutine] We are not in the shard, waiting for the block",
        )
        return
    }

    log.info("[consensusRoutine] We are in the shard, creating the block")
    log.info(
        `[consensusRoutine] shard: ${JSON.stringify(manager.shard, null, 2)}`,
        false,
    )

    await updateValidatorPhase(1)
    // synchronize and average the time between the shard and the local node
    // NOTE: Instead of averaging the time, we'll use the secretary timestamp
    // await synchronizeAndAverageTime(shard)

    // Merge and order the mempools between the shard and the local node
    const mempool = await mergeAndOrderMempools(manager.shard.members)

    // REVIEW Merge the peerlist between the shard and the local node
    const peerlist = []
    // await mergePeerlistAndWait(shard)

    log.info(
        "[consensusRoutine] mempool merged (aka ordered transactions)",
        true,
    )
    log.info(
        "[consensusRoutine] mempool: " + JSON.stringify(mempool, null, 2),
        true,
    )

    /** REVIEW
     * Here we apply the GCR operations to the state before forging the block
     * so that the GCR hash is included in the block.
     * A list of successful and failed GCR operations is returned.
     * NOTE A mandatory validator status is updated to reflect that the GCR operations have been applied
     * */
    // ! Not here but check Sync.ts (syncNativeTables) and make it work with the GCR (syncing the states)
    await applyGCRForNewBlock(mempool)

    if (manager.blockTimestamp) {
        getSharedState.lastConsensusTime = manager.blockTimestamp
    } else {
        // INFO: This should never happen
        // If it does, request the block timestamp from the secretary
        log.debug(
            "[CONSENSUS ROUTINE] Secretary block timestamp not received yet, requesting it ...",
        )
        const blockTimestamp = await manager.getSecretaryBlockTimestamp()

        if (blockTimestamp) {
            getSharedState.lastConsensusTime = blockTimestamp
        } else {
            log.error(
                "[CONSENSUS ROUTINE] Block timestamp is not set, stopping the node ...",
            )
            process.exit(1)
        }
    }

    // Forge the block from the ordered transactions
    const block = await forgeBlock(mempool, peerlist) // NOTE The GCR hash is calculated here and added to the block
    // REVIEW Set last consensus time to the current block timestamp
    getSharedState.lastConsensusTime = block.content.timestamp

    // Vote on the block by broadcasting the block hash to the shard
    const [pro, con] = await voteOnBlock(block, manager.shard.members)

    // Check if the block is valid using BFT
    if (isBlockValid(pro, manager.shard.members.length)) {
        log.info(
            "[consensusRoutine] [result] Block is valid with " + pro + " votes",
        )
        await finalizeBlock(block, pro)
    } else {
        log.info(
            `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
        )
    }

    // INFO: Ending the consensus!
    await updateValidatorPhase(7)
    manager.endConsensusRoutine()
    // Cleanup the consensus state
    cleanupConsensusState()
    log.debug("[consensusRoutine] CONSENSUS ROUTINE ENDED 🔥🔥🔥")
}

// SECTION: Consensus functions!

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
async function initializeConsensusState(): Promise<void> {
    log.info("[consensusRoutine] Starting the consensus routine")
    getSharedState.consensusMode = true
    getSharedState.inConsensusLoop = true
    getSharedState.lastTimestamp = getNetworkTimestamp()
    // Reset the startingConsensus flag
    getSharedState.startingConsensus = false
}

// SECTION Initalizations

async function initializeShard(): Promise<Peer[]> {
    const { commonValidatorSeed, lastBlockNumber } =
        await getCommonValidatorSeed()
    // return await getShard(commonValidatorSeed)

    const manager = SecretaryManager.getInstance()
    return await manager.initializeShard(commonValidatorSeed, lastBlockNumber)
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
    await fastSync(shard, "synchronizeAndAverageTime")
    var averageTimestamp = await averageTimestamps(shard)
    // Strip the decimal part
    if (!Number.isInteger(averageTimestamp)) {
        log.warning(
            "[synchronizeAndAverageTime] Average timestamp is not an integer",
        )
        averageTimestamp = Math.round(averageTimestamp)
    }
    getSharedState.lastConsensusTime = averageTimestamp
    // Using the secretary to update the local statuses
    await updateValidatorPhase(2)
}

// Merge the peerlist between the shard and the local node
async function mergePeerlistAndWait(shard: Peer[]): Promise<Peer[]> {
    const mergedPeerList = await mergePeerlist(shard)
    //await updateValidatorStatus("mergedPeerlist", true, false, true)
    // Using the secretary to update the local statuses
    await updateValidatorPhase("mergedPeerlist", true, false, true)
    return mergedPeerList
}

// Merge and order the mempools between the shard and the local node
async function mergeAndOrderMempools(shard: Peer[]): Promise<Transaction[]> {
    const ourMempool = await Mempool.getMempool("mergeAndOrderMempools")
    console.log("[consensusRoutine] Our mempool:")
    console.log(ourMempool)
    log.info("[consensusRoutine] Our mempool has been retrieved")
    const mergedMempool = await mergeMempools(ourMempool, shard)
    log.info("[consensusRoutine] Mempools have been merged")
    // await updateValidatorStatus("mergedMempool", true, false, true)
    // Using the secretary to update the local statuses
    await updateValidatorPhase(3)
    return await orderTransactions(mergedMempool)
}

// Forge the block from the ordered transactions
async function forgeBlock(
    orderedTransactions: Transaction[],
    peerlist: Peer[] = [],
): Promise<Block> {
    const previousBlockHash = await Chain.getLastBlockHash()
    // const lastBlockNumber = await Chain.getLastBlockNumber()
    const { commonValidatorSeed, lastBlockNumber } =
        await getCommonValidatorSeed()

    // REVIEW Add the GCR hash to the block should be done in createBlock
    const block = await createBlock(
        orderedTransactions,
        commonValidatorSeed,
        previousBlockHash,
        lastBlockNumber + 1,
        peerlist,
    )

    // await updateValidatorStatus("forgedBlock", true, false, true)
    // Using the secretary to update the local statuses
    await updateValidatorPhase(5)
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
    // await updateValidatorStatus("votedForBlock", true, false, true)
    // Using the secretary to update the local statuses
    await updateValidatorPhase(6)

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
    await Chain.insertBlock(block) // NOTE Transactions are added to the Transactions table here
    //getSharedState.consensusMode = false
    ///getSharedState.inConsensusLoop = false
    log.info("[consensusRoutine] Block added to the chain")
    const lastBlock = await Chain.getLastBlock()
    console.log(lastBlock)
}

// REVIEW Apply the GCR operations to the state
async function applyGCRForNewBlock(
    mempool: Transaction[],
): Promise<[string[], string[]]> {
    let successfulTxs: string[] = []
    let failedTxs: string[] = []
    for (const tx of mempool) {
        const operation = await txToGCROperation(tx)
        let success = await applyGCROperation(operation)
        if (success) {
            successfulTxs.push(tx.hash)
        } else {
            failedTxs.push(tx.hash)
        }
    }
    log.info(`[consensusRoutine] Successful GCR operations: ${successfulTxs}`)
    log.info(`[consensusRoutine] Failed GCR operations: ${failedTxs}`)
    // await updateValidatorStatus("appliedGCR", true, false, true)
    // Using the secretary to update the local statuses
    await updateValidatorPhase(4)
    return [successfulTxs, failedTxs]
}

/**
 * Sends our validator phase to the secretary, and waits for the greenlight.
 *
 * @param phase - Our cleared phase number
 * @returns The block timestamp returned by the secretary
 */
async function updateValidatorPhase(phase: number): Promise<any> {
    const manager = SecretaryManager.getInstance()
    await manager.setOurValidatorPhase(phase, true)

    // INFO: If it's the first phase, the secretary might not have started the consensus routine yet,
    // Increase retry steps to 10 to wait for the secretary to start
    const retries = phase === 1 ? 10 : 3
    const res = await manager.sendOurValidatorPhaseToSecretary(retries)

    log.debug(
        `[updateValidatorStatus 🎉] Validator phase ${phase} resolved with value: ${JSON.stringify(
            res,
            null,
            2,
        )}`,
    )

    return res
}

// Cleanup the consensus state
function cleanupConsensusState(): void {
    getSharedState.candidateBlock = null
    getSharedState.lastConsensusTime = getSharedState.currentUTCTime // REVIEW Using the current UTC time as the last consensus time
    getSharedState.inConsensusLoop = false
    getSharedState.consensusMode = false

    // INFO: Somehow this is not reset when starting a consensus??
    getSharedState.startingConsensus = false
}

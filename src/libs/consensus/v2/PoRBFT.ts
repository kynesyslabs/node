import Transaction from "src/libs/blockchain/transaction"
import getCommonValidatorSeed from "./routines/getCommonValidatorSeed"
import Mempool from "src/libs/blockchain/mempool_v2"
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
import {
    BlockInvalidError,
    ForgingEndedError,
    NotInShardError,
} from "src/exceptions"
import HandleGCR from "src/libs/blockchain/gcr/handleGCR"
import { GCREdit } from "@kynesyslabs/demosdk/types"

/* INFO
# Semaphore system

 The consensus routine is the main function that runs the consensus algorithm.
 Within the consensus routine there is a secretary system that ensure the shard
 to have a common state and to avoid race conditions such as node desynchronization.

 The secretary node is chosen as the first node in the shard, and it cordinates the
 progression of the consensus routine.
 
 For each important step of the consensus routine, the local node will broadcast a
 message to the secretary to inform them that the step has been completed. When all
 nodes have completed the step, the secretary will send a message to the shard
 to inform them that the step has been completed and they can continue with the next step.
 
 This way we ensure that the shard will have a common state and will be able to
 continue the consensus routine.

 For example, the SecretaryManager is initialized at the beginning of the consensus routine
 and the local status is updated to reflect that we are in consensus loop. Then the node 
 will send a message to the secretary to inform them that we are in consensus loop.
 Prior to continue the consensus routine, the local node will wait that also the
 other nodes in the shard are in consensus loop by waiting for the secretary to send
 a message (greenlight) to continue the consensus routine.
*/

/**
 * The main consensus routine calling all the subroutines.
 */
export async function consensusRoutine(): Promise<void> {
    if (isConsensusAlreadyRunning()) {
        log.warning(
            "[consensusRoutine] Consensus loop already running: keeping it running (returning)",
            false,
        )
        return
    }
    log.debug("🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥")
    const manager = SecretaryManager.getInstance()

    // Defining the variables needed for rolling back the GCREdits
    let successfulTxs: string[] = []
    let failedTxs: string[] = []
    let tempMempool: Transaction[] = []

    try {
        await initializeConsensusState()

        // await fastSync([], "consensusRoutine")
        // Initialize the consensus state and check if the local node is in the shard
        // INFO: We won't use the shard returned by initializeShard
        // as it can change through the consensus routine
        // INFO: CONSENSUS ACTION 1: Initialize the shard
        await initializeShard()
        log.debug("Forgin block: " + manager.shard.blockRef)
        log.info("[consensusRoutine] We are in the shard, creating the block")
        log.info(
            `[consensusRoutine] shard: ${JSON.stringify(
                manager.shard,
                null,
                2,
            )}`,
            false,
        )

        // INFO: Broadcast our validation phase to the secretary
        await updateValidatorPhase(1)

        // synchronize and average the time
        // NOTE: Instead of averaging the time, we'll use the secretary timestamp
        // await synchronizeAndAverageTime(shard)

        // INFO: CONSENSUS ACTION 2: Merge and order the mempools
        tempMempool = await mergeAndOrderMempools(
            manager.shard.members,
            manager.shard.blockRef,
        )
        log.debug("MErged mempool: " + JSON.stringify(tempMempool.map((tx) => tx.hash), null, 2))

        log.info(
            "[consensusRoutine] mempool merged (aka ordered transactions)",
            true,
        )
        // INFO: CONSENSUS ACTION 3: Merge the peerlist (skipped)
        // Merge the peerlist
        const peerlist = []
        // await mergePeerlistAndWait(shard)

        // INFO: CONSENSUS ACTION 4: Apply the GCR operations to the state before forging the block
        /**
         * Here we apply the GCR operations to the state before forging the block
         * so that the GCR hash is included in the block.
         * A list of successful and failed GCR operations is returned.
         * NOTE A mandatory validator status is updated to reflect that the GCR operations have been applied
         * */
        // ? The following line could be outdated once we use the GCREdit stuff
        // await applyGCRForNewBlock(mempool)

        // Applying the GCREdits and see if everything is consistent
        const [localSuccessfulTxs, localFailedTxs] =
            await applyGCREditsFromMergedMempool(tempMempool)
        successfulTxs = successfulTxs.concat(localSuccessfulTxs)
        failedTxs = failedTxs.concat(localFailedTxs)
        if (failedTxs.length > 0) {
            log.error(
                "[consensusRoutine] Failed Txs found, pruning the mempool",
            )
            //  Prune the mempool of the failed txs
            // NOTE The mempool should now be updated with only the successful txs
            for (const tx of failedTxs) {
                log.error("Failed tx: " + tx)
                await Mempool.removeTransactionsByHashes([tx])
            }
        }

        // REVIEW Re-merge the mempools anyway to get the correct mempool from the whole shard
        // const mempool = await mergeAndOrderMempools(manager.shard.members)

        log.info(
            "[consensusRoutine] mempool: " +
                JSON.stringify(tempMempool, null, 2),
            true,
        )

        // INFO: At this point, we should have the secretary block timestamp
        // if we're connected to the secretary and recieved atleast one successful request from them
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
                    "[CONSENSUS ROUTINE] Block timestamp could not be resolved, exiting the consensus routine",
                )
                return
            }
        }

        // INFO: CONSENSUS ACTION 5: Forge the block
        const block = await forgeBlock(tempMempool, peerlist) // NOTE The GCR hash is calculated here and added to the block
        // REVIEW Set last consensus time to the current block timestamp
        getSharedState.lastConsensusTime = block.content.timestamp

        // INFO: CONSENSUS ACTION 6: Vote on the block
        const [pro, con] = await voteOnBlock(block, manager.shard.members)

        // Check if the block is valid
        if (isBlockValid(pro, manager.shard.members.length)) {
            log.info(
                "[consensusRoutine] [result] Block is valid with " +
                    pro +
                    " votes",
            )
            await finalizeBlock(block, pro)
        } else {
            log.info(
                `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
            )
            // Raising an error to rollback the GCREdits
            throw new BlockInvalidError(
                `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
            )
        }

        // INFO: CONSENSUS ACTION 7: End the consensus routine
        await updateValidatorPhase(7)
    } catch (error) {
        if (error instanceof NotInShardError) {
            log.info(
                "[consensusRoutine] We are not in the shard, waiting for the block",
            )
            return
        }

        if (error instanceof ForgingEndedError) {
            log.info(
                "[consensusRoutine] We are forging an ended block. Exiting the consensus routine",
            )
            return
        }
        if (error instanceof BlockInvalidError) {
            log.info(
                "[consensusRoutine] Block is invalid. Rolling back the GCREdits",
            )
            // REVIEW Using the successfulTxs to rollback the GCREdits derived from those txs
            // Getting the txs from the hashes
            const txsToRollback: Transaction[] = []
            for (const txHash of successfulTxs) {
                const tx = tempMempool.find(tx => tx.hash === txHash)
                if (tx) {
                    txsToRollback.push(tx)
                }
            }
            await rollbackGCREditsFromTxs(txsToRollback)
            await Mempool.removeTransactionsByHashes(successfulTxs)

            return
        }
    } finally {
        manager.endConsensusRoutine()
        // Cleanup the consensus state
        cleanupConsensusState()
        // Joining the temporary mempool to the main one
        // await Mempool.joinTemporaryMempool() // ? Is await ok here?
    }

    log.debug("👋👋👋👋👋👋👋👋👋👋👋👋👋👋👋👋👋👋👋👋👋")
    log.debug("[consensusRoutine] CONSENSUS ROUTINE ENDED 🔥🔥🔥")
}

// SECTION: Consensus functions!

/**
 * Safeguard to prevent multiple consensus loops from running
 *
 * @returns True if the consensus loop is already running, false otherwise
 */
export function isConsensusAlreadyRunning(): boolean {
    if (getSharedState.inConsensusLoop) {
        log.warning(
            "Consensus loop already running: keeping it running (returning)",
        )
        return true
    }

    return false
}

/**
 * Initialize the consensus state
 */
async function initializeConsensusState(): Promise<void> {
    log.info("[consensusRoutine] Starting the consensus routine")
    getSharedState.consensusMode = true
    getSharedState.inConsensusLoop = true
    getSharedState.lastTimestamp = getNetworkTimestamp()
    // Reset the startingConsensus flag
    getSharedState.startingConsensus = false
}

// SECTION Initalizations

/**
 * Initialize the shard and return the shard members
 *
 * @returns The shard members
 */
async function initializeShard(): Promise<Peer[]> {
    const { commonValidatorSeed, lastBlockNumber } =
        await getCommonValidatorSeed()
    // return await getShard(commonValidatorSeed)

    const manager = SecretaryManager.getInstance()
    return await manager.initializeShard(commonValidatorSeed, lastBlockNumber)
}

// SECTION Checks

/**
 * Check if the local node is in the shard
 *
 * @param shard - The shard members
 * @returns True if the local node is in the shard, false otherwise
 */
function isInShard(shard: Peer[]): boolean {
    const ourIdentity =
        getSharedState.identity.ed25519.publicKey.toString("hex")
    return shard.some(peer => peer.identity === ourIdentity)
}

// SECTION Routines

/**
 * Synchronize and average the time between the shard and the local node
 *
 * @param shard - The shard members
 */
async function synchronizeAndAverageTime(shard: Peer[]): Promise<void> {
    await fastSync(shard, "synchronizeAndAverageTime")
    let averageTimestamp = await averageTimestamps(shard)
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

/**
 * Merge and order the mempools between the shard and the local node
 *
 * @param shard - The shard members
 * @returns The ordered transactions
 */
async function mergeAndOrderMempools(
    shard: Peer[],
    blockNumber: number,
): Promise<(Transaction & { reference_block: number })[]> {
    const ourMempool = await Mempool.getMempool(blockNumber)
    console.log("[consensusRoutine] Our mempool:")
    console.log(ourMempool)
    log.info("[consensusRoutine] Our mempool has been retrieved")

    // NOTE: Transactions here should be ordered by timestamp
    await mergeMempools(ourMempool, shard)
    await updateValidatorPhase(3)

    return await Mempool.getMempool(blockNumber)
}

/**
 * Rollback the GCREdits from a set of txs
 *
 * @param txs - The txs
 * @returns The successful and failed GCREdits
 */
async function rollbackGCREditsFromTxs(
    txs: Transaction[],
): Promise<[string[], string[]]> {
    const successfulTxs: string[] = []
    const failedTxs: string[] = []
    // 1. Parse the txs to get the GCREdits
    for (const tx of txs) {
        // 2. Apply the GCREdits to the state for each tx with the isRollback flag set to true
        const result = await HandleGCR.applyToTx(tx, true)
        if (result.success) {
            successfulTxs.push(tx.hash)
        } else {
            failedTxs.push(tx.hash)
        }
    }
    return [successfulTxs, failedTxs]
}

/**
 * Apply the GCREdits from the merged mempool
 *
 * @param mempool - The mempool
 * @returns The successful and failed GCREdits
 */
async function applyGCREditsFromMergedMempool(
    mempool: Transaction[],
): Promise<[string[], string[]]> {
    // TODO Implement this
    const successfulTxs: string[] = []
    const failedTxs: string[] = []
    // 1. Parse the mempool txs to get the GCREdits
    for (const tx of mempool) {
        const txExists = await Chain.checkTxExists(tx.hash)
        if (txExists) {
            failedTxs.push(tx.hash)
            continue
        }

        const txGCREdits = tx.content.gcr_edits
        // 2. Apply the GCREdits to the state for each tx
        for (const gcrEdit of txGCREdits) {
            const applyResult = await HandleGCR.apply(gcrEdit, tx)
            if (applyResult.success) {
                // If the apply succeeds, add the tx to the successfulTxs array
                successfulTxs.push(tx.hash)
            } else {
                // If the apply fails, add the tx to the failedTxs array
                failedTxs.push(tx.hash)
            }
        }
    }
    // 4. Return the successful and failed GCREdits // NOTE They will be used to prune the mempool
    return [successfulTxs, failedTxs]
}

/**
 * Apply the GCR operations to the state
 *
 * @param mempool - The mempool
 * @returns The successful and failed GCR operations
 */
async function applyGCRForNewBlock(
    mempool: Transaction[],
): Promise<[string[], string[]]> {
    const successfulTxs: string[] = []
    const failedTxs: string[] = []
    for (const tx of mempool) {
        const operation = await txToGCROperation(tx)
        const success = await applyGCROperation(operation)
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
 * Merge the peerlist between the shard and the local node
 *
 * @param shard - The shard members
 * @returns The merged peerlist
 */
async function mergePeerlistAndWait(shard: Peer[]): Promise<Peer[]> {
    const mergedPeerList = await mergePeerlist(shard)
    //await updateValidatorStatus("mergedPeerlist", true, false, true)
    // Using the secretary to update the local statuses
    await updateValidatorPhase(4)
    return mergedPeerList
}

/**
 * Forge the block from the ordered transactions
 *
 * @param orderedTransactions - The ordered transactions
 * @param peerlist - The peerlist
 * @returns The forged block
 */
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

/**
 * Vote on the block by broadcasting the block hash to the shard
 *
 * @param block - The block
 * @param shard - The shard members
 * @returns The number of votes for and against the block
 */
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

/**
 * Check if the block is valid using BFT
 *
 * @param pro - The number of votes for the block
 * @param totalVotes - The total number of votes
 * @returns True if the block is valid, false otherwise
 */
function isBlockValid(pro: number, totalVotes: number): boolean {
    const threshold = Math.floor((totalVotes * 2) / 3) + 1
    log.info(`[consensusRoutine] Threshold: ${threshold}`)
    log.info(`[consensusRoutine] Total votes: ${totalVotes}`)
    return pro >= threshold
}

/**
 * Finalize the block. Inserts the block into the chain.
 *
 * @param block - The block
 * @param pro - The number of votes for the block
 */
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

function preventForgingEnded() {
    const manager = SecretaryManager.getInstance()

    if (
        getSharedState.lastBlockNumber === manager.shard.blockRef &&
        manager.ourValidatorPhase.currentPhase < 5 // forged block
    ) {
        throw new ForgingEndedError(
            "We are forging an ended block. Please exit the consensus routine",
        )
    }
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
    preventForgingEnded()

    // INFO: If it's the first phase, the secretary might not have started the consensus routine yet,
    // Increase retry steps to 10 to wait for the secretary to start
    const retries = phase === 1 ? 10 : 3
    const res = await manager.sendOurValidatorPhaseToSecretary(retries)

    preventForgingEnded()
    log.debug(
        `[updateValidatorStatus 🎉] Validator phase ${phase} resolved with value: ${JSON.stringify(
            res,
            null,
            2,
        )}`,
    )

    return res
}

/**
 * Cleanup the consensus state.
 */
function cleanupConsensusState(): void {
    getSharedState.candidateBlock = null
    getSharedState.lastConsensusTime = getSharedState.currentUTCTime // REVIEW Using the current UTC time as the last consensus time
    getSharedState.inConsensusLoop = false
    getSharedState.consensusMode = false

    // INFO: Somehow this is not reset when starting a consensus??
    getSharedState.startingConsensus = false
}

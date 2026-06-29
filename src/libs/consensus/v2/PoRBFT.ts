import Transaction from "src/libs/blockchain/transaction"
import getCommonValidatorSeed from "./routines/getCommonValidatorSeed"
import Mempool from "src/libs/blockchain/mempool"
import Block from "src/libs/blockchain/block"
import Chain from "src/libs/blockchain/chain"
import { getSharedState } from "src/utilities/sharedState"
import { Peer } from "src/libs/peer"
import log from "src/utilities/logger"
import { mergeMempools } from "./routines/mergeMempools"
import { createBlock } from "./routines/createBlock"
import { broadcastBlockHash } from "./routines/broadcastBlockHash"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import SecretaryManager, { AbortConsensusError } from "./types/secretaryManager"
import {
    BlockInvalidError,
    ErrorCode,
    ForgingEndedError,
    NotInShardError,
} from "@/errors"
import HandleGCR, { normalizePubkey } from "src/libs/blockchain/gcr/handleGCR"
import L2PSConsensus from "@/libs/l2ps/L2PSConsensus"
import { DTRManager } from "@/libs/network/dtr/dtrmanager"
import { BroadcastManager } from "@/libs/communications/broadcastManager"
import { fastSync, waitForPeerStatus } from "@/libs/blockchain/routines/Sync"
import GCR from "@/libs/blockchain/gcr/gcr"
import { normalizeAccount } from "@/libs/l2ps/editConservation"
import { MempoolTx } from "@/model/entities/Mempool"
import { isReferenceBlockAllowed } from "@/libs/network/endpointExecution"
import { TRANSACTION_STATUS } from "@/utilities/constants"
import Hashing from "@/libs/crypto/hashing"

export interface FailedTranscation {
    txhash: string
    code: ErrorCode
    message: string
    attrs?: Record<string, any> | null
}

type TxHash = string
const whitelistedCodes = new Set<ErrorCode>([ErrorCode.TX_NONCE_INVALID_HIGH])
type MempoolTransaction = Transaction & { reference_block: number }

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

export const txMap: Map<TxHash, MempoolTransaction> = new Map()

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
    const blockRef = getSharedState.lastBlockNumber + 1
    const manager = SecretaryManager.getInstance(blockRef, true)

    // Defining the variables needed for rolling back the GCREdits
    let exitReason = ""
    const successfulTxs: TxHash[] = []
    const failedTxs: FailedTranscation[] = []

    const blockTxs: MempoolTransaction[] = []
    const blockAttrs: Record<string, any> = {}

    try {
        log.only("[consensusRoutine] Initializing the consensus state")
        await initializeConsensusState()

        const { latestChainBlock, ourLatestBlock } = await fastSync(
            [],
            "consensusRoutine",
        )

        if (latestChainBlock !== ourLatestBlock) {
            log.error(
                "[consensusRoutine] Latest chain block is not equal to our latest block, exiting",
            )
            return
        }
        const peersReady = await waitForPeerStatus()
        if (!peersReady) {
            log.warn(
                "[consensusRoutine] Peers ahead of us, aborting this round",
            )
            return
        }

        log.only("[consensusRoutine] Consensus state initialized")

        // await fastSync([], "consensusRoutine")
        // Initialize the consensus state and check if the local node is in the shard
        // INFO: We won't use the shard returned by initializeShard
        // as it can change through the consensus routine
        // INFO: CONSENSUS ACTION 1: Initialize the shard
        await initializeShard(blockRef)
        preventForgingEnded(blockRef)
        log.only(`Forgin block: ${manager.shard.blockRef}`)
        log.only("[consensusRoutine] We are in the shard, creating the block")
        log.only(
            `[consensusRoutine] shard: ${JSON.stringify(
                manager.shard.members.map(m => m.connection.string),
                null,
                2,
            )}`,
            false,
        )

        // if we have less than shard size of nodes, abort the consensus routine
        if (
            manager.shard.members.length <
            Math.floor((getSharedState.shardSize * 2) / 3) + 1
        ) {
            log.error(
                "[consensusRoutine] Less than shard size of nodes, aborting consensus routine",
            )
            return
        }

        // INFO: Broadcast our validation phase to the secretary
        await updateValidatorPhase(1, blockRef)
        preventForgingEnded(blockRef)
        // synchronize and average the time
        // NOTE: Instead of averaging the time, we'll use the secretary timestamp
        // await synchronizeAndAverageTime(shard)

        // INFO: CONSENSUS ACTION 2: Merge and order the mempools with the mempool lock
        log.only("[consensusRoutine] Merging and ordering the mempools...")
        const initialMempool = await mergeAndOrderMempools(
            manager.shard.members,
            manager.shard.blockRef,
        )

        // filter txs by reference block
        // const res = filterMempoolByRefBlock(initialMempool)
        const resNonce = await filterMempoolByNonce(initialMempool)
        failedTxs.push(...resNonce.failedTxs)

        // Write final mempool used to forge the block
        blockTxs.push(...resNonce.validTxs)

        // Generate map of txs by hash
        for (const tx of blockTxs) {
            txMap.set(tx.hash, tx)
        }

        preventForgingEnded(blockRef)

        log.only(`[consensusRoutine] Our mempool size: ${blockTxs.length}`)
        log.only(
            `[consensusRoutine] Our mempool: ${JSON.stringify(
                blockTxs.map(tx => tx.hash),
                null,
                2,
            )}`,
        )

        // REVIEW Re-merge the mempools anyway to get the correct mempool from the whole shard
        // const mempool = await mergeAndOrderMempools(manager.shard.members)

        // INFO: At this point, we should have the secretary block timestamp
        // if we're connected to the secretary and recieved atleast one successful request from them
        if (manager.blockTimestamp) {
            getSharedState.lastConsensusTime = manager.blockTimestamp
        } else {
            // INFO: This should never happen
            // If it does, request the block timestamp from the secretary
            log.error(
                "[CONSENSUS ROUTINE] Secretary block timestamp not received yet, requesting it ...",
            )
            const blockTimestamp = await manager.getSecretaryBlockTimestamp()
            preventForgingEnded(blockRef)

            if (blockTimestamp) {
                getSharedState.lastConsensusTime = blockTimestamp
            } else {
                log.error(
                    "[CONSENSUS ROUTINE] Block timestamp could not be resolved, exiting the consensus routine",
                )
                exitReason = "blockTimestampNotReceived"
                return
            }
        }

        // INFO: CONSENSUS ACTION 5: Forge the block
        const block = await forgeBlock(blockTxs, []) // NOTE The GCR hash is calculated here and added to the block
        preventForgingEnded(blockRef)
        // REVIEW Set last consensus time to the current block timestamp
        getSharedState.lastConsensusTime = block.content.timestamp

        // INFO: CONSENSUS ACTION 6: Vote on the block
        const [pro, con] = await voteOnBlock(block, manager.shard.members)

        // Check if the block is valid
        if (isBlockValid(pro, manager.shard.members.length)) {
            // Filter out failed txs (from the nonce filter)
            const toApplyTxs = blockTxs.filter(
                tx => tx.status !== TRANSACTION_STATUS.FAILED,
            )

            // Filter out expired txs
            const refRes = filterMempoolByRefBlock(toApplyTxs)
            if (refRes.failedTxs.length > 0) {
                for (const failed of refRes.failedTxs) {
                    const tx = txMap.get(failed.txhash)
                    if (tx) {
                        tx.status = TRANSACTION_STATUS.FAILED
                        tx.attrs = {
                            code: failed.code,
                            message: failed.message,
                            reference_block: tx.reference_block,
                            ...(failed.attrs ?? {}),
                        }
                    }
                }
            }

            // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
            // confirm all transaction past this point are not status failed
            // const uncleanTxs = refRes.validTxs.filter(
            //     tx => tx.status === TRANSACTION_STATUS.FAILED,
            // )
            // if (uncleanTxs.length > 0) {
            //     log.error("Block trying to apply failed transactions")
            //     log.error("Unclean txs: " + JSON.stringify(uncleanTxs, null, 2))
            //     process.exit(1)
            // }

            const applyRes = await applyGCREditsFromMergedMempool(
                refRes.validTxs,
            )

            blockAttrs["gcrAppliedTxCount"] = applyRes.successfulTxs.length
            blockAttrs["gcrAppliedTxsHash"] = Hashing.sha256(
                JSON.stringify(applyRes.successfulTxs),
            )
            blockAttrs["gcrAppliedTxs"] = applyRes.successfulTxs
            block.attrs = blockAttrs

            successfulTxs.push(...applyRes.successfulTxs)
            failedTxs.push(...applyRes.failedTxs)

            if (applyRes.failedTxs.length > 0) {
                log.warn(
                    `[consensusRoutine] Block ${blockRef} contains ${applyRes.failedTxs.length} failed txs`,
                )
                log.error(
                    "Failed txs: " +
                        JSON.stringify(applyRes.failedTxs, null, 2),
                )

                for (const failed of applyRes.failedTxs) {
                    const tx = txMap.get(failed.txhash)
                    if (tx) {
                        tx.status = TRANSACTION_STATUS.FAILED
                        tx.attrs = {
                            code: failed.code,
                            message: failed.message,
                            reference_block: tx.reference_block,
                            ...(failed.attrs ?? {}),
                        }
                    }
                }
            }

            if (successfulTxs.length > 0) {
                log.info(
                    `[consensusRoutine] Successfully Applied ${successfulTxs.length} transactions`,
                )
                for (const successful of successfulTxs) {
                    const tx = txMap.get(successful)
                    if (tx) {
                        tx.status = TRANSACTION_STATUS.CONFIRMED
                        tx.attrs = {
                            reference_block: tx.reference_block,
                        }
                    }
                }
            }

            // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
            // confirm all transactions in the block are either confirmed or failed
            // const states = new Set([
            //     TRANSACTION_STATUS.CONFIRMED,
            //     TRANSACTION_STATUS.FAILED,
            // ])
            // const untouchedTxs = blockTxs.filter(tx => !states.has(tx.status))
            // if (untouchedTxs.length > 0) {
            //     log.error(
            //         "Block contains transactions that are not confirmed or failed",
            //     )
            //     log.error(
            //         "Untouched txs: " + JSON.stringify(untouchedTxs, null, 2),
            //     )
            //     process.exit(1)
            // }

            BroadcastManager.broadcastNewBlock(block)
            DTRManager.releaseDTRWaiter(block)

            // Apply pending L2PS proofs to L1 state
            // L2PS proofs contain GCR edits that modify L1 balances (unified state architecture)
            const l2psStart = Date.now()
            const l2psResult = await L2PSConsensus.applyPendingProofs(
                blockRef,
                false,
            )
            const l2psEnd = Date.now()
            log.only(`[consensusRoutine] L2PS took ${l2psEnd - l2psStart}ms`)

            if (l2psResult.proofsApplied > 0) {
                log.info(
                    `[consensusRoutine] Applied ${l2psResult.proofsApplied} L2PS proofs with ${l2psResult.totalEditsApplied} GCR edits`,
                )
            }
            if (l2psResult.proofsFailed > 0) {
                log.warning(
                    `[consensusRoutine] ${l2psResult.proofsFailed} L2PS proofs failed verification`,
                )
            }
            log.debug(
                "[consensusRoutine] [result] Block is valid with " +
                    pro +
                    " votes",
            )
            const finalizeStart = Date.now()

            // Call finalizeBlock with final block transactions with updated status
            await finalizeBlock(
                block,
                blockTxs.map(tx => txMap.get(tx.hash)),
            )

            // Keep whitelisted failed txs in mempool for the next consensus round
            const failedTxsToRemove = failedTxs
                .filter(tx => !whitelistedCodes.has(tx.code))
                .map(tx => tx.txhash)

            const txsToRemove = new Set([
                ...failedTxsToRemove,
                ...blockTxs.map(tx => tx.hash),
            ])

            // Remove the rest!
            await Mempool.removeTransactionsByHashes(Array.from(txsToRemove))

            const finalizeEnd = Date.now()
            log.only(
                `[consensusRoutine] Finalize took ${finalizeEnd - finalizeStart}ms`,
            )
            log.only("[consensusRoutine] Block finalized")
        } else {
            log.debug("Block is not valid with " + pro + " votes")
            exitReason = "voteError"
            log.error(
                `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
            )

            // Raising an error to rollback the GCREdits
            throw new BlockInvalidError(
                `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
            )
        }
    } catch (error) {
        if (
            error instanceof NotInShardError ||
            error instanceof ForgingEndedError
        ) {
            log.error(error)
            log.error("[consensusRoutine] Exiting consensus routine")
            return
        }

        if (
            error instanceof BlockInvalidError ||
            error instanceof AbortConsensusError
        ) {
            // INFO: If we're past merge mempools phase
            log.warn(
                "[consensusRoutine] Aborted consensus routine at phase: " +
                    manager.ourValidatorPhase.currentPhase,
            )
            if (manager.ourValidatorPhase.currentPhase <= 3) {
                return
            }

            log.warn(
                "[consensusRoutine] Block is invalid. Rolling back the GCREdits",
            )

            // REVIEW Using the successfulTxs to rollback the GCREdits derived from those txs
            // Getting the txs from the hashes
            const txsToRollback: Transaction[] = []

            if (successfulTxs.length > 0) {
                for (const txHash of successfulTxs) {
                    const tx = txMap.get(txHash)
                    if (tx) {
                        txsToRollback.push(tx)
                    }
                }

                await rollbackGCREditsFromTxs(txsToRollback)
            }

            // Also rollback any L2PS proofs that were applied
            await L2PSConsensus.rollbackProofsForBlock(blockRef)
            return
        }

        console.error(error)
        console.error((error as Error).stack)
        log.error(`[CONSENSUS] ${error}`)
        process.exit(1)
    } finally {
        // INFO: If there was a relayed tx past finalize block step, release
        if (DTRManager.poolSize > 0) {
            DTRManager.releaseDTRWaiter()
        }

        cleanupConsensusState()
        manager.endConsensusRoutine()

        log.only("[consensusRoutine] Consensus routine ended")

        // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
        // Confirm all transactions in the block, were inserted in the transaction table
        // const txs = await Chain.getTransactionsFromHashes(
        //     blockTxs.map(tx => tx.hash),
        // )
        // for (const tx of txs) {
        //     if (tx.blockNumber !== blockRef) {
        //         log.error(
        //             "Transaction block number mismatch: " +
        //                 tx.hash +
        //                 ", expected: " +
        //                 blockRef +
        //                 ", got: " +
        //                 tx.blockNumber,
        //         )
        //         process.exit(1)
        //     }
        // }

        // if (
        //     !new Set(["blockTimestampNotReceived", "voteError"]).has(
        //         exitReason,
        //     ) &&
        //     txs.length !== blockTxs.length
        // ) {
        //     const diff = blockTxs.filter(
        //         tx => !txs.some(t => t.hash === tx.hash),
        //     )
        //     log.error(
        //         "Transactions not inserted: " +
        //             JSON.stringify(
        //                 diff.map(tx => tx.hash),
        //                 null,
        //                 2,
        //             ),
        //     )
        //     process.exit(1)
        // }
    }
}

// SECTION: Consensus functions!

/**
 * Safeguard to prevent multiple consensus loops from running
 *
 * @returns True if the consensus loop is already running, false otherwise
 */
export function isConsensusAlreadyRunning(): boolean {
    if (getSharedState.inConsensusLoop) {
        return true
    }

    return false
}

/**
 * Initialize the consensus state
 */
async function initializeConsensusState(): Promise<void> {
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
async function initializeShard(blockRef: number): Promise<Peer[]> {
    const { commonValidatorSeed, lastBlockNumber } =
        await getCommonValidatorSeed()

    const manager = SecretaryManager.getInstance(blockRef)

    if (!manager) {
        throw new ForgingEndedError(
            "Secretary Manager instance for this block has been deleted",
        )
    }

    return await manager.initializeShard(commonValidatorSeed, lastBlockNumber)
}

// SECTION Routines

// /**
//  * Synchronize and average the time between the shard and the local node
//  *
//  * @param shard - The shard members
//  */
// async function synchronizeAndAverageTime(shard: Peer[]): Promise<void> {
//     await fastSync(shard, "synchronizeAndAverageTime")
//     let averageTimestamp = await averageTimestamps(shard)
//     // Strip the decimal part
//     if (!Number.isInteger(averageTimestamp)) {
//         log.warning(
//             "[synchronizeAndAverageTime] Average timestamp is not an integer",
//         )
//         averageTimestamp = Math.round(averageTimestamp)
//     }
//     getSharedState.lastConsensusTime = averageTimestamp
//     // Using the secretary to update the local statuses
//     await updateValidatorPhase(2)
// }

/**
 * Merge and order the mempools between the shard and the local node
 *
 * @param shard - The shard members
 * @returns The ordered transactions
 */
async function mergeAndOrderMempools(
    shard: Peer[],
    blockRef: number,
): Promise<MempoolTransaction[]> {
    // Fetch mempool, check chain for executed txs.
    const preMempool = await Mempool.lock.runExclusive(
        async () => await Mempool.getMempool(blockRef),
    )

    log.only(`[mergeAndOrderMempools] Pre mempool: ${preMempool.length} txs`)
    const preHashes = preMempool.map(tx => tx.hash)
    const preExisting =
        preHashes.length > 0
            ? await Chain.getExistingTransactionHashes(preHashes)
            : new Set<string>()
    const outboundPool = preMempool.filter(tx => !preExisting.has(tx.hash))

    log.debug("[mergeAndOrderMempools] Sending mempool: " + outboundPool.length)
    log.debug(
        "[mergeAndOrderMempools] Sending mempool: " +
            JSON.stringify(
                outboundPool.map(tx => tx.hash),
                null,
                2,
            ),
    )

    // Merge with peers
    await mergeMempools(outboundPool, shard)
    await updateValidatorPhase(3, blockRef)

    const postMempool = await Mempool.getMempool(blockRef)
    log.only(`[mergeAndOrderMempools] Post mempool: ${postMempool.length} txs`)
    const preChecked = new Set(preHashes)
    const newHashes = postMempool
        .map(tx => tx.hash)
        .filter(h => !preChecked.has(h))
    log.only(`[mergeAndOrderMempools] New hashes: ${newHashes.length}`)
    const newlyExisting =
        newHashes.length > 0
            ? await Chain.getExistingTransactionHashes(newHashes)
            : new Set<string>()

    const existingHashes = preExisting.union(newlyExisting)
    log.only(`[mergeAndOrderMempools] Existing hashes: ${existingHashes.size}`)
    const finalMempool = postMempool.filter(tx => !existingHashes.has(tx.hash))
    log.only(
        `[mergeAndOrderMempools] Final mempool: ${finalMempool.length} txs`,
    )

    // INFO: Remove existing txs from mempool
    await Mempool.removeTransactionsByHashes(Array.from(existingHashes))

    // Log transaction type breakdown
    const typeCounts: Record<string, number> = {}
    for (const tx of finalMempool) {
        // INFO: Update tx block number to this consensus' block number
        tx.blockNumber = blockRef

        const txType = tx.content.type ?? "unknown"
        typeCounts[txType] = (typeCounts[txType] || 0) + 1
    }

    log.only(
        `[mergeAndOrderMempools] Final mempool: ${finalMempool.length} txs ` +
            `(removed ${existingHashes.size}: pre-merge ${preExisting.size}, delta ${newlyExisting.size})`,
    )

    for (const [type, count] of Object.entries(typeCounts)) {
        log.only(`[mergeAndOrderMempools]   ${type}: ${count}`)
    }

    return orderDeterministically<MempoolTransaction>(finalMempool)
}

/**
 * Filter mempool transactions by reference block. Removes transactions
 * that will fail because the reference block is out of range.
 *
 * @param mempool - The mempool transactions
 * @returns The valid and failed transactions
 */
function filterMempoolByRefBlock(mempool: MempoolTransaction[]) {
    // map of failed tx hashes and their reason
    const failedTxs: Array<FailedTranscation> = []
    const validTxs: MempoolTransaction[] = []

    for (const tx of mempool) {
        if (
            !isReferenceBlockAllowed(
                tx.reference_block,
                getSharedState.lastBlockNumber,
            )
        ) {
            failedTxs.push({
                txhash: tx.hash,
                code: ErrorCode.TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE,
                message: `Reference block expired. Expected: ${getSharedState.lastBlockNumber - getSharedState.referenceBlockRoom + 1} - ${getSharedState.lastBlockNumber} got ${tx.reference_block}`,
            })
        } else {
            validTxs.push(tx)
        }
    }

    return { validTxs, failedTxs }
}

/**
 * Filter mempool transactions by valid nonce. Removes transactions that will fail
 * because the previous transaction changed the nonce of an account in the next transaction.
 *
 * @param mempool - The sorted mempool transactions
 *
 * @returns The filtered mempool transactions
 *  */
async function filterMempoolByNonce(mempool: MempoolTransaction[]) {
    log.debug("[filterMempoolByValidNonce] Filtering mempool by valid nonce")
    log.debug(
        "[filterMempoolByValidNonce] Initial mempool length: " + mempool.length,
    )
    const validTxs: MempoolTransaction[] = []
    const failedTxs: Array<FailedTranscation> = []
    const nonceAccounts = new Set<string>()

    for (const tx of mempool) {
        for (const edit of tx.content.gcr_edits) {
            if (edit.type === "nonce") {
                nonceAccounts.add(normalizeAccount(edit.account))
            }
        }
    }

    log.debug(
        "[filterMempoolByValidNonce] Found " +
            nonceAccounts.size +
            " Nonce accounts",
    )

    // fetch all nonce counts from the db
    const nonces = await GCR.getAccountNonces(Array.from(nonceAccounts))

    txLoop: for (const tx of mempool) {
        const nonceEdits = tx.content.gcr_edits.filter(e => e.type === "nonce")

        if (nonceEdits.length === 0) {
            validTxs.push(tx)
            continue txLoop
        }

        for (const edit of nonceEdits) {
            const acct = normalizeAccount(edit.account)
            const expected = nonces[acct] + 1

            if (tx.content.nonce === expected) {
                validTxs.push(tx)
                nonces[acct]++
                continue txLoop
            } else if (tx.content.nonce < expected) {
                // Update the transaction status as failed, but include in block
                tx.status = TRANSACTION_STATUS.FAILED
                tx.attrs = {
                    code: ErrorCode.TX_NONCE_INVALID_LOW,
                    message: `Invalid nonce edit. Expected ${expected}, got ${tx.content.nonce}`,
                    reference_block: tx.reference_block,
                }
                validTxs.push(tx)

                log.debug(
                    `[TX_NONCE_INVALID_LOW] including tx as failed: ${tx.hash}: invalid nonce edit`,
                )
                log.debug(
                    "[TX_NONCE_INVALID_LOW] Invalid nonce edit for account: " +
                        acct,
                )
                log.debug(
                    `[TX_NONCE_INVALID_LOW] Expected ${expected}, got ${tx.content.nonce}`,
                )
            } else {
                failedTxs.push({
                    txhash: tx.hash,
                    code: ErrorCode.TX_NONCE_INVALID_HIGH,
                    message: `Invalid nonce edit. Expected ${expected}, got ${tx.content.nonce}`,
                })

                log.debug(`[TX_NONCE_INVALID_HIGH] keeping tx: ${tx.hash}`)
                log.debug(
                    "[TX_NONCE_INVALID_HIGH] Invalid nonce edit for account: " +
                        acct,
                )
                log.debug(
                    `[TX_NONCE_INVALID_HIGH] Expected ${expected}, got ${tx.content.nonce}`,
                )
            }
        }
    }

    log.debug(
        "[filterMempoolByValidNonce] Final mempool length: " + validTxs.length,
    )

    return { validTxs, failedTxs }
}

/**
 * Rollback the GCREdits from a set of txs
 *
 * @param txs - The txs
 * @returns The successful and failed GCREdits
 */
async function rollbackGCREditsFromTxs(txs: Transaction[]) {
    return await HandleGCR.applyTransactions(txs, true)
}

/**
 * Apply the GCREdits from the merged mempool using batched entity processing.
 *
 * This optimized version:
 * 1. Pre-filters already-executed txs in a single batch query
 * 2. Batch loads all affected GCRMain entities
 * 3. Processes edits in-memory without per-edit DB operations
 * 4. Commits all changes in a single batch at the end
 *
 * @param mempool - The mempool
 * @returns The successful and failed GCREdits
 */
async function applyGCREditsFromMergedMempool(
    mempool: MempoolTransaction[],
): Promise<{ successfulTxs: string[]; failedTxs: FailedTranscation[] }> {
    let failedTxs: FailedTranscation[] = []

    if (mempool.length === 0) {
        return { successfulTxs: [], failedTxs: [] }
    }

    // Filter already-executed txs in single batch query
    const allTxHashes = mempool.map(tx => tx.hash)
    const existingTxHashes =
        await Chain.getExistingTransactionHashes(allTxHashes)

    const pendingTxs = mempool.filter(tx => {
        if (existingTxHashes.has(tx.hash)) {
            failedTxs.push({
                txhash: tx.hash,
                code: ErrorCode.TX_EXISTS,
                message: "Transaction already exists",
            })
            return false
        }

        return true
    })

    if (pendingTxs.length === 0) {
        return { successfulTxs: [], failedTxs }
    }

    const res = await HandleGCR.applyTransactions(pendingTxs, false)
    failedTxs = failedTxs.concat(
        res.failedTxs.map(txhash => ({
            txhash: txhash,
            code: ErrorCode.TX_EXECUTE_FAILED,
            message: "Transaction execution failed",
        })),
    )

    // Concat the successful and skipped txs
    const successfulTxsSet = new Set(res.successfulTxs.concat(res.skippedTxs))

    const successfulTxs = []
    for (const tx of pendingTxs) {
        if (successfulTxsSet.has(tx.hash)) {
            successfulTxs.push(tx.hash)
        }
    }

    return { successfulTxs, failedTxs }
}

// /**
//  * Apply the GCR operations to the state
//  *
//  * @param mempool - The mempool
//  * @returns The successful and failed GCR operations
//  */
// async function applyGCRForNewBlock(
//     mempool: Transaction[],
// ): Promise<[string[], string[]]> {
//     const successfulTxs: string[] = []
//     const failedTxs: string[] = []
//     for (const tx of mempool) {
//         const operation = await txToGCROperation(tx)
//         const success = await applyGCROperation(operation)
//         if (success) {
//             successfulTxs.push(tx.hash)
//         } else {
//             failedTxs.push(tx.hash)
//         }
//     }

//     log.info(`[consensusRoutine] Successful GCR operations: ${successfulTxs}`)
//     log.info(`[consensusRoutine] Failed GCR operations: ${failedTxs}`)
//     // await updateValidatorStatus("appliedGCR", true, false, true)
//     // Using the secretary to update the local statuses
//     await updateValidatorPhase(4)
//     return [successfulTxs, failedTxs]
// }

// /**
//  * Merge the peerlist between the shard and the local node
//  *
//  * @param shard - The shard members
//  * @returns The merged peerlist
//  */
// async function mergePeerlistAndWait(shard: Peer[]): Promise<Peer[]> {
//     const mergedPeerList = await mergePeerlist(shard)
//     //await updateValidatorStatus("mergedPeerlist", true, false, true)
//     // Using the secretary to update the local statuses
//     await updateValidatorPhase(4)
//     return mergedPeerList
// }

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
    // await updateValidatorPhase(5, block.number)
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
    const now = Date.now()
    log.only(
        `[consensusRoutine] Broadcasting block hash to the shard: ${block.hash}`,
    )
    const [pro, con] = await broadcastBlockHash(block, shard)
    // await updateValidatorStatus("votedForBlock", true, false, true)
    // Using the secretary to update the local statuses
    await updateValidatorPhase(6, block.number)
    log.only(`[consensusRoutine] Votes:\nPro: ${pro}\nCon: ${con}`)
    const end = Date.now()
    log.only(
        `[consensusRoutine] Time taken: ${(end - now) / 1000}s for voting on the block`,
    )

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
    // vote count threshold
    const threshold = Math.floor((totalVotes * 2) / 3) + 1

    // minimum validators threshold
    // attempts to fix forking bug
    const isMinimumValidators =
        pro >= Math.floor((getSharedState.shardSize * 2) / 3) + 1

    return isMinimumValidators && pro >= threshold
}

/**
 * Finalize the block. Inserts the block into the chain.
 *
 * @param block - The block
 * @param pro - The number of votes for the block
 */
async function finalizeBlock(
    block: Block,
    txs: MempoolTransaction[],
): Promise<void> {
    await Chain.insertBlock(block, txs) // NOTE Transactions are added to the Transactions table here
    log.info("[CONSENSUS] Block added to the chain")
}

function preventForgingEnded(blockRef: number) {
    const manager = SecretaryManager.getInstance(blockRef)

    if (!manager) {
        throw new ForgingEndedError("Secretary manager not found")
    }

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
async function updateValidatorPhase(
    phase: number,
    blockRef: number,
): Promise<any> {
    const manager = SecretaryManager.getInstance(blockRef)

    if (!manager) {
        throw new ForgingEndedError(
            "Secretary Manager instance for this block has been deleted",
        )
    }

    await manager.setOurValidatorPhase(phase, true)
    preventForgingEnded(blockRef)

    // INFO: If it's the first phase, the secretary might not have started the consensus routine yet,
    // Increase retry steps to 10 to wait for the secretary to start
    const retries = phase === 1 ? 5 : 2
    const res = await manager.sendOurValidatorPhaseToSecretary(retries)

    preventForgingEnded(blockRef)
    log.debug(
        `[updateValidatorStatus 🎉] Validator phase ${phase} resolved with value: ${JSON.stringify(
            res,
            null,
            2,
        )}`,
    )

    if (res === ("abortConsensus" as any)) {
        log.error("[consensusRoutine] Abort consensus routine")
        throw new AbortConsensusError("500 error received from secretary")
    }

    return res
}

/**
 * Cleanup the consensus state.
 */
function cleanupConsensusState(): void {
    txMap.clear()
    getSharedState.candidateBlock = null
    getSharedState.lastConsensusTime = getSharedState.currentUTCTime // REVIEW Using the current UTC time as the last consensus time
    getSharedState.inConsensusLoop = false
    getSharedState.consensusMode = false

    // INFO: Somehow this is not reset when starting a consensus??
    getSharedState.startingConsensus = false
}


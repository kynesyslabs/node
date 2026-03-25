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
import { broadcastBlockHash } from "./routines/broadcastBlockHash"
import averageTimestamps from "./routines/averageTimestamp"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"
import applyGCROperation from "src/libs/blockchain/gcr/gcr_routines/applyGCROperation"
import { txToGCROperation } from "src/libs/blockchain/gcr/gcr_routines/txToGCROperation"
import SecretaryManager, { AbortConsensusError } from "./types/secretaryManager"
import {
    BlockInvalidError,
    ForgingEndedError,
    NotInShardError,
} from "src/exceptions"
import HandleGCR from "src/libs/blockchain/gcr/handleGCR"
import L2PSConsensus from "@/libs/l2ps/L2PSConsensus"
import { Waiter } from "@/utilities/waiter"
import { DTRManager } from "@/libs/network/dtr/dtrmanager"
import { BroadcastManager } from "@/libs/communications/broadcastManager"
import Datasource from "src/model/datasource"

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
    const blockRef = getSharedState.lastBlockNumber + 1
    const manager = SecretaryManager.getInstance(blockRef, true)

    // Defining the variables needed for rolling back the GCREdits
    let successfulTxs: string[] = []
    let rollbackEligibleTxs: string[] = []
    let failedTxs: string[] = []
    let tempMempool: Transaction[] = []

    try {
        await initializeConsensusState()

        // await fastSync([], "consensusRoutine")
        // Initialize the consensus state and check if the local node is in the shard
        // INFO: We won't use the shard returned by initializeShard
        // as it can change through the consensus routine
        // INFO: CONSENSUS ACTION 1: Initialize the shard
        await initializeShard(blockRef)
        log.debug(`Forgin block: ${manager.shard.blockRef}`)
        log.debug("[consensusRoutine] We are in the shard, creating the block")
        log.info(
            `[consensusRoutine] shard: ${JSON.stringify(
                manager.shard,
                null,
                2,
            )}`,
            false,
        )

        // INFO: Broadcast our validation phase to the secretary
        await updateValidatorPhase(1, blockRef)

        // synchronize and average the time
        // NOTE: Instead of averaging the time, we'll use the secretary timestamp
        // await synchronizeAndAverageTime(shard)

        // INFO: CONSENSUS ACTION 2: Merge and order the mempools
        tempMempool = await mergeAndOrderMempools(
            manager.shard.members,
            manager.shard.blockRef,
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
        const [localSuccessfulTxs, localFailedTxs, localRollbackEligibleTxs] =
            await applyGCREditsFromMergedMempool(tempMempool)
        successfulTxs = successfulTxs.concat(localSuccessfulTxs)
        rollbackEligibleTxs = rollbackEligibleTxs.concat(
            localRollbackEligibleTxs,
        )
        failedTxs = failedTxs.concat(localFailedTxs)
        log.info(`[consensusRoutine] Successful Txs: ${successfulTxs.length}`)
        log.info(`[consensusRoutine] Failed Txs: ${failedTxs.length}`)
        if (failedTxs.length > 0) {
            log.debug(
                "[consensusRoutine] Failed Txs found, pruning the mempool",
            )
            //  Prune the mempool of the failed txs
            // NOTE The mempool should now be updated with only the successful txs
            for (const tx of failedTxs) {
                log.debug(`Failed tx: ${tx}`)
                await Mempool.removeTransactionsByHashes([tx])
            }
            // Ensure the forged block uses the same tx set as the applied state.
            const failedSet = new Set(failedTxs)
            tempMempool = tempMempool.filter(tx => !failedSet.has(tx.hash))
        }

        // INFO: CONSENSUS ACTION 4b: Apply pending L2PS proofs to L1 state
        // L2PS proofs contain GCR edits that modify L1 balances (unified state architecture)
        const l2psResult = await L2PSConsensus.applyPendingProofs(
            blockRef,
            false,
        )
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

        // REVIEW Re-merge the mempools anyway to get the correct mempool from the whole shard
        // const mempool = await mergeAndOrderMempools(manager.shard.members)

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
            log.debug(
                "[consensusRoutine] [result] Block is valid with " +
                    pro +
                    " votes",
            )
            const finalized = await finalizeBlock(
                block,
                pro,
                tempMempool,
                manager.shard.members,
            )
            if (!finalized) {
                log.warning(
                    "[consensusRoutine] Failed to finalize block locally (missing tx bodies / deterministic apply guard); falling back to fastSync",
                )
                await fastSync(manager.shard.members, "finalizeBlock")
                return
            }

            // REVIEW: Should we await this?
            if (manager.checkIfWeAreSecretary()) {
                BroadcastManager.broadcastNewBlock(block)
            }

            // INFO: Release DTR transaction relay waiter
            await DTRManager.releaseDTRWaiter(block)
        } else {
            log.error(
                `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
            )
            // Raising an error to rollback the GCREdits
            throw new BlockInvalidError(
                `[consensusRoutine] [result] Block is not valid with ${pro} votes`,
            )
        }

        // INFO: CONSENSUS ACTION 7: End the consensus routine
        await updateValidatorPhase(7, blockRef)
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
            log.info(
                "[consensusRoutine] Block is invalid. Rolling back the GCREdits",
            )
            // REVIEW Using the successfulTxs to rollback the GCREdits derived from those txs
            // Getting the txs from the hashes
            const txsToRollback: Transaction[] = []
            for (const txHash of rollbackEligibleTxs) {
                const tx = tempMempool.find(tx => tx.hash === txHash)
                if (tx) {
                    txsToRollback.push(tx)
                }
            }
            await rollbackGCREditsFromTxs(txsToRollback)
            // await Mempool.removeTransactionsByHashes(successfulTxs)

            // Also rollback any L2PS proofs that were applied
            await L2PSConsensus.rollbackProofsForBlock(blockRef)

            return
        }

        log.error(`[CONSENSUS] ${error}`)
        process.exit(1)
    } finally {
        // INFO: If there was a relayed tx past finalize block step, release
        if (DTRManager.poolSize > 0) {
            await DTRManager.releaseDTRWaiter()
        }

        cleanupConsensusState()
        manager.endConsensusRoutine()
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
async function initializeShard(blockRef: number): Promise<Peer[]> {
    const { commonValidatorSeed, lastBlockNumber } =
        await getCommonValidatorSeed()

    const manager = SecretaryManager.getInstance(blockRef)
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
): Promise<(Transaction & { reference_block: number })[]> {
    const ourMempool = await Mempool.getMempool(blockRef)
    log.debug(`[CONSENSUS] Our mempool: ${JSON.stringify(ourMempool)}`)
    log.info("[CONSENSUS] Our mempool has been retrieved")

    await mergeMempools(ourMempool, shard)
    await updateValidatorPhase(3, blockRef)

    const mempool = await Mempool.getMempool(blockRef)
    const hashes = mempool.map(tx => tx.hash)
    const existingHashes = await Chain.getExistingTransactionHashes(hashes)

    // INFO: Remove existing txs from mempool
    await Mempool.removeTransactionsByHashes(Array.from(existingHashes))
    return mempool.filter(tx => !existingHashes.has(tx.hash))
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
    const prevInGcrApply = getSharedState.inGcrApply
    getSharedState.inGcrApply = true
    try {
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
    } finally {
        getSharedState.inGcrApply = prevInGcrApply
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
): Promise<[string[], string[], string[]]> {
    const successfulTxs = new Set<string>()
    const rollbackEligibleTxs = new Set<string>()
    const failedTxs = new Set<string>()

    const prevInGcrApply = getSharedState.inGcrApply
    getSharedState.inGcrApply = true
    try {
        // Apply edits atomically per-tx (align with sync path).
        // IMPORTANT: Never apply per-edit here; if a later edit fails it would leave partial state applied.
        for (const tx of mempool) {
            const txExists = await Chain.checkTxExists(tx.hash)
            if (txExists) {
                failedTxs.add(tx.hash)
                continue
            }

            const txGCREdits = tx.content.gcr_edits
            // Skip transactions that don't have GCR edits (e.g., l2psBatch)
            if (
                !txGCREdits ||
                !Array.isArray(txGCREdits) ||
                txGCREdits.length === 0
            ) {
                successfulTxs.add(tx.hash)
                continue
            }

            // Token edits are NOT currently included in the GCR integrity hash used by consensus.
            // Validate token edits in simulate mode (so invalid token txs are pruned),
            // but defer persistence of token edits until block finalization using the *actual* block tx list.
            const hasTokenEdits = txGCREdits.some((e: any) => e?.type === "token")
            if (hasTokenEdits) {
                const tokenValidation = await HandleGCR.applyTokenEditsToTx(
                    tx,
                    false,
                    true,
                )
                if (!tokenValidation.success) {
                    failedTxs.add(tx.hash)
                    continue
                }
            }

            const nonTokenEdits = txGCREdits.filter(
                (e: any) => e?.type !== "token",
            )
            if (nonTokenEdits.length === 0) {
                successfulTxs.add(tx.hash)
                continue
            }

            const txNonToken = {
                ...tx,
                content: {
                    ...tx.content,
                    gcr_edits: nonTokenEdits,
                },
            } as any as Transaction

            const result = await HandleGCR.applyToTx(txNonToken, false, false)
            if (result.success) {
                successfulTxs.add(tx.hash)
                rollbackEligibleTxs.add(tx.hash)
            } else failedTxs.add(tx.hash)
        }
    } finally {
        getSharedState.inGcrApply = prevInGcrApply
    }

    return [[...successfulTxs], [...failedTxs], [...rollbackEligibleTxs]]
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
    await updateValidatorPhase(5, block.number)
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
    await updateValidatorPhase(6, block.number)

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
async function finalizeBlock(
    block: Block,
    pro: number,
    txs: Transaction[],
    shardMembers: Peer[],
): Promise<boolean> {
    log.info(`[CONSENSUS] Block is valid with ${pro} votes`)
    log.debug(`[CONSENSUS] Block data: ${JSON.stringify(block)}`)

    const prevInGcrApply = getSharedState.inGcrApply
    getSharedState.inGcrApply = true
    try {
        const orderedHashes = Array.isArray(block?.content?.ordered_transactions)
            ? (block.content.ordered_transactions as string[])
            : []
        const byHash = new Map<string, Transaction>()
        for (const tx of txs) byHash.set(tx.hash, tx)

        const missingHashes = orderedHashes.filter(h => !byHash.has(h))
        if (missingHashes.length > 0) {
            log.warning(
                `[CONSENSUS] Missing ${missingHashes.length}/${orderedHashes.length} tx bodies for finalized block ${block.number} (${block.hash}); attempting to fetch from shard`,
            )

            const fetched = await fetchTxsByHashesFromPeers(
                missingHashes,
                shardMembers,
            )
            for (const tx of fetched) byHash.set(tx.hash, tx)
        }

        const stillMissing = orderedHashes.filter(h => !byHash.has(h))
        if (stillMissing.length > 0) {
            log.error(
                `[CONSENSUS] Cannot finalize block ${block.number} (${block.hash}): still missing ${stillMissing.length}/${orderedHashes.length} tx bodies. Refusing to apply token edits and commit local block.`,
            )
            return false
        }

        // Apply token edits deterministically from the finalized block transaction list.
        // This prevents token-table divergence when shard members have incomplete mempools at forge time.
        const orderedTxs = orderedHashes.map(h => byHash.get(h)) as Transaction[]
        const db = await Datasource.getInstance()
        const dataSource = db.getDataSource()

        try {
            await dataSource.transaction(async em => {
                for (const tx of orderedTxs) {
                    // Ensure scripts see stable block height context.
                    if (!tx.blockNumber) tx.blockNumber = block.number
                    const tokenApply = await HandleGCR.applyTokenEditsToTx(
                        tx,
                        false,
                        false,
                        em,
                    )
                    if (!tokenApply.success) {
                        throw new Error(
                            `[CONSENSUS] Token edits failed for tx ${tx.hash}: ${tokenApply.message}`,
                        )
                    }
                }

                await Chain.insertBlock(block, [], undefined, true, true, em) // NOTE Transactions are added to the Transactions table here
            })
        } catch (error) {
            log.error(String(error))
            return false
        }

        if (block.number > getSharedState.lastBlockNumber) {
            getSharedState.lastBlockNumber = block.number
            getSharedState.lastBlockHash = block.hash
        }

        // Ensure the block's ordered transactions are persisted for downstream syncers.
        // insertBlock relies on mempool-backed lookup; if a tx wasn't in local mempool at commit time,
        // peers may not be able to fetch it (and would fail to apply GCR edits during sync).
        if (orderedTxs.length > 0) await Chain.insertTransactionsFromSync(orderedTxs)
    } finally {
        getSharedState.inGcrApply = prevInGcrApply
    }
    //getSharedState.consensusMode = false
    ///getSharedState.inConsensusLoop = false
    log.info("[CONSENSUS] Block added to the chain")
    const lastBlock = await Chain.getLastBlock()
    log.debug(`[CONSENSUS] Last block: ${JSON.stringify(lastBlock)}`)
    return true
}

async function fetchTxsByHashesFromPeers(
    hashes: string[],
    peers: Peer[],
): Promise<Transaction[]> {
    const remaining = new Set(hashes)
    const results: Transaction[] = []

    const batchSize =
        typeof getSharedState.batchSyncTxLimit === "number" &&
        getSharedState.batchSyncTxLimit > 0
            ? getSharedState.batchSyncTxLimit
            : 250

    const chunks: string[][] = []
    const asArray = [...remaining]
    for (let i = 0; i < asArray.length; i += batchSize) {
        chunks.push(asArray.slice(i, i + batchSize))
    }

    for (const peer of peers) {
        if (remaining.size === 0) break

        for (const chunk of chunks) {
            const need = chunk.filter(h => remaining.has(h))
            if (need.length === 0) continue

            try {
                const req = {
                    method: "nodeCall",
                    params: [
                        {
                            message: "getTxsByHashes",
                            data: { hashes: need },
                            muid: null,
                        },
                    ],
                }

                const res: any = await peer.longCall(req as any, true, {
                    protocol: "http",
                    sleepTime: 250,
                    retries: 3,
                })

                if (res?.result !== 200 || !Array.isArray(res?.response)) {
                    continue
                }

                for (const candidate of res.response as Transaction[]) {
                    const claimedHash =
                        typeof candidate?.hash === "string"
                            ? candidate.hash
                            : null
                    if (!claimedHash || !remaining.has(claimedHash)) {
                        continue
                    }

                    const tx = Object.assign(new Transaction(), candidate)
                    const rehashed = Transaction.hash(tx)
                    if (!rehashed || tx.hash !== claimedHash) {
                        log.warning(
                            `[CONSENSUS] Dropping peer tx with mismatched hash for requested tx ${claimedHash}`,
                        )
                        continue
                    }

                    const validation = await Transaction.confirmTx(tx, "")
                    if (!validation?.success) {
                        log.warning(
                            `[CONSENSUS] Dropping peer tx ${claimedHash}: signature/integrity validation failed`,
                        )
                        continue
                    }

                    remaining.delete(claimedHash)
                    results.push(tx)
                }
            } catch {
                // best-effort; keep trying other peers
            }
        }
    }

    return results
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
    const retries = phase === 1 ? 10 : 3
    const res = await manager.sendOurValidatorPhaseToSecretary(retries)

    preventForgingEnded(blockRef)
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

/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Conflict handling between peers (longest chain)
import { Mutex } from "async-mutex"
import { getSharedState } from "src/utilities/sharedState"
import { isForkActive } from "@/forks"
import Peer from "../../peer/Peer"
import PeerManager from "../../peer/PeerManager"
import Block from "../block"
import Chain from "../chain"
import log from "src/utilities/logger"
import { verifyBlock } from "../validation/verifyBlock"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import {
    BlockNotFoundError,
    PeerUnreachableError,
    TimeoutError,
    handleError,
} from "@/errors"
import HandleGCR from "../gcr/handleGCR"
import {
    discoverL2PSParticipants,
    syncL2PSWithPeer,
    exchangeL2PSParticipation,
} from "@/libs/l2ps/L2PSConcurrentSync"
import { BroadcastManager } from "@/libs/communications/broadcastManager"
import { Waiter } from "@/utilities/waiter"
import Mempool from "../mempool"
import { getLastBlockSigners } from "../chainBlocks"
import { TRANSACTION_STATUS } from "@/utilities/constants"
import { orderDeterministically } from "@/libs/consensus/v2/routines/deterministicOrder"
import Hashing from "@/libs/crypto/hashing"

/**
 * Used to prevent block insert operations from happening concurrently.
 *
 * 1. Via fastSync routine
 * 2. Via the new block broadcast routine
 */
export const syncLock = new Mutex()

const peerManager = PeerManager.getInstance()
async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

const latestBlock = () =>
    peerManager
        .getAll()
        .reduce((max, peer) => Math.max(max, peer.sync.block), 0)

const highestBlockPeer = () =>
    peerManager.getAll().find(peer => peer.sync.block === latestBlock())

const FAST_SYNC_TIMEOUT_MS = 30_000

/**
 * @deprecated
 * Get the highest block number and peer from the network. If we're synced
 * we return null for the peer.
 *
 * @param peers - If specified, we only get the data from these peers.
 */
async function getHigestBlockPeerData(peers: Peer[] = []) {
    // Getting all the peers if not specified
    if (peers.length === 0) {
        peers = peerManager.getPeers()
    }

    if (latestBlock() === getSharedState.lastBlockNumber) {
        return {}
    }

    // Getting our data
    log.debug("[fastSync] Getting our last block number and hash")
    const lastBlock = await Chain.getLastBlock()
    const ourLastBlockNumber = lastBlock.number
    const ourLastBlockHash = lastBlock.hash

    log.info(
        `[fastSync] Our last block number is ${ourLastBlockNumber} and our last block hash is ${ourLastBlockHash}`,
    )

    // REVIEW: With the peer gossip working, can we replace getLastBlockNumber
    // calls with checks on the peerlist?
    // HOW ACCURATE WILL THAT BE? How much accuracy is needed?

    // SECTION: Reading block number from the peerlist
    const blockNumbers = peers.reduce((acc, peer) => {
        acc.push({
            peer: peer.identity,
            block: peer.sync.block,
        })
        return acc
    }, [])

    log.custom(
        "fastsync_blocknumbers",
        "Peerlist block numbers: " + JSON.stringify(blockNumbers),
    )

    // SECTION: Asking the peers for the last block number
    // Asking the peers for the last block number
    const peerLastBlockNumbers = []
    const promises = new Map<string, Promise<RPCResponse>>()
    for (const peer of peers) {
        const call: RPCRequest = {
            method: "nodeCall",
            params: [
                {
                    message: "getLastBlockNumber",
                    data: null,
                    muid: null,
                },
            ],
        }
        promises.set(peer.identity, peer.call(call, false))
    }

    // REVIEW: Phase 3c-3 - Discover L2PS participants concurrently with block discovery
    // Run L2PS discovery in background (non-blocking, doesn't await)
    if (getSharedState.l2psJoinedUids?.length > 0) {
        discoverL2PSParticipants(peers, getSharedState.l2psJoinedUids)
            .then(participantMap => {
                let totalParticipants = 0
                for (const participants of participantMap.values()) {
                    totalParticipants += participants.length
                }
                log.debug(
                    `[Sync] Discovered L2PS participants: ${participantMap.size} networks, ${totalParticipants} total peers`,
                )
            })
            .catch(error => {
                log.error(
                    "[Sync] L2PS participant discovery failed:",
                    error.message,
                )
            })
    }

    // Wait for all the promises to resolve (synchronously?)
    const responses = new Map<string, RPCResponse>()
    for (const [peerId, promise] of promises) {
        const response = await promise
        responses.set(peerId, response)
    }

    const requestBlockNumbers = []

    for (const response of responses) {
        if (response[1].result === 200) {
            peerLastBlockNumbers.push(response[1].response as number)
            log.info(
                "[fastSync] Peer " +
                    response[0] +
                    " has last block number: " +
                    response[1].response,
            )
            // INFO: Log request block number for insights!
            requestBlockNumbers.push({
                peer: response[0],
                block: response[1].response,
            })
        } else {
            peerLastBlockNumbers.push(0)
        }
    }
    log.info(`[fastSync] Peer last block numbers: ${peerLastBlockNumbers}`)
    log.custom(
        "fastsync_blocknumbers",
        "Request block numbers: " + JSON.stringify(requestBlockNumbers),
    )

    // REVIEW Choose the peer with the highest last block number
    const highestBlockNumber: number = peerLastBlockNumbers.reduce(
        (max, peer) => Math.max(max, peer),
        0,
    )

    // If we have the same block number as the highest block number peer, we are already synced
    if (highestBlockNumber === ourLastBlockNumber) {
        log.info("[fastSync] We are already synced")
        // getSharedState.syncStatus = true

        return {
            highestBlockNumber,
            highestBlockNumberPeer: null,
            ourLastBlockNumber,
            ourLastBlockHash,
        }
    }

    // Otherwise, we need to sync
    const highestBlockNumberPeerIndex = peerLastBlockNumbers.findIndex(
        peer => peer === highestBlockNumber,
    )
    const highestBlockNumberPeer = peers[highestBlockNumberPeerIndex]
    log.info(
        "[fastSync] Peer with highest last block number: " +
            highestBlockNumberPeer.identity +
            " with block number: " +
            highestBlockNumber,
    )

    return {
        highestBlockNumber,
        highestBlockNumberPeer,
        ourLastBlockNumber,
        ourLastBlockHash,
    }
}

/**
 * Get a block from a peer
 *
 * @param peer - The peer to get the block from
 * @param blockNumber - The block number to get
 *
 * @returns The block if found, null otherwise
 */
async function getRemoteBlock(peer: Peer, blockNumber: number) {
    const blockRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockByNumber",
                data: { blockNumber: blockNumber.toString() },
            },
        ],
    }

    const blockResponse = await peer.longCall(blockRequest, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    if (blockResponse.result === 200) {
        return blockResponse.response as Block
    }

    return null
}

/**
 * Verify if our last block is coherent with the same block from the peer.
 *
 * @param peer - The peer to cross-check with
 * @param ourLastBlockNumber - Our last block number
 * @param ourLastBlockHash - Our last block hash
 * @returns True if the last block hash is coherent, false otherwise
 */
async function verifyLastBlockIntegrity(
    peer: Peer,
    ourLastBlockNumber: number,
    ourLastBlockHash: string,
): Promise<boolean> {
    const ourGenesisHash = await Chain.getGenesisBlockHash()
    const seenPeers = new Set<string>()
    let currentPeer: Peer | null = peer

    while (currentPeer) {
        seenPeers.add(currentPeer.identity)

        // INFO: Verify genesis hash matches our genesis hash
        const genesisBlock = await getRemoteBlock(currentPeer, 0)

        if (!genesisBlock) {
            log.error(
                `[fastSync] Could not get genesis block from peer ${currentPeer.identity}, trying next peer`,
            )
            currentPeer = findNextAvailablePeer(seenPeers)
            continue
        }

        if (genesisBlock.hash !== ourGenesisHash) {
            log.error(
                `[fastSync] Genesis hash mismatch with peer ${currentPeer.identity}: ours=${ourGenesisHash} peer=${genesisBlock.hash}, trying next peer`,
            )
            currentPeer = findNextAvailablePeer(seenPeers)
            continue
        }

        // Verify if the last block hash is coherent
        const lastSyncedBlock = await getRemoteBlock(
            currentPeer,
            ourLastBlockNumber,
        )

        if (!lastSyncedBlock) {
            log.error(
                `[fastSync] Could not get last block from peer ${currentPeer.identity}, trying next peer`,
            )
            currentPeer = findNextAvailablePeer(seenPeers)
            continue
        }

        return lastSyncedBlock.hash === ourLastBlockHash
    }

    log.error(
        "[fastSync] Exhausted all peers, could not verify last block integrity",
    )
    return false
}

async function verifyBlockAttrs(block: Block, txs: Transaction[]) {
    // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):

    if (txs.length < block.content.ordered_transactions.length) {
        log.error(
            "[fastSync] No transactions received for block: " + block.hash,
        )
        log.debug("Trying to get transaction from signers")

        const masterSet = new Set(block.content.ordered_transactions)
        const missingTxs = masterSet.difference(new Set(txs.map(tx => tx.hash)))

        // get signers for block
        const signers = Object.keys(block.validation_data?.signatures || {})
        for (const signer of signers) {
            const peer = peerManager.getPeer(signer)

            if (!peer) continue

            const res = await askTxsForBlock(block, peer)

            for (const tx of res) {
                if (missingTxs.has(tx.hash)) {
                    txs.push(tx)
                    missingTxs.delete(tx.hash)
                }
            }

            if (missingTxs.size === 0) break
        }

        if (missingTxs.size > 0) {
            log.error(
                `[fastSync] Still missing ${missingTxs.size} transactions even after asking from signers`,
            )
            log.error(
                "Missing transactions: " +
                    JSON.stringify(Array.from(missingTxs), null, 2),
            )
            process.exit(1)
        }
    }

    for (const tx of txs) {
        if (tx.blockNumber !== block.number) {
            log.error(
                "Transaction block number mismatch: " +
                    tx.hash +
                    ", expected: " +
                    block.number +
                    ", got: " +
                    tx.blockNumber,
            )
            process.exit(1)
        }
    }

    const sorted = orderDeterministically(txs)

    // confirm sorted txs are in the same order as block ordered transactions
    const inputHash = Hashing.sha256(
        JSON.stringify(block.content.ordered_transactions),
    )
    const sortedHash = Hashing.sha256(JSON.stringify(sorted.map(tx => tx.hash)))
    if (inputHash !== sortedHash) {
        log.error(
            "Deterministic order does not match block ordered transactions",
        )
        log.error(
            "Block ordered transactions: " +
                JSON.stringify(block.content.ordered_transactions, null, 2),
        )
        log.error(
            "Sorted transactions: " +
                JSON.stringify(
                    sorted.map(tx => tx.hash),
                    null,
                    2,
                ),
        )
        process.exit(1)
    }

    const applied = sorted.filter(
        tx => tx.status === TRANSACTION_STATUS.CONFIRMED,
    )
    if (block.attrs["gcrAppliedTxCount"] !== applied.length) {
        log.error(
            "[fastSync] Block attrs gcrAppliedTxCount mismatch: " +
                applied.length +
                ", expected: " +
                block.attrs["gcrAppliedTxCount"],
        )

        if (block.attrs["gcrAppliedTxCount"] > applied.length) {
            // find the missing txs in the original txs list and log them
            const appliedTxSet = new Set(block.attrs["gcrAppliedTxs"])
            const confirmedAppliedTxSet = new Set(applied.map(tx => tx.hash))

            const diff = appliedTxSet.difference(confirmedAppliedTxSet)

            for (const tx of diff) {
                const resolved = sorted.find(t => t.hash === tx)
                if (resolved) {
                    log.error(
                        "[fastSync] Applied by forger, but not US: " +
                            resolved.hash,
                    )
                    log.error(
                        "[fastSync] Transaction full: " +
                            JSON.stringify(resolved, null, 2),
                    )
                } else {
                    log.error(
                        "[fastSync] Missing tx from original txs list: " + tx,
                    )
                }
            }
            process.exit(1)
        }

        process.exit(1)
    }

    if (
        block.attrs["gcrAppliedTxsHash"] !==
        Hashing.sha256(JSON.stringify(applied.map(tx => tx.hash)))
    ) {
        log.error(
            "[fastSync] Block attrs gcrAppliedTxsHash mismatch: " +
                block.attrs["gcrAppliedTxsHash"] +
                ", expected: " +
                Hashing.sha256(JSON.stringify(applied.map(tx => tx.hash))),
        )
        log.error(
            "Resolved applied txs: " +
                JSON.stringify(
                    applied.map(tx => tx.hash),
                    null,
                    2,
                ),
        )
        log.error(
            "Fetched Applied txs: " +
                JSON.stringify(block.attrs["gcrAppliedTxs"], null, 2),
        )
        log.error("Full applied txs: " + JSON.stringify(applied, null, 2))
        // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
        process.exit(1)
    }

    return applied
}

/**
 * Given a block and a peer, saves the block into the database, downloads the transactions
 * from the peer and updates the GCR and transaction tables.
 *
 * @param block The block to sync
 * @param peer The peer that sent the block
 * @returns True if the block was synced successfully, false otherwise
 */
export async function syncBlock(block: Block, peer: Peer) {
    const exists = await Chain.getBlockByNumber(block.number)
    if (exists) {
        log.debug("Block already exists, skipping ...")
        return true
    }

    if (isForkActive("nonceEnforcement", getSharedState.lastBlockNumber ?? 0)) {
        const verdict = await verifyBlock(block as never)
        if (!verdict.valid) {
            log.error(
                `[syncBlock] Rejecting synced block ${block.number} (${block.hash}): ${verdict.reason}`,
            )
            return false
        }
        log.info(
            `[syncBlock] Block ${block.number} passed signature-quorum verification`,
        )
    }

    await Chain.insertBlock(block, [])
    log.debug("Block inserted successfully")
    log.debug(
        `Last block number: ${getSharedState.lastBlockNumber} Last block hash: ${getSharedState.lastBlockHash}`,
    )
    log.info("[fastSync] Block inserted successfully at the head of the chain!")

    // REVIEW Merge the peerlist
    log.info(`[fastSync] Merging peers from block: ${block.hash}`)
    const mergedPeerlist = await mergePeerlist(block)
    log.info(`[fastSync] Merged peers from block: ${mergedPeerlist}`)
    // REVIEW Parse the txs hashes in the block
    log.info("[fastSync] Asking for transactions in the block", true)
    const txs = await askTxsForBlock(block, peer)
    log.info(`[fastSync] Transactions received: ${txs.length}`, true)

    const applied = await verifyBlockAttrs(block, txs)

    // ! Sync the native tables
    await syncGCRTables(applied)

    // REVIEW Insert the txs into the transactions database table
    if (txs.length > 0) {
        log.info("[fastSync] Inserting transactions into the database", true)
        const success = await Chain.insertTransactionsFromSync(txs)
        if (success) {
            log.info("[fastSync] Transactions inserted successfully")

            // NODE_CRITICAL_DEBUG (DO NOT REMOVE COMMENTED OUT CODE):
            // confirm all txs are inserted
            for (const tx of txs) {
                const res = await Chain.checkTxExists(tx.hash)
                if (!res) {
                    log.error(
                        "[syncGCRTables] Transaction not found: " + tx.hash,
                    )
                    process.exit(1)
                }
            }
            log.debug("[syncGCRTables] All transactions are inserted")
            return true
        }

        log.error("[fastSync] Transactions insertion failed")
        return false
    }

    log.info("[fastSync] No transactions in the block")
    return true
}

// /**
//  *
//  * @param peer The peer to download the block from
//  * @param blockToAsk The block number to download
//  * @returns The block if downloaded successfully, false otherwise
//  */
// async function downloadBlock(peer: Peer, blockToAsk: number) {
//     const blockRequest: RPCRequest = {
//         method: "nodeCall",
//         params: [
//             {
//                 message: "getBlockByNumber",
//                 data: { blockNumber: blockToAsk.toString() },
//                 muid: null,
//             },
//         ],
//     }

//     const blockResponse = await peer.longCall(blockRequest, true, {
//         protocol: "http",
//         sleepTime: 1000,
//         retries: 3,
//     })
//     log.debug("Block response: " + blockResponse.result)

//     // INFO: Handle max retries reached
//     if (blockResponse.result === 400) {
//         log.info("[fastSync] Peer is offline")
//         // TODO: Test this!
//         throw new PeerUnreachableError("Peer is offline")
//     }

//     if (blockResponse.result === 404) {
//         log.error("[fastSync] Block not found")
//         log.error("BLOCK TO ASK: " + blockToAsk)
//         log.error("PEER: " + peer.connection.string)

//         throw new BlockNotFoundError("Block not found")
//     }

//     if (blockResponse.result === 200) {
//         log.debug(
//             `[SYNC] downloadBlock - Block response received for block: ${blockToAsk}`,
//         )
//         const block = blockResponse.response as Block

//         if (!block) {
//             log.error("[downloadBlock] Block not received")
//             return false
//         }

//         return await syncBlock(block, peer)
//     }

//     return false
// }

// Helper function to ask for transactions in batches
export async function askTxsForBlocksBatch(
    blocks: Block[],
    peer: Peer,
): Promise<Record<string, Transaction>> {
    // Extract all unique transaction hashes from all blocks
    const allTxHashes = blocks.flatMap(
        block => block.content.ordered_transactions,
    )

    // Remove duplicates
    const uniqueTxHashes = [...new Set(allTxHashes)]

    // Fetch transactions in batches
    const batchSize = getSharedState.batchSyncTxSize
    const txMap = {}

    for (let i = 0; i < uniqueTxHashes.length; i += batchSize) {
        const batch = uniqueTxHashes.slice(i, i + batchSize)

        const txRequest: RPCRequest = {
            method: "nodeCall",
            params: [
                {
                    message: "getTxsByHashes",
                    data: { hashes: batch },
                    muid: null,
                },
            ],
        }

        const txResponse = await peer.call(txRequest, false)

        if (txResponse.result === 200) {
            const transactions = txResponse.response as Transaction[]
            // Build hash -> transaction map
            transactions.forEach(tx => {
                txMap[tx.hash] = tx
            })
        } else {
            log.error(
                "[askTxsForBlocksBatch] Failed to fetch batch of transactions",
            )
        }
    }

    return txMap
}

/**
 * Download and process a batch of blocks from a peer
 *
 * @param peer - The peer to download blocks from
 * @param startBlock - The first block number to download
 * @param endBlock - The last block number to download (inclusive)
 * @returns True if all blocks were downloaded and processed successfully
 */
async function batchDownloadBlocks(
    peer: Peer,
    startBlock: number,
    endBlock: number,
): Promise<boolean> {
    const batchSize = getSharedState.batchSyncBlockSize
    const totalBlocks = endBlock - startBlock + 1
    const limit = Math.min(totalBlocks, batchSize)

    log.debug(
        `[batchDownloadBlocks] Fetching ${limit} blocks from ${startBlock} to ${
            startBlock + limit - 1
        }`,
    )

    // Fetch batch of blocks
    const blocksRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlocks",
                data: { start: startBlock + limit - 1, limit },
                muid: null,
            },
        ],
    }

    const blocksResponse = await peer.longCall(blocksRequest, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    // Handle errors
    if (blocksResponse.result === 400) {
        log.error("[batchDownloadBlocks] Peer is offline")
        throw new PeerUnreachableError("Peer is offline")
    }

    if (blocksResponse.result === 404) {
        log.error("[batchDownloadBlocks] Blocks not found")
        throw new BlockNotFoundError("Blocks not found")
    }

    if (blocksResponse.result !== 200) {
        log.error(
            `[batchDownloadBlocks] Unexpected response: ${blocksResponse.result}`,
        )
        return false
    }

    const blocks = blocksResponse.response as Block[]
    if (!blocks || blocks.length === 0) {
        log.error("[batchDownloadBlocks] No blocks received")
        return false
    }

    // Fetch all transactions for all blocks in batch
    const txMap = await askTxsForBlocksBatch(blocks, peer)
    log.info(
        `[batchDownloadBlocks] Fetched ${
            Object.keys(txMap).length
        } unique transactions`,
    )

    // Process each block in order. Order matters for the height-stable
    // verify: each block's validator set (valid_at <= number-1) is already
    // persisted by the time the next block is checked.
    for (const block of blocks.sort((a, b) => a.number - b.number)) {
        const blockTxs = block.content.ordered_transactions
            .map(txHash => txMap[txHash])
            .filter(tx => !!tx)

        // AUDIT C2-deep — verify hash + signature quorum on EACH historical
        // block before insert (height-stable signer set). Fork-gated on
        // nonceEnforcement so pre-fork batch sync is byte-identical.
        if (
            isForkActive(
                "nonceEnforcement",
                getSharedState.lastBlockNumber ?? 0,
            )
        ) {
            const verdict = await verifyBlock(block as never)
            if (!verdict.valid) {
                log.error(
                    `[batchDownloadBlocks] Rejecting block ${block.number} (${block.hash}): ${verdict.reason}`,
                )
                return false
            }
        }

        // Insert block
        await Chain.insertBlock(block, [])
        log.info(
            `[batchDownloadBlocks] Block ${block.number} inserted successfully`,
        )

        // Merge peerlist
        await mergePeerlist(block)
        const applied = await verifyBlockAttrs(block, blockTxs)

        // Sync GCR tables
        await syncGCRTables(applied)

        // Insert transactions
        if (blockTxs.length > 0) {
            const success = await Chain.insertTransactionsFromSync(blockTxs)
            if (!success) {
                log.error(
                    `[batchDownloadBlocks] Failed to insert transactions for block ${block.number}`,
                )
                return false
            }
        }
    }

    log.debug(
        `[batchDownloadBlocks] Successfully processed batch of ${blocks.length} blocks`,
    )
    return true
}

/**
 * Wait for the next block to be generated and download it
 *
 * @param peer - The peer to wait for the next block
 * @returns True if the block was downloaded successfully, false otherwise
 */
async function waitForNextBlock() {
    try {
        log.debug(
            "[waitForNextBlock] Waiting for next block 🥳🥳🥳🥳🥳🥳🥳🥳🥳",
        )
        const [newBlock, peer] = await Waiter.wait(
            Waiter.keys.SYNC_WAIT_FOR_BLOCK,
            120_000,
        )
        log.debug("[waitForNextBlock] Block received: " + newBlock.number)

        return await syncBlock(newBlock as Block, peer)
    } catch (error) {
        if (error instanceof TimeoutError) {
            log.error("[waitForNextBlock] Timeout waiting for next block")
            return false
        }

        handleError(error, "SYNC")
        return false
    }
}

/**
 * Trigger L2PS mempool sync with peer in background (non-blocking)
 */
function triggerL2PSSync(peer: Peer): void {
    if (!getSharedState.l2psJoinedUids?.length || !peer) {
        return
    }

    for (const l2psUid of getSharedState.l2psJoinedUids) {
        syncL2PSWithPeer(peer, l2psUid)
            .then(() => {
                log.debug(`[Sync] L2PS mempool synced: ${l2psUid}`)
            })
            .catch(error => {
                log.error(
                    `[Sync] L2PS sync failed for ${l2psUid}:`,
                    error.message,
                )
            })
    }
}

/**
 * Find the next available peer with highest block, excluding seen peers
 */
function findNextAvailablePeer(seenPeers: Set<string>): Peer | null {
    const highestBlockPeers = peerManager
        .getAll()
        .filter(p => p.sync.block === latestBlock())
        .filter(p => !seenPeers.has(p.identity))

    log.info(
        "[fastSync] Highest block peers: " +
            JSON.stringify(
                highestBlockPeers.map(p => p.connection.string),
                null,
                2,
            ),
    )

    if (highestBlockPeers.length === 0) {
        return null
    }

    log.info(
        "[fastSync] Switched to peer: " +
            highestBlockPeers[0].connection.string,
    )
    return highestBlockPeers[0]
}

/**
 * Request the blocks from the peer
 *
 * @returns True if the blocks were synced successfully, false otherwise
 */
async function requestBlocks(): Promise<boolean> {
    const seenPeers = new Set<string>()
    let peer = highestBlockPeer()

    while (getSharedState.lastBlockNumber < latestBlock()) {
        // if (latestBlock() === SecretaryManager.lastBlockRef) {
        //     log.debug("Attempting to sync consensus block, returning ...")
        //     return true
        // }

        log.debug("[requestBlocks] Requesting blocks ... 🔄🔄🔄🔄🔄🔄🔄🔄🔄")
        const startBlock = getSharedState.lastBlockNumber + 1
        const endBlock = latestBlock()
        const blocksToSync = endBlock - startBlock + 1

        log.debug(
            `[requestBlocks] Need to sync ${blocksToSync} blocks (${startBlock} to ${endBlock})`,
        )

        try {
            // Download batch of blocks
            await batchDownloadBlocks(peer, startBlock, endBlock)
            await BroadcastManager.broadcastOurSyncData()

            // Trigger L2PS sync
            triggerL2PSSync(peer)

            log.debug(
                `[requestBlocks] Batch sync completed. Current block: ${getSharedState.lastBlockNumber}`,
            )
        } catch (error) {
            handleError(error, "SYNC", { source: "block download" })
            // Handle chain head reached
            if (error instanceof BlockNotFoundError) {
                log.info(
                    "[requestBlocks] Reached end of available blocks on peer",
                )
                break
            }

            // Handle peer unreachable - switch to next peer
            if (error instanceof PeerUnreachableError) {
                log.debug(
                    `[requestBlocks] Peer ${peer.identity} is unreachable. Switching to next peer.`,
                )
                seenPeers.add(peer.identity)

                // Find alternative peers with highest block
                const highestBlockPeers = peerManager
                    .getAll()
                    .filter(p => p.sync.block === latestBlock())
                    .filter(p => !seenPeers.has(p.identity))

                log.info(
                    `[requestBlocks] Available highest block peers: ${highestBlockPeers.length}`,
                )

                if (highestBlockPeers.length === 0) {
                    log.error("[requestBlocks] No more peers available to sync")
                    return false
                }

                peer = highestBlockPeers[0]
                log.info(
                    `[requestBlocks] Switched to peer: ${peer.connection.string}`,
                )

                // Retry the current batch with new peer
                continue
            }

            // Unknown error - log and break
            log.error(
                `[requestBlocks] Unexpected error during batch sync: ${
                    error instanceof Error ? error.message : "Unknown error"
                }`,
            )
            return false
        }
    }

    log.info("[requestBlocks] Block sync completed successfully")
    return latestBlock() === getSharedState.lastBlockNumber
}

// REVIEW Applying GCREdits to the tables
export async function syncGCRTables(txs: Transaction[]) {
    // apply only transaction with confirmed status
    const confirmedTxs = txs.filter(
        tx => tx.status === TRANSACTION_STATUS.CONFIRMED,
    )

    // sort transactions deterministic
    const sortedTxs = orderDeterministically(confirmedTxs)
    await HandleGCR.applyTransactions(sortedTxs, false)
}

// Helper function to ask for the transactions in a block
export async function askTxsForBlock(
    block: Block,
    peer: Peer,
): Promise<Transaction[]> {
    if (
        Array.isArray(block.content.ordered_transactions) &&
        block.content.ordered_transactions.length === 0
    ) {
        return []
    }

    let request: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockTransactions",
                data: { blockHash: block.hash },
            },
        ],
    }

    let res = await peer.longCall(request, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    if (
        res.result === 200 &&
        Array.isArray(res.response) &&
        res.response.length > 0
    ) {
        return res.response as Transaction[]
    }

    // INFO: fetch all transactions by hashes
    request = {
        method: "nodeCall",
        params: [
            {
                message: "getTxsByHashes",
                data: { hashes: block.content.ordered_transactions },
            },
        ],
    }

    res = await peer.longCall(request, true, {
        protocol: "http",
        sleepTime: 1000,
        retries: 3,
    })

    if (res.result === 200) {
        return res.response as Transaction[]
    }

    log.error("[askTxsForBlock] Failed to fetch transactions")
    return []
}

// Helper function to merge the peerlist from the last block
export async function mergePeerlist(block: Block): Promise<string[]> {
    const blockPeerlist = block.content.peerlist
    const ourPeerlist = PeerManager.getInstance().getPeers()
    const mergedPeers: string[] = []

    const ourPeerIdentities = new Set(ourPeerlist.map(peer => peer.identity))

    for (const peer of blockPeerlist) {
        const peerObject = Peer.fromIPeer(peer)

        if (ourPeerIdentities.has(peerObject.identity)) {
            continue
        }

        const success = peerManager.addPeer(peerObject)
        if (success) {
            mergedPeers.push(peerObject.identity)
        }
    }

    // REVIEW: Phase 3c-3 - Exchange L2PS participation with newly discovered peers
    // Inform new peers about our L2PS networks (non-blocking)
    if (mergedPeers.length > 0 && getSharedState.l2psJoinedUids?.length > 0) {
        const newPeerObjects = mergedPeers
            .map(identity => peerManager.getPeer(identity))
            .filter((peer): peer is Peer => peer !== undefined)

        if (newPeerObjects.length > 0) {
            // Run in background, don't block blockchain sync
            exchangeL2PSParticipation(newPeerObjects).catch(error => {
                log.error(
                    "[Sync] L2PS participation exchange failed:",
                    error.message,
                )
            })
            log.debug(
                `[Sync] Exchanging L2PS participation with ${newPeerObjects.length} new peers`,
            )
        }
    }

    return mergedPeers
}

async function fastSyncRoutine(peers: Peer[] = []) {
    if (latestBlock() === getSharedState.lastBlockNumber) {
        log.debug("[fastSync] We're already synced!")
        return true
    }

    if (getSharedState.fastSyncCount === 0) {
        // INFO: Only run integrity checks on first sync
        const verified = await verifyLastBlockIntegrity(
            highestBlockPeer(),
            getSharedState.lastBlockNumber,
            getSharedState.lastBlockHash,
        )

        if (!verified) {
            log.error("[fastSync] Last block is not coherent")
            throw new Error(
                "[fastSync] Last block integrity check failed — node refusing to sync against incoherent chain",
            )
        }
    }

    while (!(await requestBlocks())) {
        if (getSharedState.isShuttingDown || getSharedState.fastSyncAborted)
            return false
        log.debug(
            "[fastSync] Request blocks failed, retrying ... ⛔️⛔️⛔️⛔️⛔️⛔️⛔️⛔️",
        )
        await sleep(500)
    }

    if (getSharedState.fastSyncCount === 0) {
        await Mempool.cleanMempool()

        // await waitForNextBlock()
        // while (!(await waitForNextBlock())) {
        //     if (getSharedState.isShuttingDown || getSharedState.fastSyncAborted)
        //         return false
        //     log.debug(
        //         "[fastSync] Failed to wait for next block, retrying ... ⛔️⛔️⛔️⛔️⛔️⛔️⛔️⛔️",
        //     )
        // }

        log.debug("[fastSync] Wait for next block complete! 🥳🥳🥳🥳🥳🥳🥳🥳🥳")
    }

    return latestBlock() === getSharedState.lastBlockNumber
}

export async function fastSync(
    peers: Peer[] = [],
    from: string,
): Promise<{ latestChainBlock: number; ourLatestBlock: number }> {
    if (getSharedState.inSyncLoop) {
        log.debug("[fastSync] Sync loop already running, skipping")

        return {
            latestChainBlock: latestBlock(),
            ourLatestBlock: getSharedState.lastBlockNumber,
        }
    }

    log.debug("[fastSync] Starting sync loop")
    try {
        getSharedState.inSyncLoop = true
        getSharedState.fastSyncAborted = false

        // if our difference is greater than 2 blocks, set our sync status to false and broadcast
        if (getSharedState.syncStatus) {
            const networkHighest = latestBlock()
            const ourHighest = getSharedState.lastBlockNumber
            const difference = networkHighest - ourHighest

            if (difference >= 2) {
                getSharedState.syncStatus = false
                await BroadcastManager.broadcastOurSyncData()
                log.debug(
                    "[fastSync] Network highest block is more than 2 blocks ahead of our highest block, setting sync status to false and broadcasting",
                )
            }
        }

        let synced: boolean
        if (getSharedState.fastSyncCount > 0) {
            const result = await Promise.race([
                syncLock
                    .runExclusive(async () => fastSyncRoutine(peers))
                    .then(v => ({
                        kind: "done" as const,
                        value: v,
                    })),
                sleep(FAST_SYNC_TIMEOUT_MS).then(() => ({
                    kind: "timeout" as const,
                    value: false,
                })),
            ])

            if (result.kind === "timeout") {
                getSharedState.fastSyncAborted = true
                log.warn("[fastSync] Timed out after 30s, aborting")
                return {
                    latestChainBlock: latestBlock(),
                    ourLatestBlock: getSharedState.lastBlockNumber,
                }
            }

            synced = result.value
        } else {
            synced = await fastSyncRoutine(peers)
        }

        log.debug("[fastSync] Fast sync routine ended ⚪️⚪️⚪️⚪️⚪️⚪️⚪️⚪️⚪️")
        log.debug("[fastSync] Sync status: " + synced)
        getSharedState.syncStatus = synced
        BroadcastManager.broadcastOurSyncData()

        log.debug("[fastSync] Broadcasted our sync data 📤📤📤📤📤📤📤📤📤")
        const lastBlockNumber = await Chain.getLastBlockNumber()
        log.debug(
            "[fastSync] DB Last block number after sync: " +
                lastBlockNumber +
                " from: " +
                from,
        )

        return {
            latestChainBlock: lastBlockNumber,
            ourLatestBlock: getSharedState.lastBlockNumber,
        }
    } finally {
        getSharedState.fastSyncAborted = false
        getSharedState.inSyncLoop = false
        log.debug("[fastSync] Sync loop ended")
    }
}

/**
 * Block the consensus until peers reach the same block as us.
 *
 * @param lastBlockSignersOnly - If true, only wait for peers that signed the last block.
 *                               If false, wait for online peers that are level or 1 block behind.
 * @returns False if any peer is ahead of us (caller should abort the round); true otherwise.
 */
export async function waitForPeerStatus(
    lastBlockSignersOnly = true,
): Promise<boolean> {
    const POLL_MS = 100
    const TIMEOUT_MS = 30_000

    const ourBlock = getSharedState.lastBlockNumber
    const ourHash = getSharedState.lastBlockHash
    const selfId = getSharedState.publicKeyHex

    let signerIds: Set<string> | null = null

    if (lastBlockSignersOnly) {
        const signers = await getLastBlockSigners()
        const others = signers.filter(id => id !== selfId)
        if (others.length === 0) {
            log.debug("[waitForPeerStatus] No prior signers, skipping")
            return true
        }
        signerIds = new Set(others)
        log.only(
            "[waitForPeerStatus] Last block signers: " +
                JSON.stringify(Array.from(signerIds), null, 2),
        )
    }

    const start = Date.now()
    while (Date.now() - start < TIMEOUT_MS) {
        const onlinePeers = peerManager.getPeers()

        // Abort if any peer is ahead — we're stale and shouldn't drive consensus
        const ahead = onlinePeers.filter(
            p => p.status.online && p.sync.status && p.sync.block > ourBlock,
        )
        if (ahead.length > 0) {
            log.error(
                `[waitForPeerStatus] ${ahead.length} peer(s) ahead at block ${ourBlock}, aborting`,
            )
            return false
        }

        const waitFor = signerIds
            ? onlinePeers.filter(
                  p =>
                      signerIds.has(p.identity) &&
                      // only wait for peers that are upto 2 blocks behind us
                      getSharedState.lastBlockNumber - p.sync.block <= 2,
              )
            : onlinePeers.filter(p => p.sync.block >= ourBlock - 2)

        if (waitFor.length === 0) {
            log.only("[waitForPeerStatus] No target peers to wait for")
            return true
        }

        const isAligned = (p: Peer) =>
            p.sync.block === ourBlock && p.sync.block_hash === ourHash

        if (waitFor.every(isAligned)) {
            log.only(
                `[waitForPeerStatus] ${waitFor.length} peer(s) aligned at block ${ourBlock}, after ${Date.now() - start}ms`,
            )
            return true
        }

        const lagging = waitFor.filter(p => !isAligned(p)).length
        log.only(
            `[waitForPeerStatus] Waiting on ${lagging}/${waitFor.length} at block ${ourBlock}`,
        )
        log.only("😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒😒")
        await sleep(POLL_MS)
    }

    log.only(
        `[waitForPeerStatus] Timeout after ${TIMEOUT_MS}ms, proceeding best-effort 🙊`,
    )
    return true
}

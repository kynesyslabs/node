/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Conflict handling between peers (longest chain)

import { getSharedState } from "src/utilities/sharedState"
import terminalkit from "terminal-kit"
import Peer from "../../peer/Peer"
import PeerManager from "../../peer/PeerManager"
import Block from "../block"
import Chain from "../chain"
import log from "src/utilities/logger"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import { BlockNotFoundError, PeerUnreachableError } from "src/exceptions"
import GCR from "../gcr/gcr"
import HandleGCR from "../gcr/handleGCR"

const term = terminalkit.terminal

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

/**
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
        "[fastSync] Our last block number is " +
            ourLastBlockNumber +
            " and our last block hash is " +
            ourLastBlockHash,
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
        "Peerlist block numbers: " + JSON.stringify(blockNumbers, null, 2),
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
    log.info("[fastSync] Peer last block numbers: " + peerLastBlockNumbers)
    log.custom(
        "fastsync_blocknumbers",
        "Request block numbers: " +
            JSON.stringify(requestBlockNumbers, null, 2),
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

    const blockResponse = await peer.longCall(blockRequest, false, 250, 3)

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
) {
    // INFO: Verify genesis hash matches our genesis hash
    const genesisBlock = await getRemoteBlock(peer, 0)

    if (!genesisBlock) {
        log.error("[fastSync] Could not get genesis block from peer")
        process.exit(1)
    }

    const ourGenesisHash = await Chain.getGenesisBlockHash()

    if (genesisBlock.hash !== ourGenesisHash) {
        log.error("[fastSync] Genesis hash is not coherent")
        log.info("[fastSync] Our hash: " + ourGenesisHash)
        log.info("[fastSync] Peer hash: " + genesisBlock.hash)
        process.exit(1)
    }

    // Verify if the last block hash is coherent
    const lastSyncedBlock = await getRemoteBlock(peer, ourLastBlockNumber)

    if (!lastSyncedBlock) {
        log.error("[fastSync] Could not get last block from peer")
        process.exit(1)
    }

    return lastSyncedBlock.hash === ourLastBlockHash
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

    log.info(
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
                data: { start: startBlock + limit, limit },
                muid: null,
            },
        ],
    }

    const blocksResponse = await peer.longCall(blocksRequest, false, 250, 3, [
        404,
    ])

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
    log.debug(
        "[batchDownloadBlocks] Blocks: " +
            JSON.stringify(
                blocks.map(block => block.number),
                null,
                2,
            ),
    )

    if (!blocks || blocks.length === 0) {
        log.error("[batchDownloadBlocks] No blocks received")
        return false
    }

    log.info(`[batchDownloadBlocks] Received ${blocks.length} blocks`)

    // Fetch all transactions for all blocks in batch
    log.info("[batchDownloadBlocks] Fetching transactions for batch")
    const txMap = await askTxsForBlocksBatch(blocks, peer)
    log.info(
        `[batchDownloadBlocks] Fetched ${
            Object.keys(txMap).length
        } unique transactions`,
    )

    // Process each block in order
    for (const block of blocks.sort((a, b) => a.number - b.number)) {
        log.debug(`[batchDownloadBlocks] Processing block ${block.number}`)
        const blockTxs = block.content.ordered_transactions
            .map(txHash => txMap[txHash])
            .filter(tx => !!tx)

        // Insert block
        await Chain.insertBlock(block, [], null, false)
        log.debug(
            `[batchDownloadBlocks] Block ${block.number} inserted successfully`,
        )

        // Merge peerlist
        const mergedPeerlist = await mergePeerlist(block)
        log.debug(
            `[batchDownloadBlocks] Merged ${mergedPeerlist.length} peers from block ${block.number}`,
        )

        log.debug(
            `[batchDownloadBlocks] Processing ${blockTxs.length} transactions for block ${block.number}`,
        )

        // Sync GCR tables
        await syncGCRTables(blockTxs)

        // Insert transactions
        if (blockTxs.length > 0) {
            const success = await Chain.insertTransactions(blockTxs)
            if (!success) {
                log.error(
                    `[batchDownloadBlocks] Failed to insert transactions for block ${block.number}`,
                )
                return false
            }
        }
    }

    log.info(
        `[batchDownloadBlocks] Successfully processed batch of ${blocks.length} blocks`,
    )
    return true
}

/**
 * Wait for the next block to be generated and download it
 *
 * @returns True if the block was downloaded successfully, false otherwise
 */
async function waitForNextBlock(): Promise<boolean> {
    log.debug("[waitForNextBlock] Waiting for next block")

    while (getSharedState.lastBlockNumber >= latestBlock()) {
        await sleep(250)
    }

    const nextBlock = getSharedState.lastBlockNumber + 1
    log.debug(
        `[waitForNextBlock] NEXT BLOCK GENERATED. DOWNLOADING block ${nextBlock}...`,
    )

    try {
        return await batchDownloadBlocks(
            highestBlockPeer(),
            nextBlock,
            nextBlock,
        )
    } catch (error) {
        log.error(
            `[waitForNextBlock] Failed to download next block: ${
                error instanceof Error ? error.message : "Unknown error"
            }`,
        )
        return false
    }
}

/**
 * Request blocks from peers using batch download strategy
 *
 * @returns True if the blocks were synced successfully, false otherwise
 */
async function requestBlocks(): Promise<boolean> {
    const seenPeers = new Set<string>()
    let peer = highestBlockPeer()

    while (getSharedState.lastBlockNumber < latestBlock()) {
        const startBlock = getSharedState.lastBlockNumber + 1
        const endBlock = latestBlock()
        const blocksToSync = endBlock - startBlock + 1

        log.info(
            `[requestBlocks] Need to sync ${blocksToSync} blocks (${startBlock} to ${endBlock})`,
        )

        try {
            // Download batch of blocks
            await batchDownloadBlocks(peer, startBlock, endBlock)
            log.info(
                `[requestBlocks] Batch sync completed. Current block: ${getSharedState.lastBlockNumber}`,
            )
        } catch (error) {
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
    return true
}

// REVIEW Applying GCREdits to the tables
export async function syncGCRTables(
    txs: Transaction[],
): Promise<[string, boolean]> {
    // ? Better typing on this return
    // Using the GCREdits in the tx to sync the native tables
    for (const tx of txs) {
        const result = await HandleGCR.applyToTx(tx)
        if (!result.success) {
            log.error(
                "[fastSync] GCR edit application failed at tx: " + tx.hash,
            )
            return [tx.hash, false]
        }
    }
    return [null, true]
}

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

    return mergedPeers
}

async function fastSyncRoutine(peers: Peer[] = []) {
    if (latestBlock() === getSharedState.lastBlockNumber) {
        log.debug("[fastSync] We're already synced!")
        return true
    }

    if (getSharedState.fastSyncCount == 0) {
        // INFO: Only run integrity checks on first sync
        const verified = await verifyLastBlockIntegrity(
            highestBlockPeer(),
            getSharedState.lastBlockNumber,
            getSharedState.lastBlockHash,
        )

        if (!verified) {
            log.error("[fastSync] Last block is not coherent")
            process.exit(1)
        }
    }

    const synced = await requestBlocks()

    if (synced && getSharedState.fastSyncCount === 0) {
        await waitForNextBlock()
    }

    return synced
}

export async function fastSync(
    peers: Peer[] = [],
    from: string,
): Promise<boolean> {
    const synced = await fastSyncRoutine(peers)
    getSharedState.syncStatus = synced

    const lastBlockNumber = await Chain.getLastBlockNumber()
    log.info(
        "[fastSync] DB Last block number after sync: " +
            lastBlockNumber +
            " from: " +
            from,
    )
    return true
}

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
    // Verify if the last block hash is coherent
    const lastSyncedBlockRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockByNumber",
                data: { blockNumber: ourLastBlockNumber.toString() },
                muid: null,
            },
        ],
    }
    const lastSyncedBlockResponse = await peer.call(
        lastSyncedBlockRequest,
        false,
    )

    if (lastSyncedBlockResponse.result === 200) {
        console.log("[fastSync] Last synced block response received")
        const lastSyncedBlock = lastSyncedBlockResponse.response as Block
        if (lastSyncedBlock.hash !== ourLastBlockHash) {
            log.info("[fastSync] Hash is not coherent")
            log.info("[fastSync] Our hash: " + ourLastBlockHash)
            log.info("[fastSync] Peer hash: " + lastSyncedBlock.hash)
            return false
            // TODO: Pass to the next peer
        }

        console.log(
            "[fastSync] Hash is coherent: we can sync with: " + peer.identity,
        )
    }

    return true
}

async function downloadBlock(peer: Peer, blockToAsk: number) {
    const blockRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockByNumber",
                data: { blockNumber: blockToAsk.toString() },
                muid: null,
            },
        ],
    }

    const blockResponse = await peer.longCall(blockRequest, false, 250, 3, [
        404,
    ])

    // INFO: Handle max retries reached
    if (blockResponse.result === 400) {
        log.info("[fastSync] Peer is offline")
        // TODO: Test this!
        throw new PeerUnreachableError("Peer is offline")
    }

    if (blockResponse.result === 404) {
        log.info("[fastSync] Block not found")
        throw new BlockNotFoundError("Block not found")
    }

    if (blockResponse.result === 200) {
        console.log(
            "[fastSync] Block response received for block: " + blockToAsk,
        )
        const block = blockResponse.response as Block

        if (!block) {
            log.error("[downloadBlock] Block not received")
            return false
        }

        log.info("[downloadBlock] Block received: " + block.hash)
        await Chain.insertBlock(block, [], null, false)
        log.info(
            "[fastSync] Block inserted successfully at the head of the chain!",
        )

        // REVIEW Merge the peerlist
        log.info("[fastSync] Merging peers from block: " + block.hash)
        const mergedPeerlist = await mergePeerlist(block)
        log.info("[fastSync] Merged peers from block: " + mergedPeerlist)
        // REVIEW Parse the txs hashes in the block
        log.info("[fastSync] Asking for transactions in the block", true)
        const txs = await askTxsForBlock(block, peer)
        log.info("[fastSync] Transactions received: " + txs.length, true)

        // ! Sync the native tables
        await syncGCRTables(txs)

        // REVIEW Insert the txs into the transactions database table
        if (txs.length > 0) {
            log.info(
                "[fastSync] Inserting transactions into the database",
                true,
            )
            const success = await Chain.insertTransactions(txs)
            if (success) {
                log.info("[fastSync] Transactions inserted successfully")
                return true
            }

            log.error("[fastSync] Transactions insertion failed")
            return false
        }

        log.info("[fastSync] No transactions in the block")
        return true

        // ? We might want a rollback function here if something goes wrong
    }

    return false
}

/**
 * Wait for the next block to be generated and download it
 *
 * @param peer - The peer to wait for the next block
 * @returns True if the block was downloaded successfully, false otherwise
 */
async function waitForNextBlock() {
    log.debug("[waitForNextBlock] Waiting for next block")

    while (getSharedState.lastBlockNumber >= latestBlock()) {
        await sleep(250)
    }

    log.debug("[waitForNextBlock] NEXT BLOCK GENERATED. DOWNLOADING...")
    return await downloadBlock(
        highestBlockPeer(),
        getSharedState.lastBlockNumber + 1,
    )
}

/**
 * Request the blocks from the peer
 *
 * @param peer - The peer to request the blocks from
 * @returns True if the blocks were requested successfully, false otherwise
 */
async function requestBlocks() {
    // REVIEW: lowest or highest?
    // Sync the blocks one by one starting from the lowest block number that we do not have
    // ? Way more error handling needed
    // console.error(
    //     "[fastSync] Syncing blocks from peer: " + JSON.stringify(peer),
    // )

    // if (!peerManager.getPeer(peer.identity)) {
    //     log.error("[fastSync] Peer not found")
    //     return false
    // }
    const seenPeers = new Set<string>()
    let peer = highestBlockPeer()

    while (getSharedState.lastBlockNumber <= latestBlock()) {
        const blockToAsk = getSharedState.lastBlockNumber + 1
        // log.debug("[fastSync] Sleeping for 1 second")
        // await sleep(250)
        try {
            await downloadBlock(peer, blockToAsk)
        } catch (error) {
            // INFO: Handle chain head reached
            if (error instanceof BlockNotFoundError) {
                log.info("[fastSync] Block not found")
                break
            }

            if (error instanceof PeerUnreachableError) {
                log.debug(
                    "[fastSync] Peer " +
                        peer.identity +
                        " is unreachable. Switching to the next peer.",
                )
                seenPeers.add(peer.identity)

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
                    log.error("[fastSync] No more peers to try")
                    return false
                }

                log.info(
                    "[fastSync] Switched to peer: " +
                        highestBlockPeers[0].connection.string,
                )
                peer = highestBlockPeers[0]
            }
        }
    }

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

// Helper function to ask for the transactions in a block
export async function askTxsForBlock(
    block: Block,
    peer: Peer,
): Promise<Transaction[]> {
    const txsHashes = block.content.ordered_transactions
    const txs = []
    for (const txHash of txsHashes) {
        const txRequest: RPCRequest = {
            method: "nodeCall",
            params: [
                {
                    message: "getTxByHash",
                    data: { hash: txHash },
                    muid: null,
                },
            ],
        }
        const txResponse = await peer.call(txRequest, false)
        if (txResponse.result === 200) {
            const tx = txResponse.response as Transaction
            txs.push(tx)
        }
    }
    return txs
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

    // INFO: Check if block match across peers
    // INFO: Disabled for testing!
    // TODO: Fix verification of the last block with the same peer
    // const verified = await verifyLastBlockIntegrity(
    //     highestBlockPeer(),
    //     getSharedState.lastBlockNumber,
    //     getSharedState.lastBlockHash,
    // )

    // if (!verified) {
    //     log.error("[fastSync] Last block is not coherent")
    //     process.exit(0)
    // }

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

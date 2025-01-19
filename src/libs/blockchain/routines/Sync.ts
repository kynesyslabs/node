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
import { BlockNotFoundError, PeerOfflineError } from "src/exceptions"

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
    let peerLastBlockNumbers = []
    let promises = new Map<string, Promise<RPCResponse>>()
    for (let peer of peers) {
        let call: RPCRequest = {
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
    let responses = new Map<string, RPCResponse>()
    for (let [peerId, promise] of promises) {
        let response = await promise
        responses.set(peerId, response)
    }

    const requestBlockNumbers = []

    for (let response of responses) {
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
    let highestBlockNumber: number = peerLastBlockNumbers.reduce(
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
    let highestBlockNumberPeerIndex = peerLastBlockNumbers.findIndex(
        peer => peer === highestBlockNumber,
    )
    let highestBlockNumberPeer = peers[highestBlockNumberPeerIndex]
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
    let lastSyncedBlockRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockByNumber",
                data: { blockNumber: ourLastBlockNumber.toString() },
                muid: null,
            },
        ],
    }
    let lastSyncedBlockResponse = await peer.call(lastSyncedBlockRequest, false)

    if (lastSyncedBlockResponse.result === 200) {
        console.log("[fastSync] Last synced block response received")
        let lastSyncedBlock = lastSyncedBlockResponse.response as Block
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
    let blockRequest: RPCRequest = {
        method: "nodeCall",
        params: [
            {
                message: "getBlockByNumber",
                data: { blockNumber: blockToAsk.toString() },
                muid: null,
            },
        ],
    }
    let blockResponse = await peer.longCall(blockRequest, false, 250, 3, [404])

    // INFO: Handle max retries reached
    if (blockResponse.result === 400) {
        log.info("[fastSync] Peer is offline")
        // TODO: Test this!
        throw new PeerOfflineError("Peer is offline")
    }

    if (blockResponse.result === 404) {
        log.info("[fastSync] Block not found")
        throw new BlockNotFoundError("Block not found")
    }

    if (blockResponse.result === 200) {
        console.log(
            "[fastSync] Block response received for block: " + blockToAsk,
        )
        let block = blockResponse.response as Block

        if (!block) {
            log.error("[downloadBlock] Block not received")
            return false
        }

        await Chain.insertBlock(block, [], null, false)
        console.log(
            "[fastSync] Block inserted successfully at the head of the chain!",
        )

        // REVIEW Merge the peerlist
        log.info("[fastSync] Merging peers from block: " + block.hash)
        let mergedPeerlist = await mergePeerlist(block)
        log.info("[fastSync] Merged peers from block: " + mergedPeerlist)
        // REVIEW Parse the txs hashes in the block
        log.info("[fastSync] Asking for transactions in the block", true)
        let txs = await askTxsForBlock(block, peer)
        log.info("[fastSync] Transactions received: " + txs.length, true)

        // ! Sync the native tables
        await syncNativeTables()

        // REVIEW Insert the txs into the transactions database table
        if (txs.length > 0) {
            log.info(
                "[fastSync] Inserting transactions into the database",
                true,
            )
            let success = await Chain.insertTransactions(txs)
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

    while (getSharedState.lastBlockNumber <= latestBlock()) {
        const blockToAsk = getSharedState.lastBlockNumber + 1
        // log.debug("[fastSync] Sleeping for 1 second")
        // await sleep(250)

        log.debug("[fastSync] Asking peer for block: " + blockToAsk)
        try {
            await downloadBlock(highestBlockPeer(), blockToAsk)
        } catch (error) {
            // INFO: Handle chain head reached
            if (error instanceof BlockNotFoundError) {
                log.info("[fastSync] Block not found")
                break
            }

            if (error instanceof PeerOfflineError) {
                log.info("[fastSync] Peer is offline")
                // TODO: Switch to the next peer
                return false
            }
        }
    }

    return true
}

// TODO Implement this
export async function syncNativeTables() {
    // TODO Call the endpoint to sync the native tables (manageNodeCall.ts has them)
    // TODO Add the results to the database in the native tables
}

// Helper function to ask for the transactions in a block
export async function askTxsForBlock(
    block: Block,
    peer: Peer,
): Promise<Transaction[]> {
    let txsHashes = block.content.ordered_transactions
    let txs = []
    for (let txHash of txsHashes) {
        let txRequest: RPCRequest = {
            method: "nodeCall",
            params: [
                {
                    message: "getTxByHash",
                    data: { hash: txHash },
                    muid: null,
                },
            ],
        }
        let txResponse = await peer.call(txRequest, false)
        if (txResponse.result === 200) {
            let tx = txResponse.response as Transaction
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
    const {
        highestBlockNumber,
        highestBlockNumberPeer,
        ourLastBlockNumber,
        ourLastBlockHash,
    } = await getHigestBlockPeerData(peers)

    if (highestBlockNumberPeer === null) {
        log.debug("[fastSync] We're already synced!")
        return true
    }

    // INFO: Check if block match across peers
    const verified = await verifyLastBlockIntegrity(
        highestBlockNumberPeer,
        ourLastBlockNumber,
        ourLastBlockHash,
    )

    if (!verified) {
        log.error("[fastSync] Last block is not coherent")
        getSharedState.syncStatus = false
        return false
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

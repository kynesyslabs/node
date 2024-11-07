/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Conflict handling between peers (longest chain)

import { demostdlib } from "src/libs/utils"
import { getSharedState } from "src/utilities/sharedState"
import terminalkit from "terminal-kit"
import Peer from "../../peer/Peer"
import PeerManager from "../../peer/PeerManager"
import Block from "../block"
import Chain from "../chain"
import { NodeCall } from "src/libs/network/manageNodeCall"
import log from "src/utilities/logger"
import {
    RPCRequest,
    RPCResponse,
    Transaction,
} from "@kynesyslabs/demosdk/types"

const term = terminalkit.terminal

const peerManager = PeerManager.getInstance()
async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

// ? Modularize this function
export async function fastSync(peers: Peer[] = []): Promise<boolean> {
    // Getting all the peers if not specified
    if (peers.length === 0) {
        peers = peerManager.getPeers()
    }
    // Getting our data
    let ourLastBlockNumber = await Chain.getLastBlockNumber()
    let ourLastBlockHash = await Chain.getLastBlockHash()
    log.info(
        "[fastSync] Our last block number is " +
            ourLastBlockNumber +
            " and our last block hash is " +
            ourLastBlockHash,
    )
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
    for (let response of responses) {
        if (response[1].result === 200) {
            peerLastBlockNumbers.push(response[1].response as number)
            log.info(
                "[fastSync] Peer " +
                    response[0] +
                    " has last block number: " +
                    response[1].response,
            )
        }
    }
    log.info("[fastSync] Peer last block numbers: " + peerLastBlockNumbers)
    // REVIEW Choose the peer with the highest last block number
    let highestBlockNumber = peerLastBlockNumbers.reduce(
        (max, peer) => Math.max(max, peer),
        0,
    )

    // If we have the same block number as the highest block number peer, we are already synced
    if (highestBlockNumber === ourLastBlockNumber) {
        log.info("[fastSync] We are already synced with the peer")
        getSharedState.syncStatus = true
        return true
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
    let lastSyncedBlockResponse = await highestBlockNumberPeer.call(
        lastSyncedBlockRequest,
        false,
    )
    if (lastSyncedBlockResponse.result === 200) {
        console.log("[fastSync] Last synced block response received")
        let lastSyncedBlock = lastSyncedBlockResponse.response as Block
        if (lastSyncedBlock.hash !== ourLastBlockHash) {
            log.info("[fastSync] Hash is not coherent")
            log.info("[fastSync] Our hash: " + ourLastBlockHash)
            log.info("[fastSync] Peer hash: " + lastSyncedBlock.hash)
            getSharedState.syncStatus = false
            return false // ! Pass to the next peer
        }
        console.log(
            "[fastSync] Hash is coherent: we can sync with: " +
                highestBlockNumberPeer.identity,
        )
    }
    // REVIEW: lowest or highest?
    // Sync the blocks one by one starting from the lowest block number that we do not have
    // ? Way more error handling needed
    let blockToAsk = ourLastBlockNumber + 1
    while (blockToAsk <= highestBlockNumber) {
        console.log("[fastSync] Asking peer for block: " + blockToAsk)
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
        let blockResponse = await highestBlockNumberPeer.call(
            blockRequest,
            false,
        )

        if (blockResponse.result === 200) {
            console.log(
                "[fastSync] Block response received for block: " + blockToAsk,
            )
            let block = blockResponse.response as Block
            Chain.insertBlock(block, [], null, false)
            // REVIEW Merge the peerlist
            log.info("[fastSync] Merging peers from block: " + block.hash)
            let mergedPeerlist = await mergePeerlist(block)
            log.info("[fastSync] Merged peers from block: " + mergedPeerlist)   
            // REVIEW Parse the txs hashes in the block
            log.info("[fastSync] Asking for transactions in the block", true)
            let txs = await askTxsForBlock(block, highestBlockNumberPeer)
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
                } else {
                    log.error("[fastSync] Transactions insertion failed")
                }
            }

            // ? We might want a rollback function here if something goes wrong

            console.log(
                "[fastSync] Block inserted successfully at the head of the chain!",
            )
        }
        blockToAsk++
    }
    getSharedState.syncStatus = true
    return true
}

export async function syncNativeTables() {
    // ! Implement this
    // TODO Call the endpoint to sync the native tables
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

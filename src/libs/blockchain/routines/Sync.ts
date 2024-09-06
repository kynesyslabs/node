/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Conflict handling between peers (longest chain)

import { demostdlib } from "src/libs/utils"
import sharedState from "src/utilities/sharedState"
import terminalkit from "terminal-kit"
import Peer from "../../peer/Peer"
import PeerManager from "../../peer/PeerManager"
import Block from "../block"
import Chain from "../chain"
import { NodeCall } from "src/libs/network/manageNodeCall"
import log from "src/utilities/logger"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk-http/types"

const term = terminalkit.terminal

const peerManager = PeerManager.getInstance()
async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

export interface IPeerLastInfo {
    peerLastBlockNumber: number
    peerLastBlockHash: string
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
    log.info("[fastSync] Our last block number is " + ourLastBlockNumber + " and our last block hash is " + ourLastBlockHash)
    // Asking the peers for the last block number
    let peerLastBlockNumbers = []
    let promises = new Map<string, Promise<RPCResponse>>()
    for (let peer of peers) {
        let call: RPCRequest = {
            method: "nodeCall",
            params: [{
                message: "getLastBlockNumber",
                data: null,
                muid: null,
            }],
        }
        promises.set(peer.identity.toString("hex"), peer.call(call, false))
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
            log.info("[fastSync] Peer " + response[0] + " has last block number: " + response[1].response)
        }
    }
    log.info("[fastSync] Peer last block numbers: " + peerLastBlockNumbers)
    // REVIEW Choose the peer with the highest last block number
    let highestBlockNumber = peerLastBlockNumbers.reduce((max, peer) => Math.max(max, peer), 0)
    
    // If we have the same block number as the highest block number peer, we are already synced
    if (highestBlockNumber === ourLastBlockNumber) {
        log.info("[fastSync] We are already synced with the peer")
        sharedState.getInstance().syncStatus = true
        return true
    }
    // Otherwise, we need to sync
    let highestBlockNumberPeerIndex = peerLastBlockNumbers.findIndex((peer) => peer === highestBlockNumber)
    let highestBlockNumberPeer = peers[highestBlockNumberPeerIndex]
    log.info("[fastSync] Peer with highest last block number: " + highestBlockNumberPeer.identity.toString("hex") + " with block number: " + highestBlockNumber)
    // Verify if the last block hash is coherent
    let lastSyncedBlockRequest: RPCRequest = {
        method: "nodeCall",
        params: [{
            message: "getBlockByNumber",
            data: { blockNumber: ourLastBlockNumber.toString() },
            muid: null,
        }],
    }
    let lastSyncedBlockResponse = await highestBlockNumberPeer.call(lastSyncedBlockRequest, false)
    if (lastSyncedBlockResponse.result === 200) {
        console.log("[fastSync] Last synced block response received")
        let lastSyncedBlock = lastSyncedBlockResponse.response as Block
        if (lastSyncedBlock.hash !== ourLastBlockHash) {
            log.info("[fastSync] Hash is not coherent")
            log.info("[fastSync] Our hash: " + ourLastBlockHash)
            log.info("[fastSync] Peer hash: " + lastSyncedBlock.hash)
            sharedState.getInstance().syncStatus = false
            return false // ! Pass to the next peer
        }
        console.log("[fastSync] Hash is coherent: we can sync with: " + highestBlockNumberPeer.identity.toString("hex"))
    }
    // Sync the blocks one by one starting from the lowest block number that we do not have
    // ? Way more error handling needed
    let blockToAsk = ourLastBlockNumber + 1
    while (blockToAsk <= highestBlockNumber) {
        console.log("[fastSync] Asking peer for block: " + blockToAsk)
        let blockRequest: RPCRequest = {
            method: "nodeCall",
            params: [{
                message: "getBlockByNumber",
                data: { blockNumber: blockToAsk.toString() },
                muid: null,
            }],
        }
        let blockResponse = await highestBlockNumberPeer.call(blockRequest, false)
        if (blockResponse.result === 200) {
            console.log("[fastSync] Block response received for block: " + blockToAsk)
            let block = blockResponse.response as Block
            Chain.insertBlock(block)
            console.log("[fastSync] Block inserted successfully at the head of the chain!")
        }
        blockToAsk++
    }
    sharedState.getInstance().syncStatus = true
    return true
}


async function askLastBlockNumber(peer: Peer): Promise<number> {
    let node_call: NodeCall = {
        message: "getLastBlockNumber",
        data: null,
        muid: null,
    }
    let blockNumberResponse = await peer.call({
        method: "nodeCall",
        params: [node_call],
    }, false)
    if (blockNumberResponse.result === 200) {
        return blockNumberResponse.response as number
    } else {
        console.log("[SYNC] Peer does not have the last block number")
        return 0
    }
}

async function askBlockByNumber(peer: Peer, blockNumber: number): Promise<Block> {
    let node_call: NodeCall = {
        message: "getBlockByNumber",
        data: { blockNumber: blockNumber.toString() },
        muid: null,
    }
    let blockResponse = await peer.call({
        method: "nodeCall",
        params: [node_call],
    }, false)
    if (blockResponse.result === 200) {
        return JSON.parse(JSON.parse(blockResponse.response)) as Block
    } else {
        console.log("[SYNC] Peer does not have the block " + blockNumber)
        return null
    }
}
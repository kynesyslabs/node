/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Conflict handling between peers (longest chain)

import ResponseRegistry from "src/libs/communications/responseRegistry"
import { demostdlib } from "src/libs/utils"
import sharedState from "src/utilities/sharedState"
import terminalkit from "terminal-kit"

import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import { Response } from "../../communications/types/responseregistry"
import Peer from "../../peer/Peer"
import PeerManager from "../../peer/PeerManager"
import Block from "../block"
import Chain from "../chain"

const term = terminalkit.terminal

const peerManager = PeerManager.getInstance()
async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

export interface IPeerLastInfo {
    peerLastBlockNumber: number
    peerLastBlockHash: string
}

// INFO Experimental fast syncing with the first peer
// TODO This should be executed each time we connect to a new peer
export async function fastSync(
    cPeerlist: Peer[] = [],
    singlePeer: Peer = null,
) {
    // Our data is stored locally for convenience
    console.log("[SYNC] Syncing with the network...")
    console.log("[SYNC] Getting our last block number and hash...")
    let ourLastBlockNumber = await Chain.getLastBlockNumber()
    let ourLastBlockHash = await Chain.getLastBlockHash()
    console.log(
        "[SYNC] Our last block number is " +
            ourLastBlockNumber +
            " and our last block hash is " +
            ourLastBlockHash,
        "\n",
    )
    // Let's also store the actual peerlist or the things that we received from the caller
    console.log("[SYNC] Getting the peerlist...")
    let peerlist
    if (!singlePeer) {
        if (cPeerlist.length > 0) {
            peerlist = cPeerlist
        } else {
            peerlist = peerManager.getPeers()
        }
        console.log("[SYNC] Peerlist has length: " + peerlist.length)
    } else {
        peerlist = [singlePeer]
    }
    // Selecting the first peer
    let firstPeer = peerlist[0]
    console.log("[SYNC] First peer is " + firstPeer.connectionString)

    // Asking the first peer for the last block number
    let blockNumberResponse = await demostdlib.remoteCall(
        firstPeer.connectionString,
        firstPeer,
        "getLastBlockNumber",
        "nodeCall",
        true,
        false,
        "",
    )
    let blockNumber: number = 0
    if (blockNumberResponse[0]) {
        blockNumber = blockNumberResponse[1].message
        console.log("[SYNC] First peer has the last block number ")
        console.log(blockNumber)
    } else {
        console.log("[SYNC] First peer does not have the last block number")
        console.log("[SYNC] TODO: Not yet implemented; next peer logic")
        //process.exit(0)
        return true // TODO Not yet implemented ^
    }
    // Compute the block number difference
    let blockNumberDifference = blockNumber - ourLastBlockNumber
    console.log("[SYNC] Block number difference is " + blockNumberDifference)

    console.log("[SYNC] We need to sync " + blockNumberDifference + " blocks")

    // We need to sync?
    let blocktoAsk = ourLastBlockNumber

    // check on ourLastBlockHash that switch to each new block
    let isHashCoherent = true
    let previousHash = ourLastBlockHash

    // REVIEW This is a very naive way of doing this; we should use a better algorithm
    // REVIEW (the AI says so, it wrote the comment above)
    for (let i = 0; i < blockNumberDifference; i++) {
        // sourcery skip: use-braces
        // NOTE Debug flags
        if (sharedState.getInstance().PROD) blocktoAsk++

        console.log("[SYNC] Asking the first peer for block " + blocktoAsk)
        // Effectively asking the first peer for the block
        // TODO Test if it is more logic to just download the headers and, once a chain has been estabilished, download the blocks
        // TODO And by test i mean we have to do it
        let blockResponse = await demostdlib.remoteCall(
            firstPeer.connectionString,
            firstPeer,
            "getBlockByNumber",
            "nodeCall",
            true,
            false,
            { blockNumber: blocktoAsk.toString() },
        )

        console.log("[SYNC] Block response: " + blockResponse[0])
        let parsedBlock: Block = JSON.parse(blockResponse[1].message)  // FIXME Undefined?

        console.log("[SYNC DEBUG] Parsed block:")
        console.log(parsedBlock)
        console.log("[SYNC] Block hash:")
        console.log(parsedBlock.hash)

        console.log("[SYNC] Expecting: " + previousHash)
        // Checking if the hash of the previous block is the same of our block
        if (parsedBlock.content.previousHash !== previousHash) {
            term.red.bold("[SYNC] Hash is not coherent")
            isHashCoherent = false // TODO Handle bad responses
            // NOTE Debug flag
            if (sharedState.getInstance().PROD) isHashCoherent = true
            break
        }

        term.green("[SYNC] Block previous hash is coherent! Block accepted!")
        // We now have a valid block to insert I guess
        // eslint-disable-next-line no-unreachable
        Chain.insertBlock(parsedBlock)
        // Updating the last hash to be this one as we inserted it successfully
        previousHash = parsedBlock.hash
        term.green.bold(
            "[SYNC] Block inserted successfully at the head of the chain!",
        )
    }

    console.log("✅ [ Syncing with the network completed successfully ] ✅")
    sharedState.getInstance().syncStatus = true
    //process.exit(0)
}

/* WARNING - Experimental Ahead */

// INFO Syncing with the network using majority vote as legitimate check
// REVIEW Reimplement a smart way to sync the blockchain between two or more peers
export async function _Sync(id: any) {
    // Our data is stored locally for convenience
    console.log("[SYNC] Syncing with the network...")
    console.log("[SYNC] Getting our last block number and hash...")
    let ourLastBlockNumber = await Chain.getLastBlockNumber()
    let ourLastBlockHash = await Chain.getLastBlockHash()
    console.log(
        "[SYNC] Our last block number is " +
            ourLastBlockNumber +
            " and our last block hash is " +
            ourLastBlockHash,
        "\n",
    )
    // Let's also store the actual peerlist
    console.log("[SYNC] Getting the peerlist...")
    let peerlist = peerManager.getPeers()
    console.log("[SYNC] Peerlist has length: " + peerlist.length)
    let peerLastInfo: Map<string, IPeerLastInfo> = new Map()
    // To determine which peers we should sync with, we need to know the last block number and hash of each peer
    console.log("[SYNC] Iterating over the peerlist...")
    // TODO Complete this method
    console.log("[SYNC] { DEBUG } Returning sync anyway")
    return true
}

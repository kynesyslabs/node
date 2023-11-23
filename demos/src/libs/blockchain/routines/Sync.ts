/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// REVIEW Conflict handling between peers (longest chain)

import Chain from "../chain"
import PeerManager from "../../peer/PeerManager"
import ComLink from "../../communications/comlink"
import Transmission from "../../communications/transmission"
import Peer from "../../peer/Peer"
import { demostdlib } from "src/libs/utils"
const term = require("terminal-kit").terminal
const peerManager = PeerManager.getInstance()
import { Response } from "../../communications/types/responseregistry"
import ResponseRegistry from "src/libs/communications/responseRegistry"
import Block from "../block"
import sharedState from "src/utilities/sharedState"

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
    // NOTE Just useful for debug purposes only
    let testingMode = true

    // REVIEW This is a very naive way of doing this; we should use a better algorithm
    // REVIEW (the AI says so, it wrote the comment above)
    for (let i = 0; i < blockNumberDifference; i++) {
        // sourcery skip: use-braces
        // NOTE Debug flags
        if (!testingMode) blocktoAsk++

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
        let parsedBlock: Block = JSON.parse(blockResponse[1].message)
        console.log("[SYNC] Block hash:")
        console.log(parsedBlock.hash)

        // Checking if the hash of the previous block is the same of our block
        if (parsedBlock.content.previousHash !== previousHash) {
            term.red.bold("[SYNC] Hash is not coherent")
            isHashCoherent = false // TODO Handle bad responses
            // NOTE Debug flag
            if (testingMode) isHashCoherent = true
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
    // eslint-disable-next-line no-unreachable
    for (let peer of peerlist) {
        let peerConnectionString = peer.connectionString
        console.log(
            "[SYNC] Asking " +
                peerConnectionString +
                " for their last block info...",
        )
        // REVIEW Ask their info
        let peerLastBlockNumber = await demostdlib.remoteCall(
            peer.identity.toString("hex"),
            peer,
            "getLastBlockNumber",
            "nodeCall",
        )
        if (peerLastBlockNumber[0]) {
            console.log(
                "[SYNC] " +
                    peerConnectionString +
                    " has last block number " +
                    peerLastBlockNumber[1],
            )
        } else {
            console.log(
                "[SYNC] " + peerConnectionString + " has no last block number",
            )
        }
        let peerLastBlockHash = await demostdlib.remoteCall(
            peer.identity.toString("hex"),
            peer,
            "getLastBlockHash",
            "nodeCall",
        )
        if (peerLastBlockHash[0]) {
            console.log(
                "[SYNC] " +
                    peerConnectionString +
                    " has last block hash " +
                    peerLastBlockHash[1],
            )
        } else {
            console.log(
                "[SYNC] " + peerConnectionString + " has no last block hash",
            )
        }
        console.log("[SYNC] Storing their last block info...")
        // Storing their info
        peerLastInfo[peer.identity.toString("hex")] = {
            lastBlockNumber: peerLastBlockNumber,
            lastBlockHash: peerLastBlockHash,
        }
        console.log("[SYNC] Proceeding to next peer...")
    }
    console.log("[SYNC] PeerLastInfo has length: " + peerLastInfo.size)
    // REVIEW Compute the blocks to ask and to which peers to ask based on their last block number and ours
    // This gets us the max number between our last block number and the peers' last block number
    let highestBlockNumber = Math.max(
        ...Object.values(peerLastInfo).map(x => x.lastBlockNumber),
    )
    console.log("[SYNC] We need to reach block number " + highestBlockNumber)
    let blocksAndPeers: Map<number, Peer[]> = new Map()
    // Assigning blocks and peers (if a peer report a block n > of blockNumber they should be able to give it to us)
    console.log(
        "[SYNC] Iterating over the peerlist to determine who has the blocks we need...",
    )
    for (
        let blockNumber = highestBlockNumber;
        blockNumber >= ourLastBlockNumber;
        blockNumber--
    ) {
        // Creating the block space
        if (!blocksAndPeers[blockNumber]) {
            blocksAndPeers[blockNumber] = []
        }
        // Iterating over the peers
        for (let peer of peerlist) {
            let infos = peerLastInfo[peer.identity.toString("hex")]
            // Has the peer a last block number higher than this block number?
            if (infos && infos.lastBlockNumber >= blockNumber) {
                console.log(
                    "[SYNC] " +
                        peer.connectionString +
                        " has the block we need: " +
                        blockNumber,
                )
                blocksAndPeers[blockNumber].push(peer)
            }
        }
    }
    console.log("[SYNC] BlocksAndPeers has length: " + blocksAndPeers.size)
    // For each block to ask we ask all the peers that have the block to give us the block hash
    console.log("[SYNC] Iterating over the blocks to ask for their hashes...")
    for (let blockNumber of Object.keys(blocksAndPeers)) {
        let hashes: any = {}
        let hasHash: any = {}
        let peers = blocksAndPeers[blockNumber]
        // Asking the peers for the block hash
        console.log("[SYNC] Asking the peers for the block hash...")
        for (let peer of peers) {
            let blockHash = await demostdlib.remoteCall(
                peer.identity.toString("hex"),
                peer,
                "getBlockHash",
                "nodeCall",
                true,
                false,
                blockNumber,
            )
            console.log(
                "[SYNC] " +
                    peer.connectionString +
                    " has the block hash " +
                    blockHash[1] +
                    " for block number " +
                    blockNumber,
            )
            // Increasing the hash counter and storing a reference to the peer
            if (hashes[blockHash[1]] === undefined) {
                hashes[blockHash[1]] = 1
            }
            hashes[blockHash[1]] += 1
            if (hasHash[blockHash[1]] === undefined) {
                hasHash[blockHash[1]] = []
            }
            hasHash[blockHash[1]].push(peer)
        }
        console.log("[SYNC] Hashes has length: " + hashes.length)
        // The block hash with the highest number wins
        let winningBlockHash = Object.keys(hashes).sort(
            (a, b) => hashes[b] - hashes[a],
        )[0]
        console.log("[SYNC] The winning block hash is " + winningBlockHash)
        // Asking the first peer we got for the block
        let winningPeer: Peer = hasHash[winningBlockHash]
        console.log(
            "[SYNC] The winning peer is " + winningPeer.connectionString,
        )
        if (winningPeer) {
            console.log("[SYNC] Asking the winning peer for the block...")
            // TODO Absolutely verify if this even works with arguments
            let blockResponse = await demostdlib.remoteCall(
                winningPeer.identity.toString("hex"),
                winningPeer,
                "getBlockByHash",
                "nodeCall",
                true,
                false,
                winningBlockHash,
            )
            console.log("[SYNC] Block response: " + blockResponse[0])
            // If the block is valid, we add it to our chain
            if (blockResponse[0]) {
                // REVIEW Add the block to the chain
                await Chain.insertBlock(blockResponse[1])
                console.log("[SYNC] Block added")
                console.log(winningBlockHash)
                console.log("[SYNC] Kindly provided by: ")
                console.log(winningPeer.identity.toString("hex"))
                console.log("\n============================\n\n")
                //await sleep(1000)
            }
            console.log("[SYNC] Proceeding to next block...")
        }
    }
}

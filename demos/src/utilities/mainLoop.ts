// INFO The main loop executed in background by index.ts
import sharedState from "./sharedState"
import * as consensusTime from "../libs/consensus/routines/consensusTime"
import Sync from "src/libs/blockchain/routines/Sync"
import { Identity } from "src/libs/identity"

import { Peer, PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"
import Transmission from "src/libs/communications/transmission"
import ComLink from "src/libs/communications/comlink"
import { pki } from "node-forge"

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

let hasSentNodeOnlineTx = false
const peerManager = PeerManager.getInstance()

export default async function mainLoop(id: Identity) {
    console.log("[MAIN LOOP] Started")
    var cycleTimestamp: number
    while (sharedState.getInstance().runMainLoop) {
        await sleep(500) // Sleep for 1 second
        if (sharedState.getInstance().mainLoopPaused) {
            continue // Check if the main loop is paused
        }
        // NOTE Syncing the blockchain
        await Sync(id)
        // NOTE Using this as the timestamp of the current cycle
        // eslint-disable-next-line no-unused-vars
        cycleTimestamp = sharedState.getInstance().getTimestamp() // REVIEW Unused
        // NOTE The following routine is capable of checking if the consensus time has been reached automatically with a 100 ms blocking period

        // SECTION Todo list for a typical consensus operation

        // TODO Check if we have to forge the block now
        let isConsensusTimeReached = await consensusTime.checkConsensusTime()

        if (!hasSentNodeOnlineTx && !isConsensusTimeReached) {
            var online_presence_message = new Transmission(
                Identity.getInstance().ed25519.privateKey,
            )
            online_presence_message.initialize(
                // TODO Specify the answer so that it has a type AND a message
                "NODE_ONLINE",
                JSON.stringify({}),
                id.ed25519.publicKey,
                "placeholder", // TODO Add the receiver, don't we already have it in the receiver object?
                null,
                {},
            )
            await online_presence_message.finalize()
            // Populating the comlink
            const comLink = new ComLink()
            comLink.properties.require_reply = true
            comLink.properties.is_reply = false

            let peer = peerManager.getPeer(
                id.ed25519.publicKey as unknown as string,
            )

            if (!peer) {
                peer = new Peer()
                peer.identity = id.ed25519.publicKey as pki.ed25519.BinaryBuffer
            }

            await comLink.broadcastMessageToPeer(
                peer,
                online_presence_message,
                id.ed25519.privateKey as any,
            )

            hasSentNodeOnlineTx = true
        }

        // every block write online list
        const onlinePeers = peerManager.getOnlinePeers()

        // check if online peers have been online for 3 blocks

        // if its the first block ever or we are doing a regenesis, we might want to skip this check, but we still need a list of reliable nodes.
        // In the "3 block online" the history of online peers is validated by the blockchain AND by the consensus so it can be relied on.

        let currentlyOnlinePeers

        const peersOnlineForLastThreeBlocks =
            await Chain.getOnlinePeersForLastThreeBlocks()
        if (peersOnlineForLastThreeBlocks.length > 0) {
            // We found peers that have been online for 3 blocks. Use them in the consensus loop
            currentlyOnlinePeers = peersOnlineForLastThreeBlocks
        } else {
            // We didn't find peers that have been online for 3 blocks. Use the online peers list as it is
            // In this case we assume the node is isolated, starting up or that other nodes are not online or still connencting to the network
            currentlyOnlinePeers = onlinePeers
        }

        // we now have a list of online peers that can be used for consensus

        // !SECTION Todo list for a typical consensus operation

        if (isConsensusTimeReached) {
            console.log("[MAIN LOOP] Consensus time reached")
            hasSentNodeOnlineTx = false // Reset it for the next cycle.
            sharedState.getInstance().consensusMode = true
            // TODO Start consensus methods here
            // At the end of the consensus period, the main loop should start again
            sharedState.getInstance().consensusMode = false
        }
    }
    // TODO
}

// INFO The main loop executed in background by index.ts
import sharedState from "./sharedState"
import * as consensusTime from "../libs/consensus/routines/consensusTime"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import { _Sync } from "src/libs/blockchain/routines/Sync"
import { Identity } from "src/libs/identity"

import { Peer, PeerManager } from "src/libs/peer"
import Chain from "src/libs/blockchain/chain"
import Transmission from "src/libs/communications/transmission"
import ComLink from "src/libs/communications/comlink"
import { pki } from "node-forge"
import RepresentativeShard from "src/libs/consensus/types/PoR"
import QBFT from "src/libs/consensus/types/BFT"
import chain from "src/libs/blockchain/chain"

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

let hasSentNodeOnlineTx = false
const peerManager = PeerManager.getInstance()

export default async function mainLoop(id: Identity) {
    console.log("[MAIN LOOP] ✅ Started")
    var cycleTimestamp: number

    sharedState.getInstance().privateKey = id.ed25519
        .privateKey as unknown as pki.ed25519.BinaryBuffer

    sharedState.getInstance().publicKey = id.ed25519
        .publicKey as unknown as pki.ed25519.BinaryBuffer

    while (sharedState.getInstance().runMainLoop) {
        await sleep(500) // Sleep for 1 second
        if (sharedState.getInstance().mainLoopPaused) {
            continue // Check if the main loop is paused
        }
        // NOTE Syncing the blockchain
        await fastSync() // REVIEW Test here
        console.log("[MAIN LOOP] Synced! 🟢 ")
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
            console.log("[MAIN LOOP] 🐸 Peer is online")

            hasSentNodeOnlineTx = true
        }

        // every block write online list
        const onlinePeers = await peerManager.getOnlinePeers()

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
            console.log("using online peers list as it is")
            currentlyOnlinePeers = onlinePeers.map(peer => {
                return {
                    identity: peer.identity,
                    connectionString: peer.connectionString,
                }
            })
        }

        console.log("🐸🐸🐸 Family:")
        console.log(currentlyOnlinePeers)

        // we now have a list of online peers that can be used for consensus

        // chain.pruneBlocksToGenesisBlock()
        // chain.updateGenesisTimestamp(new Date().getTime())
        // chain.nukeGenesis()
        // throw new Error("pruned")

        // !SECTION Todo list for a typical consensus operation

        if (isConsensusTimeReached) {
            const sharedStateInstance = sharedState.getInstance()
            console.log("[MAIN LOOP] Consensus time reached")
            sharedStateInstance.mainLoopPaused = true // Pause the main loop
            hasSentNodeOnlineTx = false // Reset it for the next cycle.
            sharedStateInstance.consensusMode = true

            const shard = await RepresentativeShard.getInstance().getShard(
                currentlyOnlinePeers,
            )

            sharedStateInstance.shard = shard
            console.log("[MAIN LOOP] Shard:")
            console.log(shard)

            const consensus = await QBFT.representationAssembly(shard)
            console.log(
                `[MAIN LOOP] Consensus: ${
                    consensus[0]
                }, proposed block: ${JSON.stringify(consensus[1])}`,
            )

            if (consensus[0]) {
                const prevBlockNumber = (await chain.getLastBlock()).number
                consensus[1].number = prevBlockNumber + 1
                await chain.insertBlock(consensus[1])
            }

            // At the end of the consensus period, the main loop should start again

            delete sharedStateInstance.shard
            sharedStateInstance.consensusMode = false
            sharedStateInstance.mainLoopPaused = false // Pause the main loop
        }
    }
}

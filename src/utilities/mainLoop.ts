import { pki } from "node-forge"
import Chain from "src/libs/blockchain/chain"
import Mempool from "src/libs/blockchain/mempool"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import ComLink from "src/libs/communications/comlink"
import Transmission from "src/libs/communications/transmission"
import QBFT from "src/libs/consensus/mechanisms/BFT"
import RepresentativeShard from "src/libs/consensus/mechanisms/types/RepresentativeShard"
import { Identity } from "src/libs/identity"
import { Peer, PeerManager } from "src/libs/peer"

import * as consensusTime from "../libs/consensus/routines/consensusTime"
// INFO The main loop executed in background by index.ts
import sharedState from "./sharedState"
import Client from "src/libs/network/client"
import checkOfflinePeers from "src/libs/peer/routines/checkOfflinePeers"
import log from "src/utilities/logger"

async function sleep(time: number) {
    return new Promise(resolve => setTimeout(resolve, time))
}

let hasSentNodeOnlineTx = false

export default async function mainLoop() {
    log.info("[MAIN LOOP] ✅ Started")
    var cycleTimestamp: number

    while (sharedState.getInstance().runMainLoop) {
        await sleep(500) // Sleep for 500 ms
        if (sharedState.getInstance().mainLoopPaused) {
            continue // Check if the main loop is paused
        }
        // If it is not in pause, we set (or force set) the mainLoop flag to be on
        sharedState.getInstance().inMainLoop = true
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

        console.log("[MAINLOOP]: about to check if its time for consensus")

        if (!hasSentNodeOnlineTx && !isConsensusTimeReached) {
            console.log(
                "[MAINLOOP]: is not consensus time and no online node tx",
            )
            await sendNodeOnlineTx()
        }

        // Execute the peer routine before the consensus loop
        let currentlyOnlinePeers: Peer[] = await peerRoutine()
        // we now have a list of online peers that can be used for consensus

        // NOTE We need both the consensus time and the sync status to be true, to avoid
        // conflicts with the sync loop that would lead to a failure in the consensus mechanism.
        if (isConsensusTimeReached && sharedState.getInstance().syncStatus) {
            await consensusRoutine(currentlyOnlinePeers)
        } else if (!sharedState.getInstance().syncStatus) {
            // ? This is a bit redundant, isn't it?
            console.log(
                "[MAIN LOOP] Cannot start consensus, not in sync. Sync loop should start automatically",
            )
        }
    }
}

// ANCHOR Unified peer routine
async function peerRoutine(): Promise<Peer[]> {
    // Logging the current peerlist
    log.info("[PEERROUTINE] Logging peerlist")
    PeerManager.getInstance().logPeerList()

    // REVIEW Re check offline peers asynchronously
    console.log("[MAINLOOP]: checking offline peers")
    checkOfflinePeers() // NOTE This is an async method that will be executed in the background
    console.log("[MAINLOOP]: checked offline peers")

    // every block write online list
    console.log("[MAINLOOP]: getting online peers")
    const onlinePeers = await PeerManager.getInstance().getOnlinePeers()
    console.log("[MAINLOOP]: got online peers")

    // check if online peers have been online for 3 blocks

    // if its the first block ever or we are doing a regenesis, we might want to skip this check, but we still need a list of reliable nodes.
    // In the "3 block online" the history of online peers is validated by the blockchain AND by the consensus so it can be relied on.

    let currentlyOnlinePeers: Peer[] // ! typize

    console.log("[MAINLOOP]: getting online peers for last three blocks")
    const peersOnlineForLastThreeBlocks =
        await Chain.getOnlinePeersForLastThreeBlocks() // ! REVIEW if this works with hello_peer

    if (peersOnlineForLastThreeBlocks.length > 0) {
        // We found peers that have been online for 3 blocks. Use them in the consensus loop
        currentlyOnlinePeers = peersOnlineForLastThreeBlocks
    } else {
        // We didn't find peers that have been online for 3 blocks. Use the online peers list as it is
        // In this case we assume the node is isolated, starting up or that other nodes are not online or still connencting to the network
        console.log("using online peers list as it is")
        currentlyOnlinePeers = onlinePeers  
    }

    console.log("Family:")
    let famLen = currentlyOnlinePeers.length
    let famString = ""
    for (let i = 0; i < famLen; i++) {
        famString += "🐸 "
    }
    console.log(famString)

    // Returns the list of currently online peers
    return currentlyOnlinePeers
}

// ANCHOR Manages the node online tx
async function sendNodeOnlineTx() {
    var online_presence_message = new Transmission(
        sharedState.getInstance().identity.ed25519.privateKey,
    )
    online_presence_message.initialize(
        // TODO Specify the answer so that it has a type AND a message
        "NODE_ONLINE",
        JSON.stringify({}),
        sharedState.getInstance().identity.ed25519.publicKey,
        "placeholder", // TODO Add the receiver, don't we already have it in the receiver object?
        null,
        {},
    )
    await online_presence_message.finalize()
    // Populating the comlink
    const comLink = new ComLink()
    comLink.properties.require_reply = true
    comLink.properties.is_reply = false

    let peer = PeerManager.getInstance().getPeer(
        sharedState.getInstance().identity.ed25519
            .publicKey as unknown as string,
    )

    if (!peer) {
        peer = new Peer()
        peer.identity = sharedState.getInstance().identity.ed25519
            .publicKey as pki.ed25519.BinaryBuffer
    }

    await comLink.broadcastMessageToPeer(
        peer,
        online_presence_message,
        sharedState.getInstance().identity.ed25519.privateKey as any,
    )
    console.log("[MAIN LOOP] 🐸 Peer is online")

    hasSentNodeOnlineTx = true
}

// ANCHOR Consensus routine
async function consensusRoutine(currentlyOnlinePeers: Peer[]) {
    console.log("[MAIN LOOP] Consensus time reached")
    sharedState.getInstance().mainLoopPaused = true // Pause the main loop
    hasSentNodeOnlineTx = false // Reset it for the next cycle.
    sharedState.getInstance().consensusMode = true
    sharedState.getInstance().inConsensusLoop = true

    // REVIEW We have to proceed with the next mempool here, to avoid queued transactions to be included in the current immutable consensus round
    // await Mempool.nextMempool() // ? What if consensus fails? Should we rollback the mempool?

    const shard = await RepresentativeShard.getInstance().getShard(
        currentlyOnlinePeers,
    )
    

    sharedState.getInstance().shard = shard // ! On the first node, the shard does not include the second node (maybe it does not even reach that point     )
    console.log("[MAIN LOOP] Shard selected")
    console.log(shard)

    let consensus = null
    try {
        consensus = await QBFT.representationAssembly(shard)
    } catch (e) {
        console.log(e)
        throw e
    }
    console.log(
        `[MAIN LOOP] Consensus: ${
            consensus[0]
        }, proposed block: ${JSON.stringify(consensus[1])}`,
    )

    if (consensus[0]) {
        const prevBlockNumber = (await Chain.getLastBlock()).number
        consensus[1].number = prevBlockNumber + 1

        await Chain.insertBlock(consensus[1])

        // Next mempool
        await Mempool.nextMempool()
    }

    // At the end of the consensus period, the main loop should start again

    delete sharedState.getInstance().shard
    sharedState.getInstance().consensusMode = false
    sharedState.getInstance().inConsensusLoop = false
    sharedState.getInstance().mainLoopPaused = false // Pause the main loop
}

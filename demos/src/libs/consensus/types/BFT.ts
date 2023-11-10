// INFO This library provides all the methods required to apply a QBFT consensus algorithm in a PoR/BFT network.
import Mempool, { MempoolData } from "src/libs/blockchain/mempool"
import Block from "src/libs/blockchain/blocks"
import { io } from "socket.io-client"
import PeerManager from "src/libs/peer/PeerManager"
import Peer from "src/libs/peer/Peer"
import { Identity } from "src/libs/identity"
import { ProofOfRepresentation } from "./PoR"
import { demostdlib } from "src/libs/utils"

export default class QBFT {
    constructor() {}

    // INFO Exchanging the mempool data with the other peers and compute a pre consensus
    // to speed up the PoR process. Then, it sorts and compare a new block finalizing the
    // BFT part of the consensus.
    static async representationAssembly(
        shard: ProofOfRepresentation,
        id: Identity = null,
    ): Promise<[boolean, Block]> {
        let peers = await shard.getPeers()
        let peerManager = PeerManager.getInstance()
        let peersNumber = peers.length
        // Setting up the tracking data
        let consensusTracking = {
            on_block: 0,
            validators: peers,
            tot_validators: peersNumber,
            results: new Map<string, boolean>(), // Where string is the hex public key and boolean is the result
        }
        // Starting
        console.log("[BFT] Getting mempool")
        let our_mempool = await Mempool.getMempool()
        console.log("[BFT] Got mempool")
        let merged_mempool = our_mempool
        let pro = 0
        let con = 0
        // TODO Test staker list for online status
        // TODO IMPLEMENT THIS!
        // TODO Share the staker list and consensus the staker list too

        // Iterating over all the validators peers
        for (let i = 0; i < peersNumber; i++) {
            let currentPeer = peers[i]

            let peerInstance = peerManager.getPeer(
                currentPeer.identity.toString("hex"),
            )

            let remotePool: MempoolData

            console.log(
                "[BFT] Peer identity: " + peerInstance.identity.toString("hex"),
            )

            let remotePoolResponse = await demostdlib.remoteCall(
                peerInstance.identity.toString("hex"),
                peerInstance,
                "getMempool",
                "consensus",
                true,
            )
            console.log("[BFT] Received Remote Mempool Response")
            console.log(remotePoolResponse)

            // Check the response
            if (remotePoolResponse[0] !== true) {
                console.log("Remote mempool not valid")
                return [false, null]
            }

            remotePool = JSON.parse(remotePoolResponse[1].message)

            console.log("[BFT] Received Remote Mempool")
            console.log(remotePool)

            console.log("[BFT] Receiving Mempool")
            // Fast validity check is done by the Mempool module above
            let valid = await Mempool.receive(remotePool)
            if (!valid) {
                console.log("Mempool not valid")
                return [false, null]
            }
            // Merging with the remote pool as it is compatible
            let mergedResult = await Mempool.merge(remotePool)
            if (!mergedResult) {
                console.log("Mempool merge failed")
                return [false, null]
            }

            // We now have the merged mempool in Mempool.getInstance()(for ex. the .transactions property)
            let compatible = true
            consensusTracking.results.set(
                peerInstance.identity.toString("hex"),
                compatible,
            )
            if (compatible) {
                pro++
            } else {
                con++
            }
        }
        // REVIEW If 2/3 + 1 have the same merged mempool, then we have a consensus
        console.warn(
            "[sQBFT Preliminary Validators Test] Ok: " +
                pro +
                " | Invalid: " +
                con +
                "\n",
        )
        // Check if 2/3 + 1 are pro
        let consensusReached = this.checkConsensus(pro, con, peersNumber)
        if (!consensusReached) {
            return [false, null]
        }
        // REVIEW Sort the mempool
        let sortedPool = await Mempool.sort(await Mempool.getMempool())
        // Build the block
        let forgedProposedBlock = await Mempool.getProposedBlock()
        let forgedProposedHash = forgedProposedBlock.hash
        // REVIEW BFT for the block with the others
        console.log("[sQBFT]: forgedProposedHash: " + forgedProposedHash)
        let finalResult = await this.vote(
            "forgedProposedHash",
            forgedProposedHash,
        )
        return [finalResult, forgedProposedBlock]
    }

    // INFO Voting on a parameter through a list of peers and then computing the consensus
    // TODO Test and verify that works
    static async vote(parameter: any, our: any): Promise<boolean> {
        let peerlist: Peer[] = await PeerManager.getInstance().getPeers()
        let numericResult = {
            pro: 0,
            con: 0,
            total: 0,
        }
        // Iterating over all the peers
        for (let i = 0; i < peerlist.length; i++) {
            let peer = peerlist[i]

            const response = await new Promise(resolve => {
                peer.socket.emit(
                    "voteRequest",
                    {
                        parameter: parameter,
                    },
                    response => {
                        resolve(response)
                    },
                )
            })

            console.log("[BFT VOTING]: Response")

            console.warn(response)
            console.warn(our)
            // TODO Wait for the response from the peer (maybe use a classic comlink)
            // Compiling the registry
            if (response != our) {
                numericResult.con++
            } else {
                numericResult.pro++
            }
        }
        console.warn(
            "[sQBFT Voting] \nParameter: " +
                parameter +
                "\nOur value: " +
                our +
                "\nOk: " +
                numericResult.pro +
                " | Invalid: " +
                numericResult.con +
                "\n",
        )
        return QBFT.checkConsensus(
            numericResult.pro,
            numericResult.con,
            numericResult.total,
        )
    }

    // INFO Checking a generic consensus BFT
    private static checkConsensus(
        pro: number,
        con: number,
        total: number,
    ): boolean {
        console.log(
            `[BFT] Checking consensus. Got ${pro} pro and ${con} against votes}`,
        )
        // let twothirdPlus1 = (total * 2) / 3 + 1 // REVIEW Is this correct?
        let twothirdPlus1 = 1
        if (pro >= twothirdPlus1) {
            console.info("[sQBFT] We have a theoric consensus!\n")
            return true
        } else {
            console.error("[sQBFT] We don't have a theoric consensus!\n")
            return false
        }
    }
}

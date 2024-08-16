import Block from "src/libs/blockchain/block"
import Chain from "src/libs/blockchain/chain"
// INFO This library provides all the methods required to apply a QBFT consensus algorithm in a PoR/BFT network.
import Mempool, { MempoolData } from "src/libs/blockchain/mempool"
import { filterOutliers, median } from "src/libs/network/routines/timeSyncUtils"
import Peer from "src/libs/peer/Peer"
import PeerManager from "src/libs/peer/PeerManager"
import { demostdlib } from "src/libs/utils"

import deriveBlock from "../routines/deriveBlock"
import { askPoC } from "../routines/proofOfConsensus"
import { ProofOfRepresentation } from "./PoR"
import log from "src/utilities/logger"
import { ConsensusRequest } from "src/libs/network/server_rpc"

export default class QBFT {
    constructor() {}

    // INFO Exchanging the mempool data with the other peers and compute a pre consensus
    // to speed up the PoR process. Then, it sorts and compare a new block finalizing the
    // BFT part of the consensus.
    static async representationAssembly(
        shard: ProofOfRepresentation,
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

        let pro = 0
        let con = 0

        let mempoolList: MempoolData[] = []

        // TODO Test staker list for online status
        // TODO IMPLEMENT THIS!
        // TODO Share the staker list and consensus the staker list too

        // Iterating over all the validators peers
        for (let i = 0; i < peersNumber; i++) {
            let currentPeer = peers[i]

            console.log("[BFT] Peer: " + currentPeer.identity.toString("hex"))

            let peerInstance = peerManager.getPeer(
                currentPeer.identity.toString("hex"),
            )

            if (!peerInstance) {
                console.warn(
                    "[BFT] Peer not found in the peer manager: " +
                        currentPeer.identity.toString("hex"),
                )
                throw new Error("Peer not found in the peer manager")
            }

            let remotePool: MempoolData

            console.log(
                "[BFT] Peer identity: " + peerInstance.identity.toString("hex"),
            )
            let consensus_call: ConsensusRequest = {
                message: "getMempool",
                sender: peerInstance.identity.toString("hex"),
            }
            let remotePoolResponse = await peerInstance.call({
                method: "consensus",
                params: [consensus_call],
            })
            /*
            // ! Replace with a node call or whatever
            let remotePoolResponse = await demostdlib.remoteCall(
                peerInstance.identity.toString("hex"),
                peerInstance,
                "getMempool",
                "consensus",
                true,
            )
            console.log("[BFT] Received Remote Mempool Response")
            console.log(remotePoolResponse)
            */
            // Check the response
            if (remotePoolResponse.result !== 200) {
                console.log("Remote mempool not valid")
                return [false, null]
            }
            remotePool = remotePoolResponse.response

            console.log("[BFT] Received Remote Mempool")
            console.log(remotePool)

            console.log("[BFT] Receiving Mempool")
            // Fast validity check is done by the Mempool module above
            let valid = await Mempool.receive(remotePool)
            if (!valid) {
                console.log("Mempool not valid")
                return [false, null]
            }

            mempoolList.push(remotePool)

            // Merging with the remote pool as it is compatible
            let mergeSuccess = await Mempool.merge(remotePool)
            if (!mergeSuccess) {
                console.log("Mempool merge failed")
                return [false, null]
            }

            console.log("Merged Mempool Result: ")
            console.log(JSON.stringify(mergeSuccess))

            // We now have the merged mempool in Mempool.getInstance()(for ex. the .transactions property)
            let compatible = mergeSuccess
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

        const timestamps = mempoolList.map(mempool => mempool.timestamp)
        let medianTimestamp
        if (timestamps.length === 1) {
            medianTimestamp = timestamps[0]
        } else if (timestamps.length === 2) {
            medianTimestamp = (timestamps[0] + timestamps[2]) / 2
        } else if (timestamps.length > 2) {
            const filteredTimestamps = filterOutliers(timestamps)
            medianTimestamp = median(filteredTimestamps)
        }

        console.log("[sQBFT]: median timestamp: " + medianTimestamp)

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
        const mempool = await Mempool.getMempool()
        console.log("[BFT]: Retrieved Mempool: ")
        console.log(mempool)
        const { derivedBlock, full_ordered_transactions } = await deriveBlock(
            mempool,
            medianTimestamp,
            shard,
        )

        // REVIEW Should we do something for derivedBlock.content.encrypted_transactions too?

        console.log("[BFT]: full ordered transactions for current iteration: ")
        console.log(full_ordered_transactions)

        console.log("[BFT]: derived block for current iteration: ")
        console.log(derivedBlock)

        const proposedBlock = derivedBlock

        let forgedProposedHash = proposedBlock.hash

        //console.log(forgedProposedHash)

        const pocList = []
        // Another loop to get the PoC
        for (let i = 0; i < peersNumber; i++) {
            let currentPeer = peers[i]

            let peerInstance = peerManager.getPeer(
                currentPeer.identity.toString("hex"),
            )

            pocList.push(await askPoC(forgedProposedHash, peerInstance))
            console.warn("[BFT] [Response from PoC] forgedProposedHash: " + forgedProposedHash)
            console.warn("[BFT] [Response from PoC] peerInstance: " + peerInstance.identity)
        }

        console.log("[BFT]: pocList")
        console.log(pocList)

        let errored
        pocList.forEach(pocItem => {
            if (pocItem === null) {
                errored = true
                console.log(consensusReached)
                //console.log(mempool)
                console.log(proposedBlock)
                //console.log(forgedProposedHash)
            }
        })
        if (errored === true) {
            return [false, null]
        }

        // eslint-disable-next-line no-unused-vars
        const validatorPocList = pocList.map(({ socket, ...rest }) => rest)

        proposedBlock.validation_data = JSON.stringify(validatorPocList)

        // REVIEW BFT for the block with the others
        console.log("[sQBFT]: forgedProposedHash: " + forgedProposedHash)
        let finalResult = await this.vote(
            "forgedProposedHash",
            forgedProposedHash,
            medianTimestamp,
        )

        if (finalResult) {
            let ordered_txs = full_ordered_transactions
            console.log(
                "[sQBFT]: ordered_txs: " + ordered_txs.length.toString(),
            )
            console.log(
                "[sQBFT]: Block number: " + proposedBlock.number.toString(),
            )
            for (let i = 0; i < ordered_txs.length; i++) {
                let tx = ordered_txs[i]
                // REVIEW Insert each transaction in the transactions table with the block number and the tx hash
                tx.blockNumber = proposedBlock.number
                // REVIEW Sanitizing the tx too
                if (!tx.content.to) {
                    tx.content.to = "missing"
                }
                await Chain.insertTransaction(tx)
            }
        }

        return [finalResult, proposedBlock]
    }

    // INFO Voting on a parameter through a list of peers and then computing the consensus
    // TODO Test and verify that works
    static async vote(
        parameter: any,
        our: any,
        timestamp: number,
    ): Promise<boolean> {
        let peerlist: Peer[] = await PeerManager.getInstance().getPeers()
        let numericResult = {
            pro: 0,
            con: 0,
            total: 0,
        }
        // Iterating over all the peers
        for (let i = 0; i < peerlist.length; i++) {
            let peer = peerlist[i]
            log.info(`[BFT] Voting on parameter ${parameter} for peer ${peer.identity.toString("hex")}`)
            // ! remove the debug
            var response = null
            try {
            response = await new Promise(resolve => {
                peer.connection.socket.emit(
                    "voteRequest",
                    {
                        parameter: parameter,
                        timestamp: timestamp,
                    },
                    response => {
                        resolve(response)
                    },
                )
                })
            } catch (error) {
                log.error(`[BFT] Error voting on parameter ${parameter} for peer ${peer.identity.toString("hex")}`+error)
                response = null
            }

            console.log("Voting will compare:\n")
            //console.log(response)
            console.log(our)

            // Compiling the registry
            if (response != our) {
                numericResult.con++
            } else {
                numericResult.pro++
            }
            numericResult.total++
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
            `[BFT] Checking consensus. Got ${pro} pro and ${con} against votes}, got ${total} votes`,
        )
        let twothirdPlus1

        if (total === 1) {
            twothirdPlus1 = 1
        } else {
            twothirdPlus1 = (total * 2) / 3 + 1
        }

        if (pro >= twothirdPlus1) {
            console.info("[sQBFT] We have a theoric consensus!\n")
            return true
        } else {
            console.error("[sQBFT] We don't have a theoric consensus!\n")
            return false
        }
    }
}

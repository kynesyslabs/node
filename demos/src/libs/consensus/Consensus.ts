import Peer from "../network/peers"
import { PeerManager } from "../peer"
import chooseValidator from "./routines/chooseValidator"
import Block from "../blockchain/blocks"
import Mempool from "../blockchain/mempool"
import buildProposedBlock from "../blockchain/routines/buildProposedBlock"
import executeOperations from "../blockchain/routines/executeOperations"
import GLS from "../blockchain/gls/gls"

// NOTE This class is to handle effectively nodeCalls of the consensus subgroup
export interface ConsensusRequest {
    stage: string // "mempool_sync", "proposed_block" ...
    extra: any // Specify stage operations (receive, send, broadcast...)
    data: any
}

export interface ConsensusRound {
	number: number;
	lastBlockHash: string;
	lastBlockTimestamp: number;
	lastConsensusHash: string;
    validators: Map<string, Peer>;
}

export default class Consensus {
    private static instance: Consensus
    private round_number: number

    rounds: Map<number, ConsensusRound>
    proposedBlock: Block

    constructor() {
        // TODO Implement datasource also for this registry that will be included in the block
    }

    static getInstance(): Consensus {
        if (!Consensus.instance) {
            Consensus.instance = new Consensus()
        }
        return Consensus.instance
    }

    // NOTE THis will inspect the proposed block of the other validators of this round
    static async inspectProposedBlock(proposedBlock: Block): Promise<boolean> {
        let valid = true
        // TODO Inspect block using our mempool/block
        return valid
    }


    // ANCHOR Object methods

    // NOTE Select a validator (or a group of them)
    async chooseValidators() {
        // REVIEW Select minimum of 4 validators with a 2.5 seconds timeout
        let ms = 0
        while (this.rounds[this.round_number].validators.size < 4 && ms < 2500) {
            ms += 100
            await new Promise(resolve => setTimeout(resolve, 100))
            // Choosing peer deterministically
            let chosenPeer = await chooseValidator(PeerManager.getInstance().getPeers())
            let identity = chosenPeer.identity.toString("hex")
            this.rounds[this.round_number].validators.set(identity, chosenPeer)
        }
    }

    // NOTE This is an handy method to make stuff simpler
    async getProposedBlock(): Promise<void> {
        this.proposedBlock = await Mempool.getProposedBlock()
    }

    async broadcastProposedBlock(): Promise<void> {
        for (let validator of this.rounds[this.round_number].validators.values()) {
            // TODO For each validator, broadcast the proposed block using a comlink
        }
    }


    // INFO This is called after the consensus, when proposedBlock is already in sync with the others
    async finalizeBlock(): Promise<boolean> {
        // REVIEW Once the consensus is done, finalize the block by editing the blockchain itself and
        // executing the GLS operations
        // NOTE Specifically, use executeOperations as imported and all the GLS stuff are done there
        let gls_changes = GLS.getInstance().operations
        let outcome = await executeOperations(gls_changes)
        if (!outcome) {
            throw new Error("Failed to finalize block") // REVIEW Or return null?
        }
        // REVIEW if this is valid
        this.rounds[this.round_number].lastBlockHash = this.proposedBlock.hash
        this.rounds[this.round_number].lastBlockTimestamp = this.proposedBlock.timestamp
        this.rounds[this.round_number].lastConsensusHash = this.proposedBlock.hash
        this.rounds[this.round_number].validators.clear()
        this.round_number += 1
        this.proposedBlock = null
        return true
    }

}
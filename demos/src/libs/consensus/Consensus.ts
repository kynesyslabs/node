import Peer from "../network/peers"
import { PeerManager } from "../peer"
import chooseValidator from "./routines/chooseValidator"

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

    constructor() {
        // TODO Implement datasource also for this registry that will be included in the block
    }

    static getInstance(): Consensus {
        if (!Consensus.instance) {
            Consensus.instance = new Consensus()
        }
        return Consensus.instance
    }

    // ANCHOR Object methods

    // INFO Select a validator (or a group of them)
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

}
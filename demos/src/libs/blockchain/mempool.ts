/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// INFO Singleton Mempool class
import Transaction from "./transaction"
import PeerManager from "../peer/PeerManager"
import buildProposedBlock from "./routines/buildProposedBlock"
import Block from "./blocks"

export default class Mempool {
    private static instance: Mempool
    // Class variables
    transactions: Transaction[]
    proposedBlock: Block

    constructor() {
        this.transactions = []
    }

    // INFO The mempool contains a dynamic proposedBlock Block object
    getProposedBlock(): Block {
        if (!this.proposedBlock) {
            this.proposedBlock = buildProposedBlock()
        }
        return this.proposedBlock
    }

    // INFO Broadcasting the mempool to all the peers
    async broadcast() {
        // Retrieve peerlist
        let peerlist = PeerManager.getInstance().getPeers()
        // TODO For cycle sending mempool to peerlist
    }

    async receive(mempool: Mempool) {
        // TODO Parse, verify and call merge
        let success = await this.merge(mempool)
        return success
    }

    // INFO Merging the mempool received
    private async merge(mempool: Mempool) {
        // Merge the mempool with our one
        this.transactions.concat(mempool.transactions) // TODO Add double items checking
    }

    // INFO Singleton instance
    public static getInstance() {
        return this.instance || (this.instance = new this())
    }
}
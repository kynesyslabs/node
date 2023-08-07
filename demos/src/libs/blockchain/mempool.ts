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
import Chain from "./chain"


export interface MempoolData {
    current: number
    transactions: Transaction[]
    proposedBlock: Block
}

export default class Mempool {
    // INFO Reading the whole mempool
    public static async getMempool(): Promise<MempoolData> {
        let mempool = await Chain.read("SELECT * from mempool WHERE current = 1")
        return mempool
    }


    // INFO The mempool contains a dynamic proposedBlock Block object
    public static async getProposedBlock(): Promise <Block> {
        let mempool = await Mempool.getMempool()
        if (!mempool.proposedBlock) {
            mempool.proposedBlock = buildProposedBlock()
            await Chain.write("UPDATE mempool SET proposedBlock ='" + JSON.stringify(mempool.proposedBlock) + "' WHERE current = 1")
        }
        return mempool.proposedBlock
    }

    // INFO Broadcasting the mempool to all the peers
    public static async broadcast() {
        // Retrieve peerlist
        let peerlist = PeerManager.getInstance().getPeers()
        // TODO For cycle sending mempool to peerlist
    }

    public static async receive(mempool: MempoolData) {
        // TODO Parse, verify and call merge
        let success = await Mempool.merge(mempool)
        return success
    }

    // INFO Merging the mempool received
    private static async merge(received_mempool: MempoolData) {
        let mempool = await Mempool.getMempool()
        // Merge the mempool with our one
        mempool.transactions.concat(received_mempool.transactions) // TODO Add double items checking
        await Chain.write("UPDATE mempool SET transactions = '" + JSON.stringify(mempool.transactions) + "' WHERE current = 1")
    }
}

/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

// TODO Test the db instance of mempool and check if all the tables are ok

// INFO Singleton Mempool class
import Transaction from "./transaction"
import PeerManager from "../peer/PeerManager"
import buildProposedBlock from "./routines/buildProposedBlock"
import Block from "./blocks"
import Chain from "./chain"


export interface MempoolData {
    number: number
    current: number
    transactions: Transaction[]
    proposedBlock: Block
}

export default class Mempool {

    // INFO Reading the whole current mempool
    public static async getMempool(): Promise<MempoolData> {
        let mempool = await Chain.read("SELECT * from mempool WHERE current = 1")
        return mempool
    }


    // INFO The mempool contains a dynamic proposedBlock Block object
    public static async getProposedBlock(): Promise <Block> {
        let mempool = await Mempool.getMempool()
        if (!mempool.proposedBlock) {
            mempool.proposedBlock = await buildProposedBlock()
            await Chain.write("UPDATE mempool SET proposedBlock ='" + JSON.stringify(mempool.proposedBlock) + "' WHERE current = 1")
        }
        return mempool.proposedBlock
    }

    // INFO Writing a transaction to the mempool
    public static async addTransaction(transaction: Transaction): Promise<void> {
        let mempool = await Mempool.getMempool()
        mempool.transactions.push(transaction) // REVIEW What if it is empty?
        await Chain.write("UPDATE mempool SET transactions ='" + JSON.stringify(mempool.transactions) + "' WHERE current = 1")
    }

    // INFO Removing a transaction from the mempool
    public static async removeTransaction(transaction: Transaction): Promise<void> {
        let mempool = await Mempool.getMempool()
        let index = mempool.transactions.indexOf(transaction)
        mempool.transactions.splice(index, 1)
        await Chain.write("UPDATE mempool SET transactions ='" + JSON.stringify(mempool.transactions) + "' WHERE current = 1")
    }

    // INFO Adding a new mempool
    public static async nextMempool(): Promise<void> {
        let mempool = await Mempool.getMempool()
        // Calculating the next number
        let next_number = mempool.number + 1
        // Archiving the current mempool
        await Chain.write("UPDATE mempool SET current = 0 WHERE current = 1")
        // Creating a new mempool line
        await Chain.write("INSERT INTO mempool VALUES(" + next_number + ", 1, '[]', '{}')")
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

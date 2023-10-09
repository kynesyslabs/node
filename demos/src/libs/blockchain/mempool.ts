/* eslint-disable no-unused-vars */
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
import Hashing from "../crypto/hashing"
import Cryptography from "../crypto/cryptography"

export interface MempoolData {
    number: number
    current: number
    transactions: Transaction[]
    proposedBlock: Block
}

export default class Mempool {

    // INFO Reading the whole current mempool
    // REVIEW What if the mempool is empty?
    // FIXME If the mempool is empty we should anyway have a MempoolData object
    public static async getMempool(): Promise<MempoolData> {
        let sql_results = await Chain.read("SELECT * from mempool WHERE current = 1")
        let sql_result = sql_results[0]
        console.log(sql_result)
        // In case there is no current mempool, lets create it
        if (!sql_result || sql_result.length === 0) {
            console.log("[Mempool] No current mempool found, creating one...")
            let newMempool: MempoolData = {
                number: 0,
                current: 1,
                transactions: [],
                proposedBlock: null,
            }
            await Chain.write("INSERT INTO mempool VALUES(" 
            + newMempool.number + ", "
            + newMempool.current + ", '"
            + JSON.stringify(newMempool.transactions) + "', '"
            + null + "')")
            sql_result = await Chain.read("SELECT * from mempool WHERE current = 1")
        }
        // Normalizing
        if (typeof(sql_result) === "string") {
            let sql_results = JSON.parse(sql_result)
            sql_result = sql_results[0]
        } else {
            sql_result = sql_result[0]
        }
        console.log("Mempool query result:")
        console.log(sql_result)
        // Serializing
        let result: MempoolData = {
            number: sql_result.number,
            current: sql_result.current,
            transactions: JSON.parse(sql_result.transactions),
            proposedBlock: JSON.parse(sql_result.proposedBlock),
        }
        console.log("Mempool retrieved:")
        console.log(result)
        return result
        
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
        console.log(mempool)
        mempool.transactions.push(transaction) // REVIEW What if it is empty?
        await Chain.write("UPDATE mempool SET transactions ='" + JSON.stringify(mempool.transactions) + "' WHERE current = 1")
    }

    // INFO Writing the headers of the PoR to the mempool
    public static async addHeaders(headers: any): Promise<void> { // TODO Add types
        let mempool = await Mempool.getMempool()
        // REVIEW Ensure the schema of the headers is correctly inserted into the db
        await Chain.write("UPDATE mempool SET headers ='" + JSON.stringify(headers) + "' WHERE current = 1")
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

    /* TODO Representative Shard

    Deterministic group selection
    - The group sync the mempool and exclude the invalid transactions
    - mempool sort by gas fee bid (see gas fee in yp) -> market of nodes buziness
    - BFT
    */
    // INFO Broadcasting the mempool to all the peers
    public static async broadcast() {
    // Retrieve peerlist
        let peerlist = PeerManager.getInstance().getPeers()
        // TODO For cycle sending mempool to peerlist
    }

    // INFO Once receivinga mempool, we either merge or refuse it based on the following method ingesting it (first step)
    public static async receive(mempool: MempoolData): Promise<boolean> {
        // REVIEW and expand: parse, verify and call merge
        // Basic features that must be identical to us
        let local_mempool = await Mempool.getMempool()
        // We need to have the same forecasted block number, of course
        if (local_mempool.number != mempool.number) {
            return false
        }
        // Checking all the txs one by one for the signatures
        for (let i = 0; i < mempool.transactions.length; i++) {
            let tx = mempool.transactions[i]
            // NOTE Verifying the hash of the transaction
            let tx_hash = tx.hash
            console.log("[MEMPOOL VERIFICATION] Verifying the hash of the transaction: " + tx_hash)
            let calculated_hash =  Hashing.sha256(JSON.stringify(tx.content))
            if (calculated_hash!= tx_hash) {
                console.log("[X] [MEMPOOL VERIFICATION] The hash of the transaction is invalid")
                return false
            }
            console.log("[+] [MEMPOOL VERIFICATION] The hash of the transaction is valid")
            // NOTE Verifying the signature against the verified hash using from as public key
            console.log("[MEMPOOL VERIFICATION] Verifying the signature")
            let {signature} = tx
            console.log("[MEMPOOL VERIFICATION] Signature: " + signature.toString("hex"))
            let public_key = tx.content.from
            console.log("[MEMPOOL VERIFICATION] Public key: " + public_key.toString("hex"))
            let signature_valid = Cryptography.verify(tx_hash, signature, public_key)
            if (!signature_valid) {
                console.log("[X] [MEMPOOL VERIFICATION] The signature is invalid")
                return false
            }
        }
        console.log("[+] [MEMPOOL VERIFICATION] The signature is valid")
        // If everything is fine, we can merge the mempool
        console.log("[MEMPOOL MERGING] Merging the mempool")
        let success = await Mempool.merge(mempool)
        if (success) {
            console.log("[+] [MEMPOOL MERGING] The mempool has been merged")
        } else {
            console.log("[X] [MEMPOOL MERGING] The mempool has not been merged")
        }
        return success
    }

    // INFO Merging the mempool received (second step)
    public static async merge(received_mempool: MempoolData): Promise<boolean> {
        let mempool = await Mempool.getMempool()
        // REVIEW Checking and excluding duplicates
        for (let i = 0; i < received_mempool.transactions.length; i++) {
            let tx = received_mempool.transactions[i]
            let index = mempool.transactions.indexOf(tx)
            if (index!= -1) {
                mempool.transactions.splice(index, 1)
            }
        }
        // Merge the mempool with our one
        mempool.transactions = mempool.transactions.concat(received_mempool.transactions) // REVIEW is this the best way to merge?
        await Chain.write("UPDATE mempool SET transactions = '" + JSON.stringify(mempool.transactions) + "' WHERE current = 1")
        return true
    }

    // INFO Sorting the mempool in place (final step)
    public static async sort(mempool: MempoolData): Promise<MempoolData> {

        mempool.transactions.sort((tx1, tx2) => {
            let comparison = tx1.content.transaction_fee.rpc_fee > tx2.content.transaction_fee.rpc_fee ? -1 : tx1.content.transaction_fee.rpc_fee < tx2.content.transaction_fee.rpc_fee ? 1 : 0
            if (comparison) {
                return -1
            } else {
                return 1
            }
        })
        await Chain.write("UPDATE mempool SET transactions = '" + JSON.stringify(mempool.transactions) + "' WHERE current = 1")
        return mempool
    }

    // INFO Checking for double nonces for same address
    public static async checkNonce(tx: Transaction, replace: boolean = true): Promise<MempoolData> {
        let local_mempool = await Mempool.getMempool()
        for (let i = 0; i < local_mempool.transactions.length; i++) {
            let pooled_tx = local_mempool.transactions[i]
            if ((pooled_tx.content.from == tx.content.from) &&
                (pooled_tx.content.nonce == tx.content.nonce) &&
                (replace)) {
                local_mempool.transactions.splice(i, 1)
                await Chain.write("UPDATE mempool SET transactions = '" + JSON.stringify(local_mempool.transactions) + "' WHERE current = 1")

            }
        }
        
        return local_mempool

    }

}

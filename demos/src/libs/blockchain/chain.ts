/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Block from "./blocks"
import Transaction from "./transaction"
import Hashing from "../crypto/hashing"
import Datasource from "src/model/datasource"
import { Operation } from "./gls/gls"
import executeOperations from "./routines/executeOperations"

export default class Chain {
    private static instance: Chain

    static getInstance(): Chain {
        if (!this.instance) {
            this.instance = new Chain()
        }
        return this.instance
    }

    static async read(sql_query: string): Promise<any> {
        try {
            const db = await Datasource.getInstance()
            const result = await db.getDataSource().query(sql_query)

            //console.log("[ChainDB] [ READ ]: ")
            //console.log(result)
            return result
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            throw err
        }
    }

    static async write(sql_query: string) {
        try {
            const db = await Datasource.getInstance()
            const result = await db.getDataSource().query(sql_query)
            //console.log("[ChainDB] [ WRITE ]: " + result)
            return result
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            throw err
        }
    }


    // SECTION Getters

    // INFO Returns a transaction by its hash
    static async getTxByHash(hash: string): Promise<any> {
        let sql_query = "SELECT * FROM transactions WHERE hash = '" + hash + "';"
        let response = await Chain.read(sql_query)
        return response[0]
    }

    // INFO Get the last block number
    static async getLastBlockNumber() {
        let response = await this.read(
            "SELECT number FROM blocks ORDER BY number ASC LIMIT 1",
        )
        return response[0]
    }
    // INFO Get the last block hash
    static async getLastBlockHash() { 
        let response = await this.read(
            "SELECT hash FROM blocks ORDER BY number ASC LIMIT 1",
        )
        return response[0]
    }
    // INFO Get any block by its number
    static async getBlockByNumber(number: number) {
        let response = await this.read(
            "SELECT * FROM blocks WHERE number='" + number + "'",
        )
        return response[0]
    }
    // INFO Get any block by its hash
    static async getBlockByHash(hash: string) {
        let response = await this.read("SELECT * FROM blocks WHERE hash='" + hash + "'")
        return response[0]
    }
    // INFO Get a group of blocks by their status
    static async getBlockNumbersByStatus(status: string) {
        return await this.read(
            "SELECT number FROM blocks WHERE status=" + status,
        )
    }
    // INFO Get a group of blocks by their proposer
    static async getBlockNumbersByProposer(proposer: string) {
        return await this.read(
            "SELECT number FROM blocks WHERE proposer=" + proposer,
        )
    }

    static async getGenesisBlock() {
        // Playground for async testing
        let _res = await this.read("SELECT * FROM blocks WHERE number=0")
        return _res
    }

    // INFO Get the current pending transactions pool
    static async getPendingPool() {
        return await this.read(
            "SELECT * FROM transactions WHERE status='pending'",
        )
    }

    // ANCHOR Transactions
    static async getTransactionFromHash(hash: string): Promise<any> {
        let tx = await Chain.read("SELECT * FROM transactions WHERE hash = '" + hash + "'")
        // TODO Would be nice to fit it into a Transaction object
        return tx
    }

    // REVIEW Giving back all the properties of an address
    static async getAddressInfo(address: string): Promise<any> {
        let native_state = await Chain.read("SELECT * FROM status_native WHERE address = '" + address + "'")
        native_state = native_state[0]? native_state[0] : null
        let properties_state = await Chain.read("SELECT * FROM status_properties WHERE address = '" + address + "'")
        properties_state = properties_state[0]? properties_state[0] : null
        return {
            native: native_state,
            properties: properties_state,
        }
    }

    // !SECTION Getters

    // SECTION  Setters
    // INFO Insert a block into the database
    // NOTE Inserting a block is done after the consensus, so that together
    // with the block, we can write the GLS status changes to the chain.
    static async insertBlock(block: Block, operations:Operation[]=[]) {
        // Returns the hash of the block
        // Block() class
        // REVIEW Build the SQL query
        let sql_query =
            "INSERT INTO blocks (content, number, hash, status, proposer, validation_data, timestamp) VALUES " +
            "('" +
            JSON.stringify(block.content) +
            "', " +
            block.number +
            ", " +
            "'" +
            block.hash +
            "', " +
            "'" +
            block.status +
            "', " +
            "'" +
            block.proposer +
            "', " +
            "'" +
            JSON.stringify(block.validation_data) +
            "', " +
            block.timestamp +
            ")"
        // Execute the SQL query
        await this.write(sql_query)
        // Calling the operations of the block on the GLS
        await executeOperations(operations, block)
        return block.hash
    }
    // INFO Generate the genesis block
    static async generateGenesisBlock(genesis_json: any): Promise<string> {
        // TODO Add a type for the block json
        console.log(genesis_json)
        let genesis_block = new Block()
        genesis_block.number = 0
        // Define the genesis transaction
        let genesis_tx = new Transaction()
        genesis_tx.content.type = "genesis"
        genesis_tx.content.data = genesis_json
        genesis_tx.hash = Hashing.sha256(JSON.stringify(genesis_tx.content))
        if (!genesis_json.timestamp) {
            genesis_tx.content.timestamp = Date.now()
        } else {
            genesis_tx.content.timestamp = genesis_json.timestamp
        }
        console.log(genesis_tx)
        // Build a block containing the genesis tx
        genesis_block.timestamp = genesis_tx.content.timestamp
        genesis_block.content.ordered_transactions.push(genesis_tx)
        genesis_block.content.previousHash = "0x0"
        genesis_block.hash = Hashing.sha256(
            JSON.stringify(genesis_block.content),
        )
        // REVIEW Create a GLS Operation and execute it
        let genesis_op: Operation = {
            operator: "genesis",
            actor: null,
            params: genesis_json,
            hash: genesis_block.hash,
            nonce: 0,
            timestamp: genesis_block.timestamp,
            status: true,
            fees: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
            },
        }
        // Insert the genesis block into the database
        console.log(genesis_block)
        return await this.insertBlock(genesis_block, [genesis_op])
    }
    // !SECTION Setters

    // SECTION Specific operations
    // INFO Getting the status of a given address either from the native or the properties table
    static async statusOf(address: string, type: number) {
        // Type can be: 0, 1 (native, properties)
        let field
        if (type == 0) {
            field = "native" // The native table is the one storing the current balance plus the transactions made by the address
        } else if (type == 1) {
            field = "properties" // The properties table is the one enabling smart features
        }
        let query =
            "SELECT * FROM status_" + field + " WHERE address='" + address + "'"
        return await this.read(query)[0]
    } // TODO Implement specific time-saving operations to get specific data (see the tables in the db)
    // INFO Getting the hash of the status at a given block
    static async statusHashAt(block_number: number) {
        let query =
            "SELECT hash FROM status_hashes WHERE block='" + block_number + "'"
        return await this.read(query)[0]
    }
    // !SECTION Specific operations
}

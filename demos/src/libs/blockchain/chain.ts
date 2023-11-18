/* eslint-disable no-unused-vars */
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
            return await db.getDataSource().query(sql_query)
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            console.error(err)
            throw err
        }
    }

    static async write(sql_query: string) {
        try {
            const db = await Datasource.getInstance()
            return await db.getDataSource().query(sql_query)
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            console.error(err)
            throw err
        }
    }

    // SECTION Getters

    // INFO Returns a transaction by its hash
    static async getTxByHash(hash: string): Promise<any> {
        let sql_query =
            "SELECT * FROM transactions WHERE hash = '" + hash + "';"
        let response = await Chain.read(sql_query)
        return response[0]
    }

    // INFO Get the last block number
    static async getLastBlockNumber(): Promise<number> {
        let response = await this.read(
            "SELECT number FROM blocks ORDER BY number DESC LIMIT 1",
        )
        console.log(response)
        return response[0].number
    }
    // INFO Get the last block hash
    static async getLastBlockHash() {
        let response = await this.read(
            "SELECT hash FROM blocks ORDER BY number DESC LIMIT 1",
        )
        return response[0].hash
    }
    // INFO Get any block by its number
    static async getBlockByNumber(number: number): Promise<Block> {
        let response = await this.read(
            "SELECT * FROM blocks WHERE number='" + number + "'",
        )
        return response[0]
    }
    // INFO Get any block by its hash
    static async getBlockByHash(hash: string): Promise<Block> {
        let response = await this.read(
            "SELECT * FROM blocks WHERE hash='" + hash + "'",
        )
        return response[0]
    }
    // INFO Get a group of blocks by their status
    static async getBlockNumbersByStatus(status: string): Promise<number[]> {
        const blocks = await this.read(
            "SELECT number FROM blocks WHERE status=" + status,
        )

        return blocks.map(block => block.number)
    }
    // INFO Get a group of blocks by their proposer
    static async getBlockNumbersByProposer(
        proposer: string,
    ): Promise<number[]> {
        const blocks = await this.read(
            "SELECT number FROM blocks WHERE proposer=" + proposer,
        )
        return blocks.map(block => block.number)
    }

    static async getGenesisBlock(): Promise<Block> {
        // Playground for async testing
        return await this.read("SELECT * FROM blocks WHERE number=0")
    }

    // INFO Get the current pending transactions pool
    static async getPendingPool(): Promise<Transaction[]> {
        return await this.read(
            "SELECT * FROM transactions WHERE status='pending'",
        )
    }

    // ANCHOR Transactions
    static async getTransactionFromHash(hash: string): Promise<Transaction> {
        let tx = await Chain.read(
            "SELECT * FROM transactions WHERE hash = '" + hash + "'",
        )
        // TODO Would be nice to fit it into a Transaction object
        return tx
    }

    // REVIEW Giving back all the properties of an address
    static async getAddressInfo(address: string): Promise<any> {
        let native_state = await Chain.read(
            "SELECT * FROM status_native WHERE address = '" + address + "'",
        )
        native_state = native_state[0] || null
        let properties_state = await Chain.read(
            "SELECT * FROM status_properties WHERE address = '" + address + "'",
        )
        properties_state = properties_state[0] || null
        return {
            native: native_state,
            properties: properties_state,
        }
    }

    static isGenesis(block: Block): boolean {
        // Check if there are any ordered transactions
        if (block.number === 0) {
            return true
        }
    }

    static async getLastBlock(): Promise<Block> {
        const lastBlock = await this.read(
            "SELECT * FROM blocks ORDER BY number DESC LIMIT 1",
        )

        return lastBlock[0]
    }

    static async getOnlinePeersForLastThreeBlocks(): Promise<
        [string, string][]
    > {
        const lastBlockNumber = await this.getLastBlockNumber()

        if (lastBlockNumber < 3) {
            return []
        }

        const blocks = await Promise.all([
            this.getBlockByNumber(lastBlockNumber),
            this.getBlockByNumber(lastBlockNumber - 1),
            this.getBlockByNumber(lastBlockNumber - 2),
        ])

        try {
            return blocks.reduce(
                (commonPeers, block) => {
                    // Extract all data from transactions of type "NODE_ONLINE" in the block
                    const onlinePeersInBlock =
                        block.content.ordered_transactions
                            .filter(
                                transaction =>
                                    transaction.content.type === "NODE_ONLINE",
                            )
                            .map(transaction => transaction.content.data)

                    // Return peers that are present in both commonPeers and onlinePeersInBlock
                    return commonPeers.filter(peer =>
                        onlinePeersInBlock.includes(peer),
                    )
                },
                blocks[0].content.ordered_transactions
                    .filter(
                        transaction =>
                            transaction.content.type === "NODE_ONLINE",
                    )
                    .map(transaction => transaction.content.data),
            )
        } catch (e) {
            return []
        }
    }

    // !SECTION Getters

    // SECTION  Setters
    // INFO Insert a block into the database
    // NOTE Inserting a block is done after the consensus, so that together
    // with the block, we can write the GLS status changes to the chain.
    static async insertBlock(
        block: Block,
        operations: Operation[] = [],
        position: number = null,
    ) {
        // Convert block content and validation data to JSON strings
        const blockContentJson = JSON.stringify(block.content)
        const validationDataJson = JSON.stringify(block.validation_data)

        // Prepare the SQL query
        let sqlQuery = ""
        const queryParams = []

        if (position === null) {
            // If position is not provided, insert a new block
            sqlQuery =
                "INSERT INTO blocks (content, number, hash, status, proposer, validation_data) VALUES (?, ?, ?, ?, ?, ?)"
            queryParams.push(
                blockContentJson,
                block.number,
                block.hash,
                block.status,
                block.proposer,
                validationDataJson,
            )
        } else {
            // If position is provided, update an existing block
            sqlQuery =
                "UPDATE blocks SET content = ?, number = ?, hash = ?, status = ?, proposer = ?, validation_data = ? WHERE number = ?"
            queryParams.push(
                blockContentJson,
                block.number,
                block.hash,
                block.status,
                block.proposer,
                validationDataJson,
                position,
            )
        }

        // Execute the SQL query using parameterized queries
        try {
            const db = await Datasource.getInstance()
            return await db.getDataSource().query(sqlQuery, queryParams)
        } catch (err) {
            console.log("[ChainDB] [ERROR]: " + JSON.stringify(err))
            console.error(err)
            throw err
        }
    }

    // INFO Generate the genesis block
    static async generateGenesisBlock(genesis_data: any): Promise<string> {
        // TODO Add a type for the block json
        console.log(genesis_data)
        let genesis_block = new Block()
        genesis_block.number = 0
        // Define the genesis transaction
        let genesis_tx = new Transaction()
        genesis_tx.content.type = "genesis"
        console.log("genesis_tx.content.data")
        console.log(genesis_tx.content.data)
        genesis_tx.hash = Hashing.sha256(JSON.stringify(genesis_tx.content))
        if (!genesis_data.timestamp) {
            genesis_tx.content.timestamp = Date.now()
        } else {
            genesis_tx.content.timestamp = genesis_data.timestamp
        }
        console.log(genesis_tx)
        // Build a block containing the genesis tx
        genesis_block.content.timestamp = genesis_tx.content.timestamp
        genesis_block.content.ordered_transactions.push(genesis_tx)
        genesis_block.content.previousHash = "0x0"
        genesis_block.hash = Hashing.sha256(
            JSON.stringify(genesis_block.content),
        )
        // REVIEW Create a GLS Operation and execute it
        let genesis_op: Operation = {
            operator: "genesis",
            actor: "DEMOS Network",
            params: JSON.stringify(genesis_block.content),
            hash: genesis_block.hash,
            nonce: 0,
            timestamp: genesis_block.content.timestamp,
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

    // INFO Generates multiple genesis blocks from an array of genesis configurations and inserts them into the chain
    static async generateGenesisBlocks(genesis_jsons: any[]): Promise<string> {
        let compiledBlock = ""
        // TODO
        return compiledBlock
    }

    // INFO Searches all the genesis blocks and returns an artifact representing the current chain genesis
    static async getGenesisUniqueBlock() {
        // TODO
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
    // !SECTION Maintennance operations

    static async pruneBlocksToGenesisBlock() {
        try {
            const query = "DELETE FROM blocks WHERE number > 0"
            await this.write(query)
            console.log("Pruned all blocks except the genesis block.")
        } catch (err) {
            console.error("[pruneUntilGenesis] [ERROR]: " + JSON.stringify(err))
            throw err
        }
    }

    static async nukeGenesis() {
        try {
            const query = "DELETE FROM blocks WHERE number >= 0"
            await this.write(query)
            console.log("Pruned all blocks except the genesis block.")
        } catch (err) {
            console.error("[pruneUntilGenesis] [ERROR]: " + JSON.stringify(err))
            throw err
        }
    }

    static async updateGenesisTimestamp(newTimestamp) {
        try {
            const sqlQuery = `UPDATE blocks SET content = JSON_SET(content, ${newTimestamp}, ?) WHERE number = 0`
            await this.write(sqlQuery)
            console.log("Updated the timestamp of the genesis block.")
        } catch (err) {
            console.error(
                "[updateGenesisTimestamp] [ERROR]: " + JSON.stringify(err),
            )
            throw err
        }
    }
}

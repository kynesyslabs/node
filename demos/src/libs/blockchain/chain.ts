import Block from "./blocks"
import Transaction from "./transaction"
import Hashing from "../crypto/hashing"
import Cryptography from "../crypto/cryptography"
import Datasource from "src/model/datasource"
import forge, { pki } from "node-forge"

export default class Chain {
    static async read(sql_query: string) {
        try {
            const db = await Datasource.getInstance()
            const result = await db.getDataSource().query(sql_query)

            console.log("[ChainDB] [ READ ]: ")
            console.log(result)
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
            console.log("[ChainDB] [ WRITE ]: " + result)
            return result
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            throw err
        }
    }

    // ANCHOR Getters
    // INFO Get the last block number
    static async getLastBlockNumber() {
        return await this.read(
            "SELECT number FROM blocks ORDER BY number DESC LIMIT 1",
        )[0]
    }
    // INFO Get the last block hash
    static async getLastBlockHash() {
        return await this.read(
            "SELECT hash FROM blocks ORDER BY number DESC LIMIT 1",
        )[0]
    }
    // INFO Get any block by its number
    static async getBlockByNumber(number: number) {
        return await this.read(
            "SELECT * FROM blocks WHERE number='" + number + "'",
        )[0]
    }
    // INFO Get any block by its hash
    static async getBlockByHash(hash: string) {
        return await this.read("SELECT * FROM blocks WHERE hash=" + hash)[0]
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
        console.log("=== AFTER GET ===")
        console.log(_res) // FIXME Here dirit is undefined AND it is before the awaited result
        return _res
    }

    // INFO Get the current pending transactions pool
    static async getPendingPool() {
        return await this.read(
            "SELECT * FROM transactions WHERE status='pending'",
        )
    }
    // INFO GLS Related methods
    static async getGLSStatusHashTable() {
        return await this.read("SELECT * FROM status_hashes")
    }

    static async getGLSStatusNativeTable() {
        return await this.read("SELECT * FROM status_native")
    }
    static async getGLSStatusPropertiesTable() {
        return await this.read("SELECT * FROM status_properties")
    }
    static async getGLSLastHash() {
        return await this.read(
            "SELECT hash FROM status_hashes ORDER BY id DESC LIMIT 1",
        )[0]
    }
    static async getGLSNativeFor(address: string) {
        return await this.read(
            "SELECT * FROM status_native WHERE address='" + address + "'",
        )[0]
    }
    static async getGLSPropertiesFor(address: string) {
        return await this.read(
            "SELECT * FROM status_properties WHERE address='" + address + "'",
        )
    }
    // TODO Implement the rest of the db schema for the chain
    // ANCHOR Setters
    // INFO Insert a block into the database
    static async insertBlock(block: Block) {
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
        return block.hash
    }
    // INFO Generate the genesis block
    static generateGenesisBlock(genesis_json: any) {
        // TODO Add a type for the block json
        console.log(genesis_json)
        let genesis_block = new Block()
        genesis_block.number = 0
        // Define the genesis transaction
        let genesis_tx = new Transaction()
        genesis_tx.content.type = "genesis"
        genesis_tx.content.data = genesis_json
        genesis_tx.hash = Hashing.sha256(JSON.stringify(genesis_tx.content))
        // Build a block containing the genesis tx
        genesis_block.content.transactions.push(genesis_tx)
        genesis_block.content.previousHash = "0x0"
        genesis_block.hash = Hashing.sha256(
            JSON.stringify(genesis_block.content),
        )
        // Insert the genesis block into the database
        return this.insertBlock(genesis_block)
    }
    // ANCHOR Macro
    // ANCHOR Specific operations
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
    // TODO And more
}

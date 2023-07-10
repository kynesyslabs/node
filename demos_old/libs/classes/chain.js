/* INFO
	The chain.js module defines classes and methods to act on the blockchain.
	It defines Transaction and Block classes as well as chainDB class representing the blockchain
	as read from the database.
	All the methods required to write, validate and operate on the blockchain are defined here.
*/

const sha256 = require("sha256")
const db = require("../../model/database.js")
// Use the connection

// NOTE Transaction class
class Transaction {
    constructor() {
        this.content = {
            type: null,
            from: null,
            to: null,
            amount: null,
            data: null,
        }
        this.signature = null
        this.hash = null
        this.confirmations = null
        // REVIEW Should we add state changes?
        this.state_changes = {}
    }

    // ANCHOR Getters

    // ANCHOR Setters
}

// NOTE Block class
class Block {
    constructor() {
        this.number = null
        this.hash = null // Calculated on the content
        this.status = null
        this.content = {
            transactions: [],
            web2data: {}, // objects containing hashes of fetched web2data
            previousHash: null,
        }
        this.proposer = null
        this.validation_data = null
        this.timestamp = null
    }

    // ANCHOR Getters

    // ANCHOR Setters
}

// NOTE Class for the chain database
class ChainDB {
    constructor() {}

    async read(sql_query) {
        try {
            console.log("=== DB READ ===")
            const result = await db.getDataSource().query(sql_query)
            console.log("=== GET RESULT ===")
            console.log("[ChainDB] [ READ ]: ")
            console.log(result)
            return result
        } catch (err) {
            console.log("[ChainDB] [ ERROR ]: " + JSON.stringify(err))
            throw err
        }
    }

    async write(sql_query) {
        try {
            console.log(db.getDataSource())
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
    async getLastBlockNumber() {
        const blocks = await this.read(
            "SELECT number FROM blocks ORDER BY number DESC LIMIT 1",
        )
        console.log("Blocks: getLastblockNumber")
        console.log(blocks)
        return blocks[0]
    }
    // INFO Get the last block hash
    async getLastBlockHash() {
        return await this.read(
            "SELECT hash FROM blocks ORDER BY number DESC LIMIT 1",
        )[0]
    }
    // INFO Get any block by its number
    async getBlockByNumber(number) {
        return await this.read(
            "SELECT * FROM blocks WHERE number='" + number + "'",
        )[0]
    }
    // INFO Get any block by its hash
    async getBlockByHash(hash) {
        return await this.read("SELECT * FROM blocks WHERE hash=" + hash)[0]
    }
    // INFO Get a group of blocks by their status
    async getBlockNumbersByStatus(status) {
        return await this.read(
            "SELECT number FROM blocks WHERE status=" + status,
        )
    }
    // INFO Get a group of blocks by their proposer
    async getBlockNumbersByProposer(proposer) {
        return await this.read(
            "SELECT number FROM blocks WHERE proposer=" + proposer,
        )
    }

    async getGenesisBlock() {
        // Playground for async testing
        let _res = await this.read("SELECT * FROM blocks WHERE number=0")
        console.log("=== AFTER GET ===")
        console.log(_res) // FIXME Here dirit is undefined AND it is before the awaited result
        return _res
    }

    /*
    // INFO Get the genesis block that initialized the current chain
    getGenesisBlock() {
        let _promise = this.read("SELECT * FROM blocks WHERE number=0")
        return _promise[Object.keys(_promise)[0]]
    }
    */

    // INFO Get the current pending transactions pool
    async getPendingPool() {
        return await this.read(
            "SELECT * FROM transactions WHERE status='pending'",
        )
    }
    // INFO GLS Related methods
    async getGLSStatusHashTable() {
        return await this.read("SELECT * FROM status_hashes")
    }
    async getGLSStatusNativeTable() {
        return await this.read("SELECT * FROM status_native")
    }
    async getGLSStatusPropertiesTable() {
        return await this.read("SELECT * FROM status_properties")
    }
    async getGLSLastHash() {
        return await this.read(
            "SELECT hash FROM status_hashes ORDER BY id DESC LIMIT 1",
        )[0]
    }
    async getGLSNativeFor(address) {
        return await this.read(
            "SELECT * FROM status_native WHERE address='" + address + "'",
        )[0]
    }
    async getGLSPropertiesFor(address) {
        return await this.read(
            "SELECT * FROM status_properties WHERE address='" + address + "'",
        )
    }
    // TODO Implement the rest of the db schema for the chain
    // ANCHOR Setters
    // INFO Insert a block into the database
    async insertBlock(block) {
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
    generateGenesisBlock(genesis_json) {
        console.log(genesis_json)
        let genesis_block = new Block()
        genesis_block.number = 0
        // Define the genesis transaction
        let genesis_tx = new Transaction()
        genesis_tx.content.type = "genesis"
        genesis_tx.content.data = genesis_json
        genesis_tx.hash = sha256(JSON.stringify(genesis_tx.content))
        // Build a block containing the genesis tx
        genesis_block.content.transactions.push(genesis_tx)
        genesis_block.content.previousHash = 0x0
        genesis_block.hash = sha256(JSON.stringify(genesis_block.content))
        // Insert the genesis block into the database
        return this.insertBlock(genesis_block)
    }
    // ANCHOR Macro
    // ANCHOR Specific operations
    // INFO Getting the status of a given address either from the native or the properties table
    async statusOf(address, type) {
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
    async statusHashAt(block_number) {
        let query =
            "SELECT hash FROM status_hashes WHERE block='" + block_number + "'"
        return await this.read(query)[0]
    }
    // TODO And more
}

module.exports = { ChainDB, Block, Transaction }

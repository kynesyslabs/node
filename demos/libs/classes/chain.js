/* INFO
	The chain.js module defines classes and methods to act on the blockchain.
	It defines Transaction and Block classes as well as chainDB class representing the blockchain
	as read from the database.
	All the methods required to write, validate and operate on the blockchain are defined here.
*/

const sqlite3 = require("sqlite3").verbose()
const sha256 = require("sha256")

// NOTE Transaction class
class Transaction {
	constructor() {
		(this.content = {
			type: null,
			from: null,
			to: null,
			amount: null,
			data: null,
		}),
		(this.signature = null),
		(this.hash = null),
		(this.confirmations = null)
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
	constructor() {
		this.connection = null
	}

	// create connection
	createConnection() {
		// ...
	}
	
	// close connection
	closeConnection() {
		// ...
	}
	read(sql_query) {
		let result = []
		this.connection = new sqlite3.Database("./data/chain.db", (err) => {
			if (err) {
				console.error(err.message)
			}
			console.log("Connected to the ChainDB database.")
		})
		console.log("[CHAIN READ] Executing " + sql_query)
		this.connection.each(sql_query, [], (err, row) => {
			if (err) {
				return []
			}
			console.log(row)
			result.push(row)
		})
		this.connection.close()
		console.log("[CHAIN READ] Result: " + result)
		return result
	}
	write(sql_query) {
		console.log("[CHAIN WRITE] Executing: " + sql_query)
		this.connection = new sqlite3.Database("./data/chain.db", (err) => {
			if (err) {
				console.error(err.message)
			}
			console.log("[CHAIN WRITE] Connected to the ChainDB database.")
		})
		this.connection.run(sql_query, (err) => {
			if (err) {
				console.error(err.message)
				return false
			}
			console.log("[CHAIN WRITE] Executed")
			return true
		})
		this.connection.close()
	}
	// ANCHOR Getters
	// INFO Get the last block number
	getLastBlockNumber() {
		return this.read("SELECT number FROM blocks ORDER BY id DESC LIMIT 1")[0]
	}
	// INFO Get the last block hash
	getLastBlockHash() {
		return this.read("SELECT hash FROM blocks ORDER BY id DESC LIMIT 1")[0]
	}
	// INFO Get any block by its number
	getBlockByNumber(number) {
		return this.read("SELECT * FROM blocks WHERE number='" + number + "'")[0]
	}
	// INFO Get any block by its hash
	getBlockByHash(hash) {
		return this.read("SELECT * FROM blocks WHERE hash=" + hash)[0]
	}
	// INFO Get a group of blocks by their status
	getBlockNumbersByStatus(status) {
		return this.read("SELECT number FROM blocks WHERE status=" + status)
	}
	// INFO Get a group of blocks by their proposer
	getBlockNumbersByProposer(proposer) {
		return this.read("SELECT number FROM blocks WHERE proposer=" + proposer)
	}
	// INFO Get the genesis block that initialized the current chain
	getGenesisBlock() {
		return this.read("SELECT * FROM blocks WHERE number=0")[0]
	}
	// INFO Get the current pending transactions pool
	getPendingPool() {
		return this.read("SELECT * FROM transactions WHERE status='pending'")
	}
	// INFO GLS Related methods
	getGLSStatusHashTable() {
		return this.read("SELECT * FROM status_hashes")
	}
	getGLSStatusNativeTable() {
		return this.read("SELECT * FROM status_native")
    }
	getGLSStatusPropertiesTable() {
		return this.read("SELECT * FROM status_properties")
    }
	getGLSLastHash() {
		return this.read("SELECT hash FROM status_hashes ORDER BY id DESC LIMIT 1")[0]
	}
	getGLSNativeFor(address) {
		return this.read("SELECT * FROM status_native WHERE address='" + address + "'")[0]
    }
	getGLSPropertiesFor(address) {
        return this.read("SELECT * FROM status_properties WHERE address='" + address + "'")
    }
	// TODO Implement the rest of the db schema for the chain
	// ANCHOR Setters
	// INFO Insert a block into the database
	insertBlock(block) {
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
		this.write(sql_query)
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
	statusOf(address, type) {
		// Type can be: 0, 1 (native, properties)
		let field;
		if (type == 0) {
			field = "native" // The native table is the one storing the current balance plus the transactions made by the address
		} else if (type == 1) {
			field = "properties" // The properties table is the one enabling smart features
        } 
		let query = "SELECT * FROM status_" + field + " WHERE address='" + address + "'"
		return this.read(query)[0]
	} // TODO Implement specific time-saving operations to get specific data (see the tables in the db)
	// INFO Getting the hash of the status at a given block
	statusHashAt(block_number) {
		let query = "SELECT hash FROM status_hashes WHERE block='" + block_number + "'"
        return this.read(query)[0]
	}
	// TODO And more
}

module.exports = { ChainDB, Block, Transaction }

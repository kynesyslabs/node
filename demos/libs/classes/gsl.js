// INFO Object that will be filled with the Global State Layer data and methods
// ANCHOR Loading the chain db library to interact with the blockchain
const { ChainDB, Block, Transaction } = require("./libs/classes/chain.js")
let chainDB = new ChainDB()

/* NOTE About the Global State Layer data structure
 * The GLS is composed of three tables:
 * 1. Status Hash Table; contains the progressive hashes of the status taken at each epoch
 * 2. Status Native Table; contains the current balance and last tx of each address
 * 3. Status Properties Table; contains the data needed to allow smart features (tokens, nfts, custom properties...)
*/

/* This class basically wraps chainDB class by exposing in a convenient way only the methods that are needed for the GLS */

class GLS {
	constructor() {
		// Representation of the GLS
		this.statusHashTable = []
		this.statusNativeTable = []
		this.statusPropertiesTable = []
	}
	// INFO Getters
	StatusHashTable() {
		this.statusHashTable = chainDB.getGLSStatusHashTable()
        return this.statusHashTable
    }
	StatusNativeTable() {
		this.statusNativeTable = chainDB.getGLSStatusNativeTable()
        return this.statusNativeTable
    }
	StatusPropertiesTable() {
		this.statusPropertiesTable = chainDB.getGLSStatusPropertiesTable()
        return this.statusPropertiesTable
    }
	StatusLastHash() {
		return chainDB.getGLSLastHash()
	}
	StatusNativeFor(address) {
		return chainDB.getGLSNativeFor(address)
	}
	StatusPropertiesFor(address) {
        return chainDB.getGLSPropertiesFor(address)
    }
	// INFO Setters
	// TODO Add methods
}

module.exports = GLS
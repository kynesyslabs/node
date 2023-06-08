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

class GLS {
	constructor() {
		// TODO
	}
	// TODO Add methods
}

module.exports = GLS
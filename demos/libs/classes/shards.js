// INFO Managing the Adaptive Collaborative Sharding through the appropriate object
// REVIEW Experimental air module

// INFO Getting the TRNG
var TRNG = require("./random.js")
let trng = TRNG.new()
// ANCHOR Loading the chain db library to interact with the blockchain
const { ChainDB, Block, Transaction } = require("./libs/classes/chain.js")
let chainDB = new ChainDB()

// TODO Expand and implement
class Shard {
	constructor(_checksum, _pendingTxs, _partecipants) {
		this.checksum = _checksum // The id of the shard (the hash of the shard)
		this.txs = {
			pending: _pendingTxs, // The list of pending transactions
			confirmed: [], // The list of confirmed transactions
		}
		this.partecipants = _partecipants
	}
	getCurrentEntropy() {
		return trng.getCurrentEntropy()
	}
	getDeterminedRandom() {
		return trng.new()
	}
	determineParticipants() {
		// TODO First we decide how many participants are needed for each shard based on the total number of participants vs the total number of transactions
		let _partecipants = []
		// Getting the mempool
		let _pendingTxs = chainDB.getPendingPool()
		let _pendingNumber = _pendingTxs.length
		// TODO Getting the peerlist
		// TODO Then we generate the list of participants based on the number of participants and the number of transactions using trng.newBetween(0, n)
		this.partecipants = _partecipants
	}
}


module.exports = Shard
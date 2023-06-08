// INFO Managing the Adaptive Collaborative Sharding through the appropriate object
// REVIEW Experimental air module

// INFO Getting the TRNG
var TRNG = require("./random.js")
let trng = TRNG.new()

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
}


module.exports = Shard
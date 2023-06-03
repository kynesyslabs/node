// INFO Managing the Adaptive Collaborative Sharding through the appropriate object
// REVIEW Experimental air module

// INFO Getting the TRNG
var TRNG = require("./random.js")

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
		return TRNG.getCurrentEntropy()
	}
	getDeterminedRandom() {
		return TRNG.new()
	}
}


module.exports = Shard
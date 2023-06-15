// INFO This library contains useful methods that are used to manage peers and handle them easily

// ANCHOR Variables initialized on import
// INFO This is the list of peers that the node knows
var peerlist = []

class Peer {
	constructor() {
		this.connection_string = null // The connection string of the peer
		this.socket = null // A socket object (as the old 'peer' one)
		this.identity = "placeholder" // The identity of the peer (public key)
	}
	// Methods
	// INFO Set the connection string of the peer
	setConnectionString(_connection_string) {
		this.connection_string = _connection_string
	}
	// INFO Set the socket of the peer
	setSocket(_socket) {
		this.socket = _socket
	}
	// INFO Set the identity of the peer
	setIdentity(_identity) {
		this.identity = _identity
	}
}


var methods = {
	// INFO Method to get the list of peers
	getPeers() {
		return peerlist
	},
	// INFO Method to add a new peer object to the list
	addPeer: async function (peer) { // is a Peer object
		peerlist.push(peer)
	},
	// INFO Method to remove a peer from the list (need the whole Peer object) // TODO Refine this
	removePeer: async function (peer) {
		let index = peerlist.indexOf(peer)
		if (index > -1) {
			peerlist.splice(index, 1)
		}
	},
	// INFO Wildcard method to manipulate the peerlist (unsafe and should not be used)
	setPeerlist: async function (_peerlist) {
        peerlist = _peerlist
    }
}

// FIXME Don't export peerlist, we access it directly with the methods
module.exports = { methods, peerlist, Peer }
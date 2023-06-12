// INFO This module contains methods and structures that enable an high level user friendly communication between nodes
var identity = require ('libs/identity.js');
const sha256 = require('sha256');

/* NOTE References to objects used in this module
 * peers objects are defined in libs/peers.js
 * peers.methods is used to access and work on the peers environment
 * messages are defined in libs/messages.js and must be compliant to emptyMessage skeleton
*/

// SECTION Broadcasts
var broadcast = {
	broadcastMessage: {
		toAllPeers: broadcastMessageToAllPeers,
		toPeer: broadcastMessageToPeer
	}
}

// INFO Broadcasts a message to all peers
// Peerlist is taken by the peers.js module
function broadcastMessageToAllPeers(message) {
	let peerlist = peers.methods.getPeers();
	// TODO
}

// INFO Broadcasts a message to a specific peer
// peer must be a Peer like object
function broadcastMessageToPeer(message, peer) {
    // TODO
}
// !SECTION Broadcasts

// SECTION ComLink (communication system)
// NOTE Each ComLink object contains a message and its request-reply chain so that each communication can be done keeping track of the request-reply chain
class ComLink {
	constructor() {
        this.chain = {
			current: {
				currentMessage: null, // must be a emptyMessage like object (see libs/messages.js)
				replyToHash: null, // is either null or the hash of the last message in the chain
				previousHashes: [] // Keep track of the previous hashes to have full integrity
			},
			currentMessageHash: null, // is the hashed version of .current
		}
    }
	// TODO Add and complete methods as specified
	setMessage(message) {
		this.chain.current.currentMessage = message;
	}
	hashCurrent() {
		let stringifiedMessage = JSON.stringify(this.chain.current);
		return sha256(stringifiedMessage);
	}
	setReplyToHash(replyToHash) {
		this.chain.current.replyToHash = replyToHash;
    }
	previousHashes(){
		return this.chain.current.previousHashes;
	}
	setPreviousHashes(previousHashes) {
		this.chain.current.previousHashes = previousHashes;
	}
}
// !SECTION Comlink

module.exports = { broadcast, ComLink }
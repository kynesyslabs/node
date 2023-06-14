// INFO This module contains methods and structures that enable an high level user friendly communication between nodes
var identity = require ('libs/identity.js');
const sha256 = require('sha256');

/* Workflow
 * Let's say main.js want to send a message to all other nodes
 * We want to send a message to all other nodes and listen for replies
 * We first create the message with messages.js
 * Then we use broadcast.broadcastMessage.toAllPeers to send the message to all other nodes specifying a callback function
 * The broadcast.broadcastMessage.toPeer that is called by the above method takes care of setting up the listener with the callback provided
*/

/* NOTE References to objects used in this module
 * peers objects are defined in libs/peers.j
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
// type is a string like "public" or "transactions" as defined in network.js
function broadcastMessageToAllPeers(type, message, peerlist, callback) {
	let references = [];
	for (let i = 0; i < peerlist.length; i++) {
		let _ref = broadcastMessageToPeer(type, message, peerlist[i], callback);
		references.push(_ref);
	}
	return references;
}

// INFO Broadcasts a message to a specific peer
// peer must be a Peer like object
function broadcastMessageToPeer(type, message, peer, callback) {
	let _socket = peer.socket;
	// TODO Sanitize message and type
	if (_socket) {
		// Setting up the listener to receive the response
		// NOTE We do this before sending the message so that we are able to listen for replies immediately
		// TODO Keep track of the listeners and destroy them at need
		_socket.on(type, 
			function(message) {
				// Catching messages that are sent to this peer for this specific message muid (same type, same muid = reply)
				if (message.muid === muid) {
					let reply = await callback(message);
					return [true, reply];
				}
			});
		// Emititng the message
        _socket.emit(type, message);
		return [true, type, message.muid];
    }
	return [false, type, "Invalid peer"];
}

// !SECTION Broadcasts

// TODO Rewrite the above methods to be compliant or included in a ComLink class
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
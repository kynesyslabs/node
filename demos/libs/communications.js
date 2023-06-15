// INFO This module contains methods and structures that enable an high level user friendly communication between nodes
var identity = require ('./identity.js');
const sha256 = require('sha256');

/* Workflow
 * Let's say main.js want to send a message to all other nodes
 * We want to send a message to all other nodes and listen for replies
 * We first create the message with messages.js
 * Then we use broadcast.broadcastMessage.toAllPeers to send the message to all other nodes specifying a callback function and the private key
 * The above method will create a ComLink object for the message and send it to all other nodes using its internal method
 * Validity is ensured by verifying the signature of the comLink.current object (if is not the first message in the chain)
 * comLink.current.replyToHash is the hash of the last message in the chain so that we can verify the integrity of the message too
 * comLink.previousHashesh is the list of hashes of all previous messages in the chain so that we can verify the integrity of the communication
*/

/* NOTE References to objects used in this module
 * peers objects are defined in libs/peers.js
 * messages are defined in libs/messages.js and must be compliant to emptyMessage skeleton
*/

// SECTION Broadcasts
var broadcast = {
	broadcastMessage: {
		toAllPeers: broadcastMessageToAllPeers
	}
}

// INFO Broadcasts a message to all peers
// type is a string like "public" or "transactions" as defined in network.js
function broadcastMessageToAllPeers(message, peerlist, callback) {
	let references = [];
	for (let i = 0; i < peerlist.length; i++) {
		// Creating a new ComLink object for the broadcasted message so that we can listen for replies
		let _comlink = new ComLink();
		let result = _comlink.broadcastMessageToPeer(message, callback);
		if (result[0]) references.push(_comlink); else references.push(false)
	}
	return references;
}
// !SECTION Broadcasts

// TODO Rewrite the above methods to be compliant or included in a ComLink class
// SECTION ComLink (communication system)
// NOTE Each ComLink object contains a message and its request-reply chain so that each communication can be done keeping track of the request-reply chain
class ComLink {
	constructor() {
		this.peer = null // The peer we are communicating with
        this.chain = {
			current: {
				currentMessage: null, // must be a emptyMessage like object (see libs/messages.js)
				replyToHash: null, // is either null or the hash of the last message in the chain
				previousHashes: [] // Keep track of the previous hashes to have full integrity
			},
			currentMessageHash: null, // is the hashed version of .current
		}
    }
	// INFO Broadcast method
	async broadcastMessageToPeer(message, callback, privateKey) {
		let _socket = this.peer.socket;
		// REVIEW Sanitize message and type
		if (!message.type || !message.muid) return [false, "Invalid message"];
		if (_socket) {
			// Setting up the listener to receive the response
			// NOTE We do this before sending the message so that we are able to listen for replies immediately
			// TODO Keep track of the listeners and destroy them at need
			_socket.on(message.type, 
				async function(message) {
					// Catching messages that are sent to this peer for this specific message muid (same type, same muid = reply)
					if (message.muid === muid) {
						let reply = callback(message);
						return [true, reply];
					}
				});
			// Setting the current message as the head of the chain
			this.setMessage(message);
			// Hashing the message for integrity
			this.setReplyToHash(this.hashCurrentMessage());
			// Updating previous hashesh with the hash of the current object (message + hash)
			let _previousHashes = this.previousHashes();
			let _currentHash = this.signCurrent(privateKey)
			_previousHashes.push(_currentHash);
			this.setPreviousHashes(_previousHashes);
			// Emitting the message
			_socket.emit("comLink", this) // REVIEW Rewriting this using comlink
			_socket.emit(message.type, message); // TODO Delete this previous version
			return [true, message.muid];
		}
		return [false, "Invalid peer"];
	}
	// TODO Add and complete methods as specified
	setMessage(message) {
		this.chain.current.currentMessage = message;
	}
	async signCurrent(privateKey) {
		let stringifiedMessage = JSON.stringify(this.chain.current);
		let _signature = await identity.generate.ecdsa.sign(stringifiedMessage, privateKey);
	}
	hashCurrentMessage() {
		let stringifiedMessage = JSON.stringify(this.chain.current.currentMessage);
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
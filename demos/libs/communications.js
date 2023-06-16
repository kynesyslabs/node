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
        this.chain = {
			current: {
				currentMessage: null, // must be a emptyMessage like object (see libs/messages.js)
				currentMessageHash: null, // is either null or the hash of the last message in the chain
				previousHashes: [] // Keep track of the previous hashes to have full integrity
			},
			comlinkCurrentHash: null, // is the hashed version of .current
			comlinkCurrentHashSignature: null, // is the signature of the hashed version of.current
		}
    }
	// INFO Method to hash and sign the current iteration of the message
	async hashAndSignCurrent(privateKey) {
		let stringifiedMessage = JSON.stringify(this.chain.current);
        this.chain.comlinkCurrentHash = sha256(stringifiedMessage);
		let _signature = await identity.generate.ecdsa.sign(this.chain.comlinkCurrentHash, privateKey);
		this.chain.comlinkCurrentHashSignature = _signature;
    }
	// INFO Prepare and send the (usually) first message in the chain
	async broadcastMessageToPeer(_peer, message, privateKey) {
		// REVIEW Sanitize message and type
		if (!message.content.type || !message.content.muid) {
			console.log("[COMMUNICATIONS] Invalid message")
			return [false, "Invalid message"]
		}
		if (_peer.socket) {
			console.log("[COMMUNICATIONS] Sending message to peer " + _peer.socket.id);
			// NOTE Setting up the listener to receive the response is useless as we use general listeners
			// Setting the current message as the head of the chain
			this.chain.current.currentMessage = JSON.stringify(message.content);
			// Hashing the message for integrity
			this.chain.current.currentMessageHash = message.hash;
			await this.hashAndSignCurrent(privateKey);
			// TODO Manage previous hashesh
			// Emitting the message
			let result = await this.broadcastToPeer(_peer)
			return result;
		}
		console.log("[COMMUNICATIONS] Invalid peer"); 
		return [false, "Invalid peer"];
	}
	// INFO Prepare and send a reply to the last message in the chain
	async replyToMessage(peer, reply) { // NOTE: Reply must be a valid message like object (see libs/messages.js)
		// TODO Do the cryptography here, fill the ComLink with the new parameters, save the previous hashesh and this.broadcastToPeer
	}
	// INFO Broadcast a ComLink object to a peer (usually called by the above methods)
	async broadcastToPeer(peer) {
		let _socket = peer.socket
		console.log("[COMMUNICATIONS] Sending message to peer");
		_socket.emit("comlink", this) // REVIEW Rewriting this using comlink
		return [true, this.chain.current.currentMessage.muid];
	}
}
// !SECTION Comlink

module.exports = { broadcast, ComLink }
// INFO This module contains methods and structures that enable an high level user friendly communication between nodes
var identity = require ('libs/identity.js');
const sha256 = require('sha256');

/* Workflow
 * Let's say main.js want to send a message to all other nodes
 * We want to send a message to all other nodes and listen for replies
 * We first create the message with messages.js
 * Then we use broadcast.broadcastMessage.toAllPeers to send the message to all other nodes
 * We then iterate through the references and call broadcast.listenForReply to listen for replies 
 *	(given references[n][0] is true and using references[n][1] and references[n][2] as parameters)
 * This way we can specify what happens when we got the reply of that specific message (using the muid as reference)
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
	},
	listenForReply: listenForReply
}

// INFO Broadcasts a message to all peers
// type is a string like "public" or "transactions" as defined in network.js
function broadcastMessageToAllPeers(type, message, peerlist) {
	let references = [];
	for (let i = 0; i < peerlist.length; i++) {
		let _ref = broadcastMessageToPeer(type, message, peerlist[i]);
		references.push(_ref);
	}
	return references;
}

// INFO Broadcasts a message to a specific peer
// peer must be a Peer like object
function broadcastMessageToPeer(type, message, peer) {
	let _socket = peer.socket;
	if (_socket) {
        _socket.emit(type, message);
		// Listen back for messages sent to this peer is made using type and muid and the below method
		return [true, type, message.muid];
    }
	return [false, type, "Invalid peer"];
}

// INFO Listen for replies given a muid
async function listenForReply(type, muid, callback) {
	let _socket = this.peers[muid].socket;
    if (_socket) {
        _socket.on(type, 
			function(message) {
				// Catching messages that are sent to this peer for this specific message muid (same type, same muid = reply)
                if (message.muid === muid) {
					let reply = await callback(message);
					return [true, reply];
				}
            });
    }
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
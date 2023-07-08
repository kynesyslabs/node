/* eslint-disable no-unreachable */
// INFO This module contains methods and structures that enable an high level user friendly communication between nodes
var identity = require("./identity.js")
const sha256 = require("sha256")

/* Workflow
 * Let's say main.js want to send a message to all other nodes
 * We want to send a message to all other nodes and listen for replies
 * We first create the message with messages.js
 * Then we use broadcast.broadcastMessage.toAllPeers to send the message to all other nodes specifying a callback function and the private key
 * The above method will create a ComLink object for the message and send it to all other nodes using its internal method
 * Validity is ensured by verifying the signature of the comLink.current object (if is not the first message in the chain)
 * comLink.current.replyToHash is the hash of the last message in the chain so that we can verify the integrity of the message too
 * comLink.previousHashesh is the list of hashes of all previous messages in the chain so that we can verify the integrity of the communication
 *
 * HOW TO WAIT FOR A RESPONSE
 * When a ComLink object has a required_reply property set to true, then you can use the responseRegistry (see main.js) and its methods to
 * request, wait and check if a response has been received.
 * On "comlink" listener, if comlink.muid exists in the registry, then the response will be stored in the registry with the appropriate method
 */

/* NOTE References to objects used in this module
 * peers objects are defined in libs/peers.js
 * messages are defined in libs/messages.js and must be compliant to emptyMessage skeleton
 */

// SECTION Response registry
// INFO If a ComLink object has required_reply property set to true, then the response will be stored in the registry
class ResponseRegistry {
    constructor() {
        this.list = {} // NOTE Each ComLink.muid can be used as a key in this object so that we can track if a response has already been received
    }
    // INFO Register a response request
    // NOTE comlink must be a ComLink object
    requestResponse(comlink) {
        if (!comlink.properties.require_reply)
            return [
                false,
                "ComLink object must have required_reply property set to true",
            ]
        if (this.list[comlink.muid])
            return [false, "Response has already been requested"]
        this.list[comlink.muid] = {
            comlink: comlink,
            timestamp: Date.now(),
            response: {
                message: null, // REVIEW must be a emptyMessage like object (see libs/messages.js)
                timestamp: null, // Set to now once received
            },
        }
        return [true, this.list[comlink.muid]]
    }
    // INFO Check if a response has been received
    // NOTE comlink must be a ComLink object
    hasResponse(comlink) {
        if (!this.list[comlink.muid])
            return [false, "No response has been requested"]
        if (!this.list[comlink.muid].response)
            return [false, "No response has been received"]
        return [true, this.list[comlink.muid].response]
    }
    // INFO Register a response received
    // NOTE message must be a emptyMessage like object, comlink must be a ComLink object
    registerResponse(message, comlink) {
        if (!comlink.properties.require_reply)
            return [
                false,
                "ComLink object must have required_reply property set to true",
            ]
        if (!this.list[comlink.muid])
            return [false, "No response has been requested"]
        this.list[comlink.muid].response.message = message
        this.list[comlink.muid].response.timestamp = Date.now()
        return [true, this.list[comlink.muid]]
    }
}
// TODO Add a method to cycle through the registry to check if a response has been received and "block" the calling function if not (with a timeout possilby)
// !SECTION Response registry

// SECTION Broadcasts
var broadcast = {
    broadcastMessage: {
        toAllPeers: broadcastMessageToAllPeers,
    },
}

// INFO Broadcasts a message to all peers
// type is a string like "public" or "transactions" as defined in network.js
function broadcastMessageToAllPeers(message, peerlist, callback) {
    let references = []
    for (let i = 0; i < peerlist.length; i++) {
        // Creating a new ComLink object for the broadcasted message so that we can listen for replies
        let _comlink = new ComLink()
        let result = _comlink.broadcastMessageToPeer(message, callback)
        if (result[0]) references.push(_comlink)
        else references.push(false)
    }
    return references
}
// !SECTION Broadcasts

// SECTION ComLink (communication system)
// NOTE Each ComLink object contains a message and its request-reply chain so that each communication can be done keeping track of the request-reply chain
class ComLink {
    constructor() {
        this.chain = {
            current: {
                currentMessage: null, // must be a emptyMessage.bundle like object (see libs/messages.js)
                currentMessageHash: null, // TODO Eliminate as is in current message is either null or the hash of the last message in the chain
                previousHashes: [], // Keep track of the previous hashes to have full integrity
            },
            comlinkCurrentHash: null, // is the hashed version of .current
            comlinkCurrentHashSignature: null, // is the signature of the hashed version of.current
        }
        this.muid = this.generateMuid()
        this.properties = {
            require_reply: false,
            is_reply: false,
        }
    }
    // INFO Muid generator
    generateMuid() {
        if (!this.muid) {
            let number_1 =
                Math.random().toString(36).substring(2, 15) +
                Math.random().toString(36).substring(2, 15)
            let number_2 =
                Math.random().toString(36).substring(2, 15) +
                Math.random().toString(36).substring(2, 15)
            this.muid = number_1 + number_2
        }
        return this.muid
    }
    // INFO Method to hash and sign the current iteration of the message
    async hashAndSignCurrent(privateKey) {
        let stringifiedMessage = JSON.stringify(this.chain.current)
        this.chain.comlinkCurrentHash = sha256(stringifiedMessage)
        let _signature = await identity.cryptography.sign(
            this.chain.comlinkCurrentHash,
            privateKey,
        )
        this.chain.comlinkCurrentHashSignature = _signature
    }
    // INFO Prepare and send the (usually) first message in the chain
    async broadcastMessageToPeer(_peer, message, privateKey) {
        // REVIEW Sanitize message and type
        if (!message.content.type) {
            console.log("[COMMUNICATIONS] Invalid message")
            return [false, "Invalid message"]
        }
        if (_peer.socket) {
            console.log(
                "[COMMUNICATIONS] Sending message to peer " + _peer.socket.id,
            )
            // NOTE Setting up the listener to receive the response is useless as we use general listeners
            // Setting the current message as the head of the chain
            this.chain.current.currentMessage = JSON.stringify(message)
            // Hashing the message for integrity
            this.chain.current.currentMessageHash = message.hash
            await this.hashAndSignCurrent(privateKey)
            // Emitting the message
            let result = await this.broadcastToPeer(_peer)
            return result
        }
        console.log("[COMMUNICATIONS] Invalid peer")
        return [false, "Invalid peer"]
    }
    // INFO Prepare a reply to the last message in the chain
    async replyToMessage(reply, privateKey) {
        // NOTE: Reply must be a valid message.bundle like object (see libs/messages.js)
        // First we move the current message hash to the previous hashes
        this.chain.current.previousHashes.push(
            this.chain.current.currentMessageHash,
        )
        // Then we apply the current message to the uplink
        this.chain.current.currentMessage = reply.content
        // Hashing the message for integrity (using the message proper hash)
        // REVIEW Should we use the message proper hash or recalculate it to see if it is the same?
        this.chain.current.currentMessageHash = reply.hash
        // Now we recalculate the signature and hash of the current comlink (containing the previous hashes to have full integrity)
        await this.hashAndSignCurrent(privateKey)
        // As the object has been recalculated, we are able to send the message to the peer from the main function
    }
    // INFO Broadcast a ComLink object to a peer (usually called by the above methods)
    async broadcastToPeer(peer, callback = false) {
        let _socket = peer.socket
        console.log("[COMMUNICATIONS] Sending message to peer")
        // TODO & REVIEW See if we need a listener here or we should just use ResponseRegistry as above
        _socket.emit("comlink", this) // Emitting this object to the peer
        return [true, this.muid]
    }
    // INFO Support for sending to a socket directly
    async broadcastToSocketPeer(socket, callback = false) {
        let compatible_peer = {
            socket: socket,
        }
        await this.broadcastToPeer(compatible_peer, callback)
    }
    // INFO Generic comlink validation function
    async validateComlink() {
        var _currentMessage
        try {
            _currentMessage = JSON.parse(this.chain.current.currentMessage)
        } catch (e) {
            console.log("[ERROR] Cannot parse:")
            console.log(JSON.stringify(this, null, 2))
            console.log("Due to " + e)
            return [false, "malformed comlink"]
        }
        // Check if the current message hash matches the message
        let stringifiedMessage = JSON.stringify(
            _currentMessage.content,
        )
        console.log("[COMLINK VALIDATION] Stringified message content successfully")
        console.log(stringifiedMessage)
        let _derivedMessageHash = sha256(stringifiedMessage)
        console.log("[COMLINK VALIDATION] Reported message hash: " + _currentMessage.hash)
        console.log("[COMLINK VALIDATION] Message hash derived: " + _derivedMessageHash)
        if (!(_derivedMessageHash === _currentMessage.hash))
            return [false, "comlink message hash mismatch"]
        console.log("...OK")
        // Check if current hash matches the current field
        let stringifiedCurrent = JSON.stringify(this.chain.current)
        let _derivedCurrentHash = sha256(stringifiedCurrent)
        console.log("[COMLINK VALIDATION] Reported current hash: " + this.chain.comlinkCurrentHash)
        console.log("[COMLINK VALIDATION] Current hash derived: " + _derivedCurrentHash)
        if (!(_derivedCurrentHash === this.chain.comlinkCurrentHash))
            return [false, "current hash mismatch"]
        console.log("...OK")
        let _publicKey = Buffer.from(_currentMessage.content.sender)
        console.log("[COMLINK VALIDATION] Reported sender: " + _publicKey.toString("hex"))
        // Check if the comlink signature matches the comlink sender
        console.log("[COMLINK VALIDATION] Current Hash Signature: " + this.chain.comlinkCurrentHashSignature.toString("hex"))
        //console.log("[COMLINK VALIDATION DEBUG MODE] Always true (on signature)")
        //return [true, "debug"] // TODO Returning true for debug
        
        let _signatureValidity = await identity.cryptography.verify(
            this.chain.comlinkCurrentHash,
            this.chain.comlinkCurrentHashSignature,
            _publicKey,
        ) // FIXME in ecdsa.js (node_modules/starkbank/....) -> math.js -> inv(x, s) - > x.eq(0)
        if (!_signatureValidity)
            return [false, "invalid comlink current hash signature"]
        // Check if the message signature matches the sender too
        _currentMessage.signature = Buffer.from(_currentMessage.signature)
        console.log("[COMLINK VALIDATION] Message Hash Signature: " + _currentMessage.signature.toString("hex"))
        let _messageSignatureValidity = await identity.cryptography.verify(
            _currentMessage.hash,
            _currentMessage.signature,
            _publicKey,
        )
        if (!_messageSignatureValidity)
            return [false, "invalid message hash signature"]
        // If we are here, all is well
        console.log("[COMLINK VALIDATION] Comlink is valid")
        return [true, "valid"]
    }
}
// !SECTION Comlink


module.exports = { broadcast, ComLink, ResponseRegistry }

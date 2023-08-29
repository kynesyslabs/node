/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Hashing from "../crypto/hashing"
import Cryptography from "../crypto/cryptography"
import { pki } from "node-forge"
import { Socket } from "socket.io-client"
import Transmission from "./transmission"
import Peer from "../peer/Peer"

import type { Current, Properties } from "./types/comlink"
import getRemoteIP from "../network/routines/getRemoteIP"
import sharedState from "src/utilities/sharedState"
import { type } from "os"


export default class ComLink {
    private static instances: Map<string, ComLink> = new Map()

    chain: {
        current: Current
        comlinkCurrentHash: string
        comlinkCurrentHashSignature: pki.ed25519.BinaryBuffer
    }
    muid: string
    properties: Properties

    constructor() {
        this.chain = {
            current: {
                currentMessage: null,
                currentMessageHash: null, // TODO Eliminate as is in current message is either null or the hash of the last message in the chain
                previousHashes: [], // Keep track of the previous hashes to have full integrity
            },
            comlinkCurrentHash: null, // is the hashed version of .current
            comlinkCurrentHashSignature: null, // is the signature of the hashed version of.current
        }
        let muid = this.generateMuid()
        this.muid = muid
        this.properties = {
            connection_string: null, // NOTE This is dynamically adjusted each time a comlink is sent or sent back
            require_reply: false,
            is_reply: false,
        }
        // REVIEW Does it clone the object? Hopefully not
        ComLink.instances.set(muid, this)

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
    async hashAndSignCurrent(privateKey: pki.ed25519.BinaryBuffer) {
        let stringifiedMessage = JSON.stringify(this.chain.current)
        this.chain.comlinkCurrentHash = Hashing.sha256(stringifiedMessage)
        let signature = await Cryptography.sign(
            this.chain.comlinkCurrentHash,
            privateKey,
        )
        this.chain.comlinkCurrentHashSignature = signature

        // Also includes the connection_string
        let connection_string: string = await getRemoteIP()
        connection_string = "http://" + connection_string + ":" + sharedState.getInstance().serverPort
        this.properties.connection_string = connection_string
    }

    // INFO Prepare and send the (usually) first message in the chain
    // TODO Add peer type and message type
    async broadcastMessageToPeer(
        peer: Peer,
        message: Transmission,
        privateKey: pki.ed25519.BinaryBuffer | any,
    ) {
        // REVIEW Sanitize message and type
        if (!message.bundle.content.type) {
            console.log("[COMMUNICATIONS] Invalid message")
            return [false, "Invalid message"]
        }
        if (peer.socket) {
            console.log(
                "[COMMUNICATIONS] Sending message to peer " + peer.socket.id,
            )
            // NOTE Removing privated key from message if present
            if (message.privateKey) {
                message.privateKey = null
                console.log(
                    "[COMMUNICATIONS] Removing private key from message (WARNING it should not be stored)",
                )
            }
            // NOTE Setting up the listener to receive the response is useless as we use general listeners
            // Setting the current message as the head of the chain
            this.chain.current.currentMessage = message
            // Hashing the message for integrity
            this.chain.current.currentMessageHash = message.bundle.hash
            await this.hashAndSignCurrent(privateKey)
            // Emitting the message
            let result = await this.broadcastToPeer(peer)
            console.log("[COMMUNICATIONS] Message sent")
            console.log(result)
            return result
        }
        console.log("[COMMUNICATIONS] Invalid peer")
        return [false, "Invalid peer"]
    }

    // INFO Prepare a reply to the last message in the chain
    async replyToMessage(
        // TODO Strip out private key from Transmission reply
        reply: Transmission,
        privateKey: pki.ed25519.BinaryBuffer,
    ) {
        // NOTE: Reply must be a valid message.bundle like object (see libs/messages.js)
        // First we move the current message hash to the previous hashes
        this.chain.current.previousHashes.push(
            this.chain.current.currentMessageHash,
        )
        // Then we apply the current message to the uplink
        this.chain.current.currentMessage = reply
        // Hashing the message for integrity (using the message proper hash)
        // REVIEW Should we use the message proper hash or recalculate it to see if it is the same?
        //console.log(reply)
        this.chain.current.currentMessageHash = reply.bundle.hash
        // Now we recalculate the signature and hash of the current comlink (containing the previous hashes to have full integrity)
        await this.hashAndSignCurrent(privateKey)
        // As the object has been recalculated, we are able to send the message to the peer from the main function
    }
    // INFO Broadcast a ComLink object to a peer (usually called by the above methods)
    async broadcastToPeer(peer: Peer) {
        let _socket = peer.socket
        console.log("[COMMUNICATIONS] Broadcast message to peer")
        // NOTE Here we make sure that we dont have private data in the message
        if (this.chain.current.currentMessage.privateKey) {
            console.log(
                "[WARNING] Private data in message, cleaning up but not a great idea",
            )
            this.chain.current.currentMessage.privateKey = null
        }
        // TODO & REVIEW See if we need a listener here or we should just use ResponseRegistry as above
        _socket.emit("comlink", this) // Emitting this object to the peer
        return [true, this.muid]
    }
    // INFO Support for sending to a socket directly
    async broadcastToSocketPeer(socket: Socket) {
        let compatible_peer = new Peer()
        compatible_peer.socket = socket
        await this.broadcastToPeer(compatible_peer)
    }

    // INFO Generic comlink validation function
    async validateComlink() {

        var _currentMessage = this.chain.current.currentMessage
        // Check if the current message hash matches the message
        let stringifiedMessage = JSON.stringify(_currentMessage.bundle.content)
        let _derivedMessageHash = Hashing.sha256(stringifiedMessage)
        if (!(_derivedMessageHash === _currentMessage.bundle.hash))
            return [false, "comlink message hash mismatch: " + _derivedMessageHash]
        // Check if current hash matches the current field
        let stringifiedCurrent = JSON.stringify(this.chain.current)
        let _derivedCurrentHash = Hashing.sha256(stringifiedCurrent)
        if (!(_derivedCurrentHash === this.chain.comlinkCurrentHash))
            return [false, "current hash mismatch: " + _derivedCurrentHash]
        // Check if the comlink signature matches the comlink sender
        console.log("[!] Extracting publicKey")
        console.log(_currentMessage.bundle.content.sender)
        let _publicKey = _currentMessage.bundle.content.sender
        try {
            _publicKey = Buffer.from(_currentMessage.bundle.content.sender) // REVIEW Isnt this useless now?
        } catch (error) {
            console.log("[!] Error extracting publicKey, assuming is a buffer already")
            console.log(typeof(_currentMessage.bundle.content.sender))
        }
        console.log("[!] Checking chain.comlinkCurrentHash")
        let bufferedHash
        if (typeof(this.chain.comlinkCurrentHash) == "string" ) {
            bufferedHash = Buffer.from(this.chain.comlinkCurrentHash)
        } else {
            bufferedHash = this.chain.comlinkCurrentHash
        }
        console.log(this.chain.comlinkCurrentHash)
        let _signatureValidity = await Cryptography.verify(
            bufferedHash,
            this.chain.comlinkCurrentHashSignature,
            _publicKey,
        )
        if (!_signatureValidity)
            return [false, "invalid comlink current hash signature"]
        // Check if the message signature matches the sender too
        _currentMessage.bundle.signature = Buffer.from(
            _currentMessage.bundle.signature,
        ) // REVIEW Isnt this useless now?
        console.log("[!] Checking bundle.hash")
        console.log(typeof(_currentMessage.bundle.hash))
        let _messageSignatureValidity = await Cryptography.verify(
            _currentMessage.bundle.hash,
            _currentMessage.bundle.signature,
            _publicKey,
        )
        if (!_messageSignatureValidity)
            return [false, "invalid message hash signature"]
        // If we are here, all is well
        console.log("[COMLINK VALIDATION] Comlink is valid")
        return [true, "valid"]
    }
}

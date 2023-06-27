// INFO This module exposes methods designed to have an unified way of communicate in DEMOS
const { Buffer } = require("buffer")
const sha256 = require("sha256")

// REVIEW Experimental air module
var air = require("./classes/air")
var imc = new air()
imc.initialize("messages")
var identity = require("./identity")

// SECTION Object based version
class Message {
    constructor(privateKey) {
        this.bundle = {
            content: {
                type: null,
                message: null,
                sender: null,
                receiver: null,
                timestamp: null,
                data: null,
                extra: null,
            },
            hash: null,
            signature: null,
        }
        this.receiver_peer = null
        this.privateKey = privateKey
    }

    // INFO Initialize a message object with the given parameters
    initialize(type, message, sender_public, receiver, data, extra) {
        this.bundle.content.type = type
        this.bundle.content.message = message
        this.bundle.content.sender = sender_public
        this.bundle.content.receiver = receiver.identity
        this.bundle.content.data = data
        this.bundle.content.extra = extra
        this.bundle.content.timestamp = Date.now()
        this.receiver_peer = receiver
    }

    // INFO Hash and sign a message
    async finalize() {
        // Hash the content
        this.bundle.hash = sha256(JSON.stringify(this.bundle.content)) // REVIEW is this ok?
        // Sign the hash
        this.bundle.signature = await identity.generate.ecdsa.sign(
            this.bundle.hash,
            this.privateKey,
        ) // REVIEW We shouldn't have to stringify the hash
    }
}
// !SECTION Object based version

var encode = {
    // INFO Given a JSON data, returns an hex encoded string
    fromJson: async function (json) {
        return Buffer.from(JSON.stringify(json)).toString("hex")
    },
}

var decode = {
    // INFO Given an hex encoded string, returns a JSON data
    toJson: async function (hex) {
        return JSON.parse(Buffer.from(hex, "hex").toString("utf8"))
    },
}

module.exports = { imc, encode, decode, Message }

// INFO This module exposes methods designed to have an unified way of communicate in DEMOS
const { Buffer } = require("buffer")
const sha256 = require('sha256');


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
				muid: null,
				extra: null
			},
				hash: null,
				signature: null
			}
			this.receiver_peer = null
			this.privateKey = privateKey
		}

	// INFO Muid generator
	muid() {
		let number_1 = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
		let number_2 = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
		this.bundle.content.muid = number_1 + number_2
		return this.bundle.content.muid
	}

	// INFO Initialize a message object with the given parameters
	initialize(type, message, sender_public, receiver, data, extra, muid) {
		if (!muid) this.muid() // Generate a muid if not provided (e.g. new message)
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
		this.bundle.signature = await identity.generate.ecdsa.sign(this.bundle.hash, this.privateKey) // REVIEW We shouldn't have to stringify the hash
	}
}
// !SECTION Object based version

// SECTION Current structure based version
// NOTE Defining a skeleton for messages
const emptyMessage = {
	type: null,
	message: null,
	sender: null,
	receiver: null,
	signature: null,
	timestamp: null,
	data: null,
	hash: null,
	extra: null,
	muid: null
}

// NOTE Shared method to create a muid
var muid = function () {
    let number_1 = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
	let number_2 = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
	return number_1 + number_2
}

var create = {
	// INFO Returns an unsigned raw message object of type text
	textMessage: async function (message, sender, receiver) {
		let _textMessageObject = emptyMessage
		_textMessageObject.muid = muid()
		_textMessageObject.type = "text"
		_textMessageObject.message = message
		_textMessageObject.sender = sender
		_textMessageObject.receiver = receiver
		_textMessageObject.timestamp = Date.now()
		return _textMessageObject
	},
	// INFO Returns an unsigned raw message object of type transaction
	transactionMessage: async function (txdata, sender, receiver, message=null) {
		let _transactionMessageObject = emptyMessage
		_transactionMessageObject.muid = muid()
		_transactionMessageObject.type = "transaction"
		_transactionMessageObject.message = message
		_transactionMessageObject.data = txdata
		_transactionMessageObject.sender = sender
		_transactionMessageObject.receiver = receiver
		_transactionMessageObject.timestamp = Date.now()
		return _transactionMessageObject
	},
	nodeCall: async function (command, parameters, sender, receiver) {
		let _nodeCallMessageObject = emptyMessage
        _nodeCallMessageObject.muid = muid()
        _nodeCallMessageObject.type = "public"
        _nodeCallMessageObject.message = command
        _nodeCallMessageObject.parameters = parameters
        _nodeCallMessageObject.sender = sender
        _nodeCallMessageObject.receiver = receiver
        _nodeCallMessageObject.timestamp = Date.now()
        return _nodeCallMessageObject
    },
	// TODO Add here all the other types of messages
}

var encode = {
	// INFO Given a JSON data, returns an hex encoded string
	fromJson: async function (json) {
		return Buffer.from(JSON.stringify(json)).toString("hex")
	}
}

var decode = {
	// INFO Given an hex encoded string, returns a JSON data
	toJson: async function (hex) {
		return JSON.parse(Buffer.from(hex, "hex").toString("utf8"))
	}
}
// !SECTION Current structure based version

module.exports = { imc, encode, decode, Message }

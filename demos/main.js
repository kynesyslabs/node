/* eslint-disable no-unused-vars */
const fs = require("fs")
const sqlite3 = require("sqlite3").verbose()
const term = require("terminal-kit").terminal

// SECTION Globals and imports
// ANCHOR Loading the chain db library to interact with the blockchain
const { ChainDB, Block, Transaction } = require("./libs/classes/chain.js")
let chainDB = new ChainDB()

// REVIEW Experimental IMC (Inter Module Communication)
// INFO This is a way to communicate between modules
// * For every module that will share informations with us, it needs to import air.js
// * and initialize it with a name, then export the imc interface
// ** In module.js
// var air = require("./air.js")
// var imc = new air()
// imc.initialize("module_name")
// * Now in main.js (or any controller script anyway) we can import the module and register it
// ** In main.js
// const module = require("./module.js")
// imc.registered_modules.push({ name: "module_name", registered: true, socket: module.imc })
// * Now we can set variables valid for all the modules we registered
// ** In main.js
// imc.states["variable"] = "value" // Registering locally
// imc.broadcast("variable", "value") // Broadcasting to all the modules
// * After this point, the module can access the variable with imc.states["variable"]
// ** In module.js
// module.writeFile(imc.states["variable"])
var air = require("./libs/classes/air.js")
// ANCHOR DEMOS Libraries

// Experimental IMC
var imc = new air()
imc.initialize("main")

// For every module we want to communicate with, we need to register its imc interface
const identity = require("./libs/identity.js") // Provides cryptographical methods
imc.registered_modules.push({
	name: "identity",
	registered: true,
	socket: identity.imc,
})
const messages = require("./libs/messages.js") // Definition of the structure of messages (see libs/network.js listeners)
imc.registered_modules.push({
	name: "messages",
	registered: true,
	socket: messages.imc,
})
const network = require("./libs/network.js") // Definitions for network activity (server, client, listeners)
imc.registered_modules.push({
	name: "network",
	registered: true,
	socket: network.imc,
})

const communications = require("./libs/communications.js") // Module used to manage all kind of peers communication
const Chainteract = require("./libs/classes/chainteract.js")
const { config } = require("./libs/configuration.js") // Loads config.json
const { print } = require("./libs/logging.js") // Helper for debugging

// NOTE Defining peers object and registering it through the modules
// NOTE peers contains the methods that work on peerlist and related variables (shared)
var {methods, Peer } = require("./libs/classes/peers.js") 
imc.states["peers"] = {
	methods: methods,
	peerlist: [],
	Peer: Peer
}
imc.broadcast("peers", imc.states["peers"])

let responseRegistry = new communications.ResponseRegistry() // NOTE This will be shared through IMC and is a global registry
imc.broadcast("responseRegistry", responseRegistry)

// Main varables to pass around
var id = {
	ecdsa: null,
	rsa: null,
} // An object with { ed25519: keypair + pem + hex, rsa: keypair }
// !SECTION Globals and imports

// SECTION Methods called by
// INFO Checking a peer through the id
function containsPeer(obj, list) {
	var i
	for (i = 0; i < list.length; i++) {
		console.log(list[i].socket.id)
		if (list[i].socket.id === obj.socket.id) {
			return true
		}
	}
	return false
}

// INFO Ensure that we are at the head of the chain
async function sync() {
	// TODO Implement all the ComLink and responseRegistry mechanism in a standalone function
	let synced = true
	console.log("[SYNC] Our data: fetched")
	let _currentLastBlockNumber = chainDB.getLastBlockNumber()
	let _currentLastBlockHash = chainDB.getLastBlockHash()
	// FIXME ^ Why above values go to the end? Because we should await somehow even if it is not async (??) (see chain.js, fixme on read)
	console.log("[SYNC] Fetching data from peers")
	// Asking to all the peers for the last block
	for (let i = 0; i < imc.states["peers"].peerlist.length; i++) {
		// Creating a comlink object
		let _comlink = new communications.ComLink()
		let _currentPeer = imc.states["peers"].peerlist[i]
		// Generate the message to ask for the last block
		let _blockAskMessage = new messages.Message(id.ecdsa.privateKey)
		_blockAskMessage.initialize(
			"nodeCall",
			"getLastBlockNumber",
			id.ecdsa.publicKeyHex,
			_currentPeer,
			null,
			null,
			null
		)
		// Hash and sign it
		await _blockAskMessage.finalize()
		// Putting the message into the comlink
		console.log("[SYNC] Asking " + _currentPeer.socket.id + " for the last block")
		// Preparing for a response
		_comlink.properties.require_reply = true
		_comlink.properties.is_reply = false
		responseRegistry.requestResponse(_comlink)
		// Ask for the last block
		await _comlink.broadcastMessageToPeer(_currentPeer, _blockAskMessage.bundle, id.ecdsa.privateKey)
		/* REVIEW
		 * We should use responseRegistry.hasResponse(_comlink) to check periodically if the response is received
		 * Or look into communications.js ResponseRegistry for a TODO that explains how to do this in a more elegant way
		 * In any case, here we should wait until the response is received
		*/
		let timeout_limit = 2000
		let timeout_counter = 0
		while (!responseRegistry.hashResponse(_comlink)) {
			await sleep(100)
			timeout_counter += 100
			if (timeout_counter > timeout_limit) {
                console.log("[SYNC] Timeout limit reached: no response received")
				return false // TODO Manage it
            }
        }
		// REVIEW Ensure the above works
		// LINK https://stackoverflow.com/questions/23893872/how-to-properly-remove-event-listeners-in-node-js-eventemitter
		// The above link will be used to remove the listeners once the response is received, will be applied to keep clean the peers connections too
	}
	return synced
}

// INFO Bootstrapping the peers to find at least one valid peer
async function peerBootstrap(peers_list) {

	let peerlist = imc.states["peers"]["peerlist"]
	// Validity check
	for (let i = 0; i < peers_list.length; i++) {
		let _currentPeerURL = peers_list[i] // The url of the peer
		// If there is a : in the url, we assume it's a address + port
		let currentPeerAddress
		let currentPeerPort
		if (_currentPeerURL.includes(">")) {
			currentPeerAddress = _currentPeerURL.split(">")[0]
			currentPeerPort = _currentPeerURL.split(">")[1]
		} else {
			currentPeerAddress = _currentPeerURL
			currentPeerPort = 53550
		}
		print.log("[BOOTSTRAP] Testing " + currentPeerAddress + ":" + currentPeerPort)
		// REVIEW Connection test and add to valid_peers
		// Trying to connect and retrieve the socket for the given peer using Peer class
		let _currentPeerObject = await network.methods.client.connectToPeer(currentPeerAddress, currentPeerPort) // Returns the Peer object
		if (_currentPeerObject) {
			term.green("[BOOTSTRAP] OK: Valid peer " + currentPeerAddress + ":" + currentPeerPort + "\n")
			/*if (containsPeer(_currentPeerObject, peerlist)) { // FIXME Disabled as was not working. Should be fixed
				term.yellow("[BOOTSTRAP] WARNING: Duplicate peer " + currentPeerAddress + ":" + currentPeerPort + "\n")
			} else */ peerlist.push(_currentPeerObject) 
		} else {
			term.red("[BOOTSTRAP] ERROR: Invalid peer " + currentPeerAddress + ":" + currentPeerPort + "\n")
		}
		console.log(peerlist)
	}
	// Dying if there are no valid peers
	if (peerlist.length == 0) {
		// Exit if there are no valid peers
		print.critical("No valid peers found, exiting")
		// eslint-disable-next-line no-undef
		process.exit(-3)
	}
	return peerlist
}

// INFO Finding, creating or rejecting the genesis block
async function findGenesisBlock() {
	let genesis_block = chainDB.getGenesisBlock()
	await sleep(1000)
	if (genesis_block.length == 0) {
		// We need to initialize the genesis block
		term.yellow("[BOOTSTRAP] Initializing the genesis block\n")
		if (!fs.existsSync("data/genesis.json")) {
			// Exit if there are no genesis block
			print.critical("No genesis block found, exiting")
			// eslint-disable-next-line no-undef
			process.exit(-5)
		}
		// Loading the genesis block
		let genesis_json = JSON.parse(fs.readFileSync("data/genesis.json", "utf8"))
		// Adding the genesis block to the chain
		let genesis_hash = chainDB.generateGenesisBlock(genesis_json)
		term.green("Genesis block created: " + genesis_hash + "\n")
	} else term.green("Genesis block found: "); console.log(genesis_block[0].hash)
}

// INFO Ensuring the identity to be valid
async function ensureIdentity() {
	// INFO First and foremost, we need to either load or create an identity
	if (fs.existsSync("./.demos_identity")) {
		// Loading the identity
		id.ecdsa = await identity.load.fromFile("./.demos_identity")
		print.log("Loaded ecdsa identity")
	} else {
		id.ecdsa = await identity.generate.ecdsa.new()
		// Writing the identity to disk in binary format
		fs.writeFileSync("./.demos_identity", id.ecdsa.privateKey.toPem(), "utf8")
		print.log("Generated new identity")
	}
}
// !SECTION Methods called by main

// ANCHOR Entry point of the program
async function main() {
	// NOTE The whole first part of main ensures the environment is ready to run
	await ensureIdentity()
	// Log identity
	print.log("WE ARE " + id.ecdsa.publicKeyHex)
	// Setting the common variables and propagating them
	imc.states["id"] = id
	imc.broadcast("id", id)
	// Sharing it with the network
	imc.states["publicKeyHex"] = id.ecdsa.publicKeyHex
	imc.broadcast("publicKeyHex", id.ecdsa.publicKeyHex)
	// INFO Loading the known peers
	if (!fs.existsSync("./demos_peers")) {
		// Exit if there are no peers
		print.critical("No peers found, exiting")
		// eslint-disable-next-line no-undef
		process.exit(-2)
	}
	// INFO We start the server
	term.yellow("[BOOTSTRAP] Starting the server\n")
	await network.methods.server.start(config.serverPort) // NOTE See network.js for the listeners that are automatically added
	// Sleep 4 seconds
	await new Promise((r) => setTimeout(r, 2000))
	// Loading the peers
	let peers_list = JSON.parse(fs.readFileSync("./demos_peers", "utf8"))
	// INFO Setting the common variables and propagating them
	imc.states.peers["peerlist"] = await peerBootstrap(peers_list)
	//imc.broadcast("peers", imc.states.peers)
	term.green.bold("[BOOTSTRAP] Peers loaded (" + imc.states["peers"]["peerlist"].length + ")\n")
	// INFO Now ensuring we have an initialized chain or initializing the genesis block
	await findGenesisBlock()
	// INFO Starting the sync loop
	let synced = sync() // NOTE We don't wait for the sync to finish because it will run indefinitely in the background
}
main()

// NOTE Sleep function
async function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}
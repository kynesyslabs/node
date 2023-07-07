/* eslint-disable no-unused-vars */
const fs = require("fs")
const term = require("terminal-kit").terminal
const _db = require("./model/database")

// INFO intercom (in main.js mainly but can be used by other modules) publish variables initial state and variables modifications
// Each module (or main.js if another module manages a variable) will need to set up its subscriber (see network.js as an example)
const intercom = require("./libs/intercom.js")
const network = require("./libs/network.js") // Definitions for network activity (server, client, listeners) and intercom listeners

// SECTION Globals and imports
// ANCHOR Loading the chain db library to interact with the blockchain
const { ChainDB, Block, Transaction } = require("./libs/classes/chain.js")

let chainDB = new ChainDB()


// ANCHOR DEMOS Libraries
// For every module we want to communicate with, we need to register its imc interface
const identity = require("./libs/identity.js") // Provides cryptographical methods
const messages = require("./libs/messages.js") // Definition of the structure of messages (see libs/network.js listeners)

const communications = require("./libs/communications.js") // Module used to manage all kind of peers communication
const Chainteract = require("./libs/classes/chainteract.js")
const { config } = require("./libs/configuration.js") // Loads config.json
const { print } = require("./libs/logging.js") // Helper for debugging

// NOTE Defining peers object and registering it through the modules
// NOTE peers contains the methods that work on peerlist and related variables (shared)
var { methods, Peer } = require("./libs/classes/peers.js")
let peers = {
    methods: methods,
    peerlist: [],
    Peer: Peer,
}

let responseRegistry = new communications.ResponseRegistry() // NOTE This will be shared through intercom and is a global registry

// Main varables to pass around
var id = {
    ed25519: null,
    rsa: null,
} // An object with { ed25519: keypair + pem + hex, rsa: keypair }
// !SECTION Globals and imports

// SECTION Publish variables initial state
intercom.broadcast("PEERS", peers)
intercom.broadcast("RESPONSE_REGISTRY", responseRegistry)
// !SECTION Publish variables initial state

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
    let _currentLastBlockNumber = await chainDB.getLastBlockNumber()
    let _currentLastBlockHash = await chainDB.getLastBlockHash()
    // FIXME ^ Why above values go to the end? Because we should await somehow even if it is not async (??) (see chain.js, fixme on read)
    console.log("[SYNC] Fetching data from peers")
    // Asking to all the peers for the last block
    for (let i = 0; i < peers.peerlist.length; i++) {
        // Creating a comlink object
        let _comlink = new communications.ComLink()
        let _currentPeer = peers.peerlist[i]
        // Generate the message to ask for the last block
        let _blockAskMessage = new messages.Message(id.ed25519.privateKey)
        _blockAskMessage.initialize(
            "nodeCall",
            "getLastBlockNumber",
            id.ed25519.publicKey,
            _currentPeer,
            null,
            null,
            null,
        )
        // Hash and sign it
        await _blockAskMessage.finalize()
        // Putting the message into the comlink
        console.log(
            "[SYNC] Asking " + _currentPeer.socket.id + " for the last block",
        )
        // Preparing for a response
        _comlink.properties.require_reply = true
        _comlink.properties.is_reply = false
        // Propagating the responseRegistry actual status
        responseRegistry.requestResponse(_comlink)
        intercom.broadcast("RESPONSE_REGISTRY", responseRegistry)
        // Ask for the last block
        await _comlink.broadcastMessageToPeer(
            _currentPeer,
            _blockAskMessage.bundle,
            id.ed25519.privateKey,
        )
        /* REVIEW
         * We should use responseRegistry.hasResponse(_comlink) to check periodically if the response is received
         * Or look into communications.js ResponseRegistry for a TODO that explains how to do this in a more elegant way
         * In any case, here we should wait until the response is received
         */
        let timeout_limit = 2000
        let timeout_counter = 0
        while (!responseRegistry.hasResponse(_comlink)) {
            await sleep(100)
            timeout_counter += 100
            if (timeout_counter > timeout_limit) {
                console.log(
                    "[SYNC] Timeout limit reached: no response received",
                )
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
    let peerlist = peers.peerlist
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
        print.log(
            "[BOOTSTRAP] Testing " + currentPeerAddress + ":" + currentPeerPort,
        )
        // REVIEW Connection test and add to valid_peers
        // Trying to connect and retrieve the socket for the given peer using Peer class
        let _currentPeerObject = await network.methods.client.connectToPeer(
            currentPeerAddress,
            currentPeerPort,
        ) // Returns the Peer object
        if (_currentPeerObject) {
            term.green(
                "[BOOTSTRAP] OK: Valid peer " +
                    currentPeerAddress +
                    ":" +
                    currentPeerPort +
                    "\n",
            )
            /*if (containsPeer(_currentPeerObject, peerlist)) { // FIXME Disabled as was not working. Should be fixed
				term.yellow("[BOOTSTRAP] WARNING: Duplicate peer " + currentPeerAddress + ":" + currentPeerPort + "\n")
			} else */ peerlist.push(_currentPeerObject)
        } else {
            term.red(
                "[BOOTSTRAP] ERROR: Invalid peer " +
                    currentPeerAddress +
                    ":" +
                    currentPeerPort +
                    "\n",
            )
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
    let genesis_block = await chainDB.getGenesisBlock()
    await sleep(1000)
    console.log("=== RETURNED TO MAIN.JS ===")
    console.log(genesis_block)
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
        let genesis_json = JSON.parse(
            fs.readFileSync("data/genesis.json", "utf8"),
        )
        // Adding the genesis block to the chain
        let genesis_hash = chainDB.generateGenesisBlock(genesis_json)
        term.green("Genesis block created: " + genesis_hash + "\n")
    } else term.green("Genesis block found: ")
    console.log(genesis_block)
    console.log(genesis_block[0].hash)
}

// INFO Ensuring the identity to be valid
async function ensureIdentity() {
    // INFO First and foremost, we need to either load or create an identity
    if (fs.existsSync("./.demos_identity")) {
        // Loading the identity
        id.ed25519 = await identity.cryptography.load("./.demos_identity") // TODO Add load with cryptography
        print.log("Loaded ecdsa identity")
    } else {
        id.ed25519 = await identity.cryptography.new()
        // Writing the identity to disk in binary format
        identity.cryptography.save(id.ed25519, "./.demos_identity")
        print.log("Generated new identity")
    }
}
// !SECTION Methods called by main

// ANCHOR Entry point of the program
async function main() {
    // NOTE The whole first part of main ensures the environment is ready to run
    await ensureIdentity()
    // Log identity
    print.log("WE ARE " + id.ed25519.publicKey.toString("hex"))
    // Setting the common variables and propagating them
    intercom.broadcast("IDENTITY", id)
    // Sharing it with the network
    intercom.broadcast("PUBLIC_HEX_KEY", id.ed25519.publicKey.toString("hex"))
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
    await new Promise(r => setTimeout(r, 2000))
    // Loading the peers
    let peers_list = JSON.parse(fs.readFileSync("./demos_peers", "utf8"))
    // INFO Setting the common variables and propagating them
    peers_list = await peerBootstrap(peers_list)
    peers.peerlist = peers_list
    intercom.broadcast("PEERS", peers)
    term.green.bold(
        "[BOOTSTRAP] Peers loaded (" +
            peers.peerlist.length +
            ")\n",
    )
    // INFO Now ensuring we have an initialized chain or initializing the genesis block
    await findGenesisBlock()
    // INFO Starting the sync loop
    let synced = sync() // NOTE We don't wait for the sync to finish because it will run indefinitely in the background
}
main()

// NOTE Sleep function
async function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

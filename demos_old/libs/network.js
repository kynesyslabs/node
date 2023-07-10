/* eslint-disable no-unused-vars */
// INFO All the Server and Client stuff is defined here
// NOTE The peers object, as is managed here, is accessed through methods
// NOTE The variables within the objects must be accessed only from local methods as are
//      reinitialized every time the module is imported and thus would not be synced.

const express = require("express")
const app = express()
const http = require("http")
const server = http.createServer(app)
const { Server } = require("socket.io")
const { io } = require("socket.io-client")
const identity = require("./identity")
const term = require("terminal-kit").terminal
const intercom = require("./intercom")
const comLinkSchema = require("./schemas/comlink.schema")

// NOTE Data for inspecting the blockchain
const { ChainDB, Block, Transaction } = require("./classes/chain")

const io_server = new Server(server, {
    cors: {
        origin: ["https://admin.socket.io", "https://amritb.github.io"],
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    },
})

let chainDB = new ChainDB()

// SECTION Setting up listeners and variables for the intercom
var peers
var id
var responseRegistry
let subscriber = function (msg, data) {
    console.log("[INTERCOM][" + msg + "] Received data")
    if (msg === "PEERS") {
        peers = data
    } else if (msg === "IDENTITY") {
        id = data
    } else if (msg === "RESPONSE_REGISTRY") {
        responseRegistry = data
    }
    // Web2 Listener
    else if (msg === "WEB2") {
        console.log("web2 subscriber")
        console.log(data)
    }
}
intercom.subscribe("PEERS", subscriber)
intercom.subscribe("IDENTITY", subscriber)
intercom.subscribe("RESPONSE_REGISTRY", subscriber)
// !SECTION Setting up listeners and variables for the intercom

const { Peer } = require("./classes/peers.js")
var transactions = require("./transactions.js")

// NOTE Libraries to handle specific endpoints
var communications = require("./communications.js")
var web2 = require("./web2.js")
var messages = require("./classes/transmit_class.js")
var messaging = require("./messaging.js")
var storage = require("./storage.js")

app.get("/", (req, res) => {
    res.send("<h1>Hello from your friendly DEMOS layer</h1>")
})

// Peers library import
var { print } = require("./logging")
const { parse } = require("path")

// INFO common comlink digestor
async function parseComlink(request, peerSocket) {
    // We need to check if the message request is valid (is a ComLink object)
    console.log("[SERVER] Received comlink")
    //console.log(request)
    // GIving the request the comlink methods
    let _comlink_request = new communications.ComLink()
    _comlink_request.chain = request.chain
    _comlink_request.muid = request.muid
    _comlink_request.properties = request.properties
    // Checking validity of the comlink
    let valid = await _comlink_request.validateComlink()
    if (!valid[0]) {
        console.log("[COMLINK VALIDATION ERROR] " + valid[1])
        peerSocket.emit("comlink", {
            status: "error",
            message: valid[1],
        })
        return false
    }
    console.log("[COMLINK PARSING] Parsing comlink message...")
    // Sanitizing the request
    if (!request.muid) {
        peerSocket.emit("error", {
            muid: null,
            message: "No muid specified",
        })
        return false
    }
    console.log("[COMLINK PARSING] MUID: " + request.muid)
    // Taking the message part
    let content
    if (!(typeof request.chain.current.currentMessage === "object")) {
        content = JSON.parse(request.chain.current.currentMessage).content
    } else {
        content = request.chain.current.currentMessage
    }
    if (!content.message) {
        console.log("[COMLINK PARSING] No message specified. Erroring back.")
        peerSocket.emit("error", {
            muid: request.muid,
            message: "No message specified",
        })
        return false
    }
    console.log("[COMLINK PARSING] Message parsed")
    return [_comlink_request, content]
}

// ANCHOR Listeners
// FIXME Refactor listeners to be unified under a single client+server+common set
var listeners = {
    // INFO Common listeners for both Server and Client
    // NOTE Is automatically called by server_listeners and client_listeners
    common_listeners: async function (peer) {
        // FIXME Check if and why this produces two events instead of one
        // peer is a peer object
        // Managing disconnection
        peer.socket.on("disconnect", async () => {
            print.log("user disconnected")
            // Removing the peer from the list if it was in
            await peers.methods.removePeer(peer) // We remove it fully: a peer is 2 way connected
        })
        // INFO Managing authentications queries using imc states (called on connect on both sides)
        peer.socket.on("auth_ask", async data => {
            // REVIEW Signing data.message with the private key
            let _signature = await identity.cryptography.sign(
                data.message,
                id.privateKey,
            )
            // REVIEW Sending the signature back along with the public key and the message
            let _sendBack = [data.message, _signature, id.publicKey]
            peer.socket.emit("auth_reply", _sendBack)
        })
        // REVIEW public endpoint is currently for debugging purposes
        peer.socket.on("public", request => {
            console.log("[PEER] Received")
            console.log(request)
        })
        // INFO Managing replies
        peer.socket.on("comlink_reply", async request => {
            // request is a ComLink object with the same structure as the comlink listener below
            console.log("[PEER] Received reply to " + request.muid)
            //console.log(JSON.stringify(request, null, 2))
            // REVIEW Check if the responseRegistry contains the muid of the request
            let _responseRegistry = responseRegistry.list
            //console.log(_responseRegistry)
            let _response = _responseRegistry[request.muid]
            if (!_response) {
                console.log("[PEER] No response expected for " + request.muid)
                return
            } else {
                console.log(
                    "[PEER] Received expected response for " + request.muid,
                )
                // TODO Continue with the response logic (as per filling comlink if needed and verifications and so on)
            }
            console.log(request)
            // Parsing the comlink
            let parsed_comlink = await parseComlink(request, peer.socket) // FIXME Cant parse responses
            if (!parsed_comlink) return
            let _comlink_request = parsed_comlink[0]
            let content = parsed_comlink[1]
        })
        // INFO Managing errors
        peer.socket.on("error", async request => {
            console.log("[PEER] Received error:")
            console.log(request)
        })
    },
    // INFO Listeners for server
    server_listeners: async function () {
        // peer is a socket
        // INFO - SERVER | Listener and entry point for connection events by peers
        io_server.on("connection", async peerSocket => {
            term.magenta("[SERVER] Peer connection incoming\n")
            // Declaring a new peer object following the peers.js schema shared by main.js
            let _peerForged = new Peer()
            _peerForged.socket = peerSocket
            // Setting up the common listeners
            await this.common_listeners(_peerForged)
            // REVIEW Authentication by identity verification
            // INFO Managing authentications responses using imc states (called after a auth_ask event as specified above)
            peerSocket.on("auth_reply", async data => {
                console.log(data)
                // REVIEW Verify the signature with the public key on the message
                let _verification = await identity.cryptography.verify(
                    data[0],
                    data[1],
                    data[2],
                )
                // Disconnect if the verification is false
                if (!_verification) {
                    peerSocket.emit("auth_fail")
                    peerSocket.disconnect()
                }
                // TODO We add the peer to the list
                // And we reply ok
                peerSocket.emit("auth_ok")
            })
            peerSocket.emit("auth_ask") // Once we are able to listen for the reply, we send the auth_ask event
            // TODO Adding _peerForged.identity
            // INFO Adding the peer to the list
            await peers.methods.addPeer(_peerForged)
            // NOTE From now on, the peer is connected and is able to communicate through advanced methods (as below)
            peerSocket.on(
                "comlink",
                async request => {
                    // REVIEW I don't think we need to do this every time
                    const id_ed25519 = await identity.cryptography.load(
                        "./.demos_identity",
                    )
                    // TODO Add responseRegistry support as per main.js and communications.js
                    let _receiver = peerSocket
                    // FIXME The below logic needs to be refactored in a separate method as it is used by other listeners too
                    let parsed_comlink = await parseComlink(request, peerSocket)
                    if (!parsed_comlink) return
                    let _comlink_request = parsed_comlink[0]
                    let content = parsed_comlink[1]
                    // Listening for commands
                    // INFO This switch handles the public methods that should have this structure:
                    //      { method: "methodName", params: { ... }, muid: [number] }
                    // Where muid is a message unique identifier that is used to identify the response
                    var response
                    var require_reply = false

                    // INFO Web2 endpoints
                    if (content.type === "web2Request") {
                        console.log("[SERVER] Received web2Request")
                        switch (content.message.action) {
                            case "getUrl":
                                console.log("[SERVER] Received getUrl")
                                response = web2.http_request(
                                    content.message.httpVerb,
                                    content.message.url,
                                    content.message.headers,
                                )
                                break
                            default:
                                break
                        }
                    }

                    // INFO Messaging endpoint
                    else if (content.type === "messages") {
                        // REVIEW Call the appropriate lib to parse the request and act
                        response = await messaging.parseRequest(content)
                    }

                    // INFO Storage endpoint
                    else if (content.type === "storage") {
                        // TODO Call the appropriate lib to parse the request and act
                    }

                    // INFO Node APIs endpoints
                    else if (content.type === "nodeCall") {
                        switch (content.message) {
                            case "getLastBlockNumber":
                                console.log(
                                    "[SERVER] Received getLastBlockNumber",
                                )
                                response = await chainDB.getLastBlockNumber()
                                console.log(response)
                                break
                            case "getLastBlockHash":
                                response = await chainDB.getLastBlockHash()
                                break
                            case "getBlockByNumber":
                                if (!request.parameters.blockNumber) {
                                    _receiver.emit("public", {
                                        error: "No block specified",
                                    })
                                }
                                response = await chainDB.getBlockByNumber(
                                    request.parameters.blockNumber,
                                )
                                break
                            case "getBlockByHash":
                                if (!request.parameters.blockHash) {
                                    _receiver.emit("public", {
                                        error: "No block specified",
                                    })
                                }
                                response = await chainDB.getBlockByHash(
                                    request.parameters.blockHash,
                                )
                                break
                            case "getMempool":
                                response = await chainDB.getPendingPool()
                                break
                        }
                    }
                    // INFO Default
                    else {
                        console.log(
                            "[COMLINK INVALID] No known type: " + content.type,
                        )
                    }
                    // ANCHOR Reply logic
                    // REVIEW unless specified, we now send back the updated comlink as a response
                    // Building a message to send back in the comlink
                    var response_message = new messages.Message(
                        id_ed25519.privateKey,
                    )
                    response_message.initialize(
                        // TODO Specify the answer so that it has a type AND a message
                        "reply",
                        JSON.stringify(response), // FIXME Here goes undefined, not good
                        id_ed25519.publicKey,
                        "placeholder", // FIXME Also here goes undefined, not good
                        null,
                        null,
                    )
                    await response_message.finalize()
                    // Populating the comlink
                    _comlink_request.properties.is_reply = true // Setting the reply flag as we are replying
                    _comlink_request.properties.require_reply = require_reply // Setting the require_reply flag as provided above
                    await _comlink_request.replyToMessage(
                        response_message.bundle,
                        id_ed25519.privateKey,
                    )
                    // Sending back the response
                    console.log("[SERVER] Sending back comlink")
                    //console.log(JSON.stringify(_comlink_request))
                    _receiver.emit("comlink_reply", _comlink_request) // reply is managed in the common listeners
                },
                // TODO See in communications.js and find the best way to validate, check and digest the request
            )

            // INFO Debug code
            peerSocket.on("hello", async request => {
                console.log("[DEBUG] hello there")
            })
            // INFO Transactions listener
            peerSocket.on("transactions", async request => {
                // Refusing the request if there is no muid
                if (!request.muid) {
                    peerSocket.emit("transactions", {
                        status: "error",
                        message: "No muid specified",
                    })
                    return
                }
                // request.tx is the signed tx (or should be)
                let integrity = await transactions.methods.sanityCheck(
                    request.tx,
                )
                if (!integrity) {
                    peerSocket.emit("transactions", {
                        status: "error",
                        message: "Invalid transaction",
                        muid: request.muid,
                    })
                    return
                }
                // If the tx is valid, we verify the signature
                let verification = await transactions.methods.verify(request.tx)
                if (!verification[0]) {
                    peerSocket.emit("transactions", {
                        status: "error",
                        message: "Failed verification",
                        muid: request.muid,
                    })
                    return
                }
                // TODO Put the tx into the blockchain as pending
                // Verify coherence of the tx
                let coherence = await transactions.methods.isCoherent(
                    request.tx,
                )
                if (!coherence[0]) {
                    peerSocket.emit("transactions", {
                        status: "error",
                        message: "Failed coherence",
                        muid: request.muid,
                    })
                    return
                    // TODO handle the transactions execution
                }
            })
            print.log("[SERVER] Listeners set up")
        })
    },
    // INFO Listeners for client
    client_listeners: async function (peer) {
        // peer is an object
        // Setting up the common listeners
        this.common_listeners(peer)
        // INFO - CLIENT | Listener and entry point for connection events by peers
        peer.socket.on("connect", async () => {
            term.magenta("\n[CLIENT] Connected to peer\n")
            // Declaring a new peer object following the peers.js schema shared by main.js
            // TODO Authentication by identity verification
            // TODO Adding _peerForged.identity
            // INFO Adding the peer to the list
            await peers.methods.addPeer(peer)
        })
        print.log("[CLIENT] Listeners set up")
    },
    // INFO Listeners for broadcast events internally to the node (moved to the beginning with broadcast listeners)
    /*broadcast_listeners: async function () {
        imc.broadcast.on("web2", async web2 => {
            console.log(web2)
        })
    },*/
}

// ANCHOR Events (aka handling incoming data)
var events = {
    // INFO Common events for both Server and Client
    common: {
        parseEvent: async function (data) {
            // TODO
        },
    },
    // INFO Events for server
    server: {
        parseEvent: async function (data) {
            // TODO
        },
    },
    // INFO Events for client
    client: {
        parseEvent: async function (data) {
            // TODO
        },
    },
}

// ANCHOR Methods
var methods = {
    // INFO Common methods for both Server and Client
    common: {
        // Getters
        getPeers: async function () {
            return peers.methods.getPeers() // REVIEW Return of a return but looks like the safer way
        },
    },
    // INFO Methods for server
    server: {
        // INFO Method to start the server
        start: async function (port) {
            server.listen(port, async () => {
                term.green("[SERVER] listening on *:" + port + "\n")
                await listeners.server_listeners()
            })
        },
    },
    // INFO Methods for client
    client: {
        // INFO Method to connect to a peer
        connectToPeer: async function (address, port) {
            address = typeof address === "undefined" ? "localhost" : address
            port = typeof port === "undefined" ? 53550 : port
            // Auto add http if not present
            if (!address.startsWith("http") && !address.startsWith("https")) {
                address = "http://" + address
            }
            print.log("[CLIENT] Connecting to peer at " + address + ":" + port)
            let connection = io(address + ":" + port)
            // Sleep 4 seconds
            await new Promise(resolve => setTimeout(resolve, 4000))
            // Check if we have the connected flag
            if (!connection.connected) return false
            // Setting up the listeners (common and client)
            let _peerForged = new Peer()
            _peerForged.identity = "placeholder" // TODO Add identity filling and verification
            _peerForged.socket = connection
            _peerForged.connection_string = address + ">" + port
            listeners.common_listeners(_peerForged)
            listeners.client_listeners(_peerForged)
            return _peerForged
        },
    },
}

module.exports = { app, events, methods, listeners }

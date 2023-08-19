/* INFO

This library contains all the functions that are used to interact with the demos blockchain.

 * IMPORTANT: This library is incomplete and is not meant to be used in production.

 * NOTE: for convenience, you are strongly encouraged to use function_name instead of calling the
 *    corresponding function directly, but you are allowed to do both.

 * To initialize a connection to the demos blockchain, you will need to call connect(rpc_url) first.

 * Besides that, nodeCall is the primary function that you will want to use. 
 *    It manages a secure communication with the node and wait for a response or a timeout. It returns a promise.

*/

/* NOTE Libraries Required
 - https://cdn.jsdelivr.net/npm/node-forge@1.3.1/lib/index.min.js
 - https://cdn.socket.io/4.6.0/socket.io.min.js
*/

/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */

// NOTE Including all in a class
import io from "socket.io-client"
import forge from "node-forge"
const md = forge.md
import { sha256 } from "js-sha256"
import SharedState from "./demos_libs/shared"

// TODO Absolutely modularize this behemoth
let demos = {
    // ANCHOR Properties
    socket: null,
    connected: false,
    registry: {},

    // SECTION Registry
    replies: {
        // INFO Insert a muid in the reply registry
        waitReply: function (muid) {
            if (!demos.registry[muid]) {
                demos.registry[muid] = null
                console.log("[DEMOS] Waiting for response for " + muid)
                console.log(demos.registry)
            }
        },

        // INFO Check if a muid is in the registry
        needReply: function (muid) {
            if (demos.registry[muid] === undefined) {
                return false
            } else {
                return true
            }
        },

        // INFO Get a reply from a muid
        getReply: function (muid) {
            return demos.registry[muid]
        },

        // NOTE As this method returns a promise, we can use it to asynchronously await for a reply
        checkReply: async function (muid) {
            let timeout = 5000 // 5 seconds
            let reply = demos.replies.getReply(muid)
            while (reply === null && timeout > 0) {
                await new Promise(resolve => setTimeout(resolve, 100))
                reply = demos.replies.getReply(muid)
                timeout -= 100
            }
            return reply // null if timeout
        },
    },
    // !SECTION Registry

    // SECTION Connection and listeners
    connect: function (rpc_url) {
        demos.socket = io.connect(rpc_url, {
            extraHeaders: {
                "Access-Control-Allow-Origin": "*",
            },
        })
        console.log("[DEMOS] Connected to server")
        demos.connected = true
        // Listeners
        demos.socket.on("connect", function () {
            console.log("[DEMOS] Connected to server")
            demos.connected = true
        })
        demos.socket.on("disconnect", function () {
            console.log("[DEMOS] Disconnected from server")
            demos.connected = false
        })
        // NOTE Reply to comlink messages
        demos.socket.on("comlink_reply", function (reply) {
            if (! reply.chain.current.currentMessage.bundle.content.message) {
                console.log("[!] [DEMOS] Received a comlink_reply without a message!")
                return
            }
            let _muid = reply.muid
            console.log("[DEMOS] Received comlink_reply: " + _muid)
            if (demos.replies.needReply(_muid)) {
                console.log("[DEMOS] Received an expected reply!")
                demos.registry[_muid] =
                    reply.chain.current.currentMessage.bundle.content.message
                //console.log(reply.chain.current.currentMessage.bundle.content.message)
            } else {
                console.log("[DEMOS] Received an unexpected reply!")
            }
        })

        // ANCHOR Catch-all (mainly for debug purposes)
        demos.socket.onAny((event, data) => {
            console.log(event)
            console.log(data)
        })
    },
    // !SECTION Connection and listeners

    // INFO Authenticating with a private key on demos
    authenticate: async function (private_key) {
        await SharedState.getInstance().setIdentity(private_key)
        let id = SharedState.getInstance().getIdentity()
        if (id === null) {
            console.log("[ERROR] Could not authenticate with private key!")
            return false
        }
        console.log("[DEMOS] Authenticated with private key!")
        console.log(id)
        return true
    },

    // INFO MUID generator
    generateMuid: function () {
        let number_1 =
            Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15)
        let number_2 =
            Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15)
        let muid = number_1 + number_2
        return muid
    },

    // SECTION NodeCall prototype
    // INFO NodeCalls use the same structure
    nodeCall: async function (message, args = {}) {
        return await demos.call("nodeCall", message, args)
    },
    // INFO NodeCalls use the same structure
    call: async function (type, message, args = {}) {
        /*if (!demos.socket.connected) {
            console.log("[ERROR] We are disconnected")
            return
        }*/
        let _muid = demos.generateMuid()
        let comlink = {
            muid: _muid,
            properties: {
                connection_string: null, // NOTE We don't have a connection_string as we are clients
                require_reply: true,
                is_reply: false,
            },
            chain: {
                current: {
                    currentMessage: null,
                    currentMessageHash: null,
                    previousHashes: [], // Keep track of the previous hashes to have full integrity
                },
                comlinkCurrentHash: null, // is the hashed version of .current
                comlinkCurrentHashSignature: null, // is the signature of the hashed version of.current
            },
        }
        let transmission = {
            bundle: {
                content: {
                    type: null,
                    message: null,
                    sender: null,
                    receiver: null,
                    timestamp: null,
                    data: null,
                    extra: null,
                },
            },
            hash: null,
            signature: null,
        }
        transmission.bundle.content.type = type
        transmission.bundle.content.message = message
        transmission.bundle.content.data = args
        comlink.chain.current.currentMessage = transmission

        // REVIEW Prior to sending the message, we hash and sign the comlink and the transmission objects
        
        // TODO Eliminate this: generating a random identity for the signature
        let seed =forge.random.getBytesSync(32)
        let keys = forge.pki.ed25519.generateKeyPair(seed)
        let privkey = keys.privateKey
        console.log(keys)
        // Signaling our identity
        comlink.chain.current.currentMessage.bundle.content.sender = keys.publicKey
        // NOTE Doing the cryptography for the transmission object
        let stringifiedTransmission = JSON.stringify(comlink.chain.current.currentMessage.bundle.content)
        let t_digestor = sha256.create()
        t_digestor.update(stringifiedTransmission)
        let t_hashed =  t_digestor.hex()
        console.log(t_hashed + " is the hashed version of comlink.chain.current.currentMessage.bundle.content")
        comlink.chain.current.currentMessage.bundle.hash = t_hashed
        comlink.chain.current.currentMessageHash = t_hashed
        // And signing it
        let t_signature = forge.pki.ed25519.sign({
            message: t_hashed,
            encoding: "utf8",
            privateKey: privkey,
        })
        console.log(t_signature.toString("hex") + " is the signature of the hashed version of comlink.chain.current.currentMessage.bundle.content")
        comlink.chain.current.currentMessage.bundle.signature = t_signature
        
        // NOTE Also hashing the comlink current property
        let stringifiedMessage = JSON.stringify(comlink.chain.current)
        let digestor = sha256.create()
        digestor.update(stringifiedMessage)
        let hashed =  digestor.hex()
        console.log(hashed + " is the hashed version of comlink.chain.current")
        comlink.chain.comlinkCurrentHash = hashed
        // Signing the hash
        //console.log(keys.publicKey.toHex() + " is the public key of the signing key")
        //console.log(keys.privateKey.toHex() + " is the private key of the signing key")
        let signature = forge.pki.ed25519.sign({
            message: hashed,
            encoding: "utf8",
            privateKey: privkey,
        })
        console.log(signature.toString("hex") + " is the signature of the hashed version of comlink.chain.current")
        comlink.chain.comlinkCurrentHashSignature = signature // FIXME TypeError in comlink.ts

        console.log(
            "Sending message " +
                message +
                " to server with muid: " +
                comlink.muid,
        )
        // Registering the reply request
        demos.replies.waitReply(_muid)
        console.log(comlink)
        demos.socket.emit("comlink", comlink)
        // Waiting for a reply
        return await demos.replies.checkReply(_muid)
    },
    // !SECTION NodeCall prototype

    // SECTION Predefined calls
    getLastBlockNumber: async function () {
        return await demos.nodeCall("getLastBlockNumber")
    },
    getLastBlockHash: async function () {
        return await demos.nodeCall("getLastBlockHash")
    },
    getBlockByNumber: async function (blockNumber) {
        let block = await demos.nodeCall("getBlockByNumber", {
            blockNumber: blockNumber,
        })
        block = JSON.parse(block)
        block.content = JSON.parse(block.content)
        console.log(typeof block)
        return block
    },
    getBlockByHash: async function (blockHash) {
        let block = await demos.nodeCall("getBlockByHash", {
            blockHash: blockHash,
        })
        block = JSON.parse(block)
        block.content = JSON.parse(block.content)
        console.log(typeof block)
        return block
    },
    // TODO Test it with davide
    getTxByHash: async function (txHash="e25860ec6a7cccff0371091fed3a4c6839b1231ccec8cf2cb36eca3533af8f11") {
        // Defaulting to the genesis tx of course
        let tx = await demos.nodeCall("getTxByHash", {
            hash: txHash,
        })
        tx = JSON.parse(tx)
        tx.content = JSON.parse(tx.content)
        console.log(typeof tx)
        return tx
    },

    // INFO Web2 Endpoints
    getWeb2Data: async function (url = "https://apple.com/robots.txt") {
        console.log("[DEMOS] Requesting url: " + url)
        return await demos.call("web2Request", {
            action: "getUrl",
            httpVerb: "GET",
            url: url,
            headers: "",
        })
    },

    getPeerlist: async function () {
        return await demos.nodeCall("getPeerlist")
    },
    getMempool: async function () {
        return await demos.nodeCall("getMempool")
    },
    getPeerIdentity: async function () {
        return await demos.nodeCall("getPeerIdentity")
    },

    getAddressInfo: async function (address) {
        return await demos.nodeCall("getAddressInfo", {
            address: address,
        })
    },
    // !SECTION Predefined calls

    // SECTION Crosschain support endpoints
    crosschain: {
        // INFO Executing a precompiled multichain operation
        execute: async function (multichain_operation) {
            let response = await demos.nodeCall("crosschain_operation", {multichain_operation})
            response = JSON.parse(response)
            return response
        },
    },
    // !SECTION Crosschain support endpoints

    // SECTION Supporting txs
    transactions: { // REVIEW All this part
        // NOTE A courtesy to get a skeleton of transactions
        empty: function () {
            return demos.skeletons.transaction
        },
        // NOTE Building a transaction without signing or hashing it
        prepare: async function (data) {
            let thisTx = demos.skeletons.transaction
            if (!data.timestamp) data.timestamp = Date.now()
            // Assigning the transaction data to our object
            thisTx.content = data
            return thisTx
        },
        // NOTE Signing a transaction after hashing it
        sign: async function (raw_tx, private_key=null) {
            // If necessary, the private key is loaded from the state
            if (!private_key) {
                let id = await SharedState.getInstance().getIdentity()
                private_key = id.privateKey
                console.log("Private key loaded from state")
            } else {
                console.log("Private key provided")
            }
            console.log(private_key)
            // Hashing the content of the transaction
            let md = forge.md.sha256.create()
            md.update(JSON.stringify(raw_tx.content))
            raw_tx.hash = md.digest().toString("hex")
            // Signing the hash of the content
            raw_tx.signature = forge.pki.ed25519.sign(raw_tx.hash, private_key) // REVIEW if it is working right
            return raw_tx // Hashed and signed
        },
        // NOTE Sending a transaction after signing it
        broadcast: async function (signed_tx) {
        // TODO: Implement and for god sake do some error handling
            return await demos.nodeCall("tx", {
                tx: signed_tx,
            }) // REVIEW It should returns either false + error or true + hash
        },
    },
    // !SECTION Supporting txs

    // INFO Calling demos.skeletons.NAME provides an empty skeleton that can be used for reference while calling other demos functions
    // SECTION Objects skeletons
    skeletons: {
        // INFO An empty transaction
        transaction: {
            content: {
                type: "", // string
                from: null, // forge.pki.ed25519.BinaryBuffer
                to: null, // forge.pki.ed25519.BinaryBuffer
                amount: 0, // number
                data: ["", ""], // [string, string] // type as string and content in hex string
                nonce: 0, // number // Increments every time a transaction is sent from the same account
                timestamp: 0, // number // Is the registered unix timestamp when the transaction was sent the first time
                transaction_fee: {
                    network_fee: 0,
                    rpc_fee: 0,
                    additional_fee: 0,
                }, 
            },
            signature: null, // pki.ed25519.BinaryBuffer
            hash: null, // string
            confirmations: [], // Confirmation[]
            state_changes: [], // StateChange[] 
        },
        // INFO An empty crosschain operation object
        crosschain_operation: {
            // TODO Implement as specified in multichainDispatcher.js if any
        },
    },
    // !SECTION Objects skeletons

}

async function sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time))
}

// Creating a demos class
//let demos = new Demos()
export default demos
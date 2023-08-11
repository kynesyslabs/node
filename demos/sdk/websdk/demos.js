/* INFO

This library contains all the functions that are used to interact with the demos blockchain.

 * IMPORTANT: This library is incomplete and is not meant to be used in production.

 * NOTE: for convenience, you are strongly encouraged to use function_name instead of calling the
 *    corresponding function directly, but you are allowed to do both.

 * To initialize a connection to the demos blockchain, you will need to call connect(rpc_url) first.

 * Besides that, nodeCall is the primary function that you will want to use. 
 *    It manages a secure communication with the node and wait for a response or a timeout. It returns a promise.

*/

/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */

// NOTE Including all in a class

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
        if (!demos.socket.connected) {
            console.log("[ERROR] We are disconnected")
            return
        }
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
        transmission.bundle.content.type = "nodeCall"
        transmission.bundle.content.message = message
        transmission.bundle.content.data = args
        comlink.chain.current.currentMessage = transmission
        console.log(
            "Sending message " +
                message +
                " to server with muid: " +
                comlink.muid,
        )
        // Registering the reply request
        demos.replies.waitReply(_muid)
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
    getTxByHash: async function (txHash="e25860ec6a7cccff0371091fed3a4c6839b1231ccec8cf2cb36eca3533af8f11") {
        // Defaulting to the genesis tx of course
        let tx = await demos.nodeCall("getTxByHash", {
            txHash: txHash,
        })
        tx = JSON.parse(tx)
        tx.content = JSON.parse(tx.content)
        console.log(typeof tx)
        return tx
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
    // !SECTION Predefined calls

    getWeb2Data: async function (url = "https://apple.com/robots.txt") {
        return await demos.nodeCall("getWeb2Data", {
            action: "getUrl",
            httpVerb: "GET",
            url: url,
            headers: "",
        })
    },
}

async function sleep(time) {
    return new Promise(resolve => setTimeout(resolve, time))
}

// Creating a demos class
//let demos = new Demos()

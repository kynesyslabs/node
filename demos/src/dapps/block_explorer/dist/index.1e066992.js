/* INFO

This library contains all the functions that are used to interact with the demos blockchain.

 * IMPORTANT: This library is incomplete and is not meant to be used in production.

 * NOTE: for convenience, you are strongly encouraged to use demos.function_name instead of calling the
 *    corresponding function directly, but you are allowed to do both.

 * To initialize a connection to the demos blockchain, you will need to call demos.connect(rpc_url) first.

 * Besides that, nodeCall is the primary function that you will want to use. 
 *    It manages a secure communication with the node and wait for a response or a timeout. It returns a promise.

*/ /* eslint-disable no-unused-vars */ /* eslint-disable no-undef */ var connected = false;
var socket;
// NOTE Including all in an object
let demos = {
    registry: {},
    // SECTION Registry for responses
    waitReply: waitReply,
    needReply: needReply,
    getReply: getReply,
    checkReply: checkReply,
    //!SECTION Registry for responses
    connect: connect,
    generateMuid: generateMuid,
    nodeCall: nodeCall,
    // SECTION Direct calls
    getLastBlockNumber: nodeCall("getLastBlockNumber"),
    getLastBlockHash: nodeCall("getLastBlockHash"),
    getBlockByNumber: async (blockNumber)=>{
        return await nodeCall("getBlockByNumber", {
            blockNumber: blockNumber
        });
    }
};
// SECTION Registry for responses
let registry = {};
function waitReply(muid) {
    if (!registry[muid]) {
        registry[muid] = null;
        console.log("[DEMOS] Waiting for response for " + muid);
        console.log(registry);
    }
}
function needReply(muid) {
    if (registry[muid] === undefined) return false;
    else return true;
}
function getReply(muid) {
    return registry[muid];
}
// NOTE As this method returns a promise, we can use it to asynchronously await for a reply
async function checkReply(muid) {
    let timeout = 5000 // 5 seconds
    ;
    let reply = getReply(muid);
    while(reply === null && timeout > 0){
        await new Promise((resolve)=>setTimeout(resolve, 100));
        reply = getReply(muid);
        timeout -= 100;
    }
    return reply // null if timeout
    ;
}
// !SECTION Registry for responses
// INFO Connection and listeners
function connect(rpc) {
    socket = io.connect(rpc, {
        extraHeaders: {
            "Access-Control-Allow-Origin": "*"
        }
    });
    console.log(socket);
    // ANCHOR Listeners for connections
    socket.on("connect", function() {
        console.log("[DEMOS] Connected to server");
        connected = true;
    });
    socket.on("disconnect", function() {
        console.log("[DEMOS] Disconnected from server");
        connected = false;
    });
    // ANCHOR Listeners for messages
    socket.on("comlink_reply", function(reply) {
        let _muid = reply.muid;
        console.log("[DEMOS] Received comlink_reply: " + _muid);
        if (needReply(_muid)) {
            console.log("[DEMOS] Received an expected reply!");
            registry[_muid] = reply.chain.current.currentMessage.bundle.content.message;
        //console.log(reply.chain.current.currentMessage.bundle.content.message)
        } else console.log("[DEMOS] Received an unexpected reply!");
    });
    // ANCHOR Catch-all (mainly for debug purposes)
    socket.onAny((event, data)=>{
        console.log(event);
        console.log(data);
    });
}
// INFO MUID generator
function generateMuid() {
    let number_1 = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let number_2 = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    let muid = number_1 + number_2;
    return muid;
}
// INFO NodeCalls use the same structure
async function nodeCall(message, args = {}) {
    if (!socket.connected) {
        console.log("[ERROR] We are disconnected");
        return;
    }
    let _muid = generateMuid();
    let comlink = {
        muid: _muid,
        properties: {
            connection_string: null,
            require_reply: true,
            is_reply: false
        },
        chain: {
            current: {
                currentMessage: null,
                currentMessageHash: null,
                previousHashes: []
            },
            comlinkCurrentHash: null,
            comlinkCurrentHashSignature: null
        }
    };
    let transmission = {
        bundle: {
            content: {
                type: null,
                message: null,
                sender: null,
                receiver: null,
                timestamp: null,
                data: null,
                extra: null
            }
        },
        hash: null,
        signature: null
    };
    transmission.bundle.content.type = "nodeCall";
    transmission.bundle.content.message = message;
    transmission.bundle.content.data = args;
    comlink.chain.current.currentMessage = transmission;
    console.log("Sending message " + message + " to server with muid: " + comlink.muid);
    // Registering the reply request
    waitReply(_muid);
    this.socket.emit("comlink", comlink);
    // Waiting for a reply
    return await checkReply(_muid);
}
async function sleep(time) {
    return new Promise((resolve)=>setTimeout(resolve, time));
}

//# sourceMappingURL=index.1e066992.js.map

/* eslint-disable no-unused-vars */ /* eslint-disable no-undef */ var connected = false;
var socket;
function connect(rpc) {
    socket = io.connect(rpc, {
        extraHeaders: {
            "Access-Control-Allow-Origin": "*"
        }
    });
    console.log(socket);
    // Listeners
    socket.on("connect", function() {
        console.log("Connected to server");
        connected = true;
    });
    socket.on("comlink_reply", function(reply) {
        console.log(reply.chain.current.currentMessage.bundle.content) // FIXME Is not the right result?
        ;
    });
    // Catch-all
    socket.onAny((event, data)=>{
        console.log(event);
        console.log(data);
    });
}
// INFO NodeCalls use the same structure
function nodeCall(message, args = {}) {
    if (!socket.connected) {
        console.log("[ERROR] We are disconnected");
        return;
    }
    let comlink = {
        muid: "test",
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
    console.log("Sending message to server with muid: " + comlink.muid);
    this.socket.emit("comlink", comlink);
}
async function sleep(time) {
    return new Promise((resolve)=>setTimeout(resolve, time));
}

//# sourceMappingURL=index.ec553b3d.js.map

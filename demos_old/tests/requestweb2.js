const connectionString = "http://localhost:53550"

const { io } = require("socket.io-client")

let connection = io(connectionString)

connection.on("connect", () => {
    console.log("Connected to the peer")
    connection.emit("comLink", {
        chain: {
            current: {
                currentMessage:
                    // eslint-disable-next-line quotes
                    '{"content":{"type":"web2Request","action":"getUrl"}}',
                currentMessageHash:
                    "6dcf966f2f4f22690d25e5c0d93ec5d730aa5aee47237253edddebbdd78d6d44",
                previousHashes: [],
            },
            comlinkCurrentHash:
                "c5fc36600b38ef06c4607da2363e660831b058eac75d6b184a838aa117e0552f",
            comlinkCurrentHashSignature: "",
        },
        muid: "3ivyf183ns1jmdw9zkjhoel99beku46lf3ocgnqf5ugq",
        properties: { require_reply: true, is_reply: false },
    })
})

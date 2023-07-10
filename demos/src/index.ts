import * as fs from "fs"
import * as express from "express"
const http = require("http") // FIXME: Use import but it breaks...
import { Server } from "socket.io"

import * as dotenv from "dotenv"
dotenv.config()

import { Identity } from "./libs/identity"
import { logger } from "./libs/utils"
import { PeerManager } from "./libs/peer"
import { server as networkServer } from "./libs/network"

import peerBootstrap from "./libs/peer/routines/peerBootstrap"
import findGenesisBlock from "./libs/blockchain/routines/findGenesisBlock"
import Sync from "./libs/blockchain/routines/Sync"

// INFO Loading the known peers
if (!fs.existsSync("./demos_peers")) {
    throw new Error("No peers found, exiting")
}

const SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 53550
const PEER_LIST = JSON.parse(fs.readFileSync("./demos_peers", "utf8"))

const id = Identity.getInstance()
const app = express()
const server = http.createServer(app)
const io_server = new Server(server, {
    cors: {
        origin: ["https://admin.socket.io", "https://amritb.github.io"],
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    },
})

// Instances of classes we need to keep in memory for the rest of the modules, as we use them as state containers which will be passed around
const peerManager = PeerManager.getInstance()

async function main() {
    // NOTE The whole first part of main ensures the environment is ready to run
    await id.ensureIdentity()
    // Log identity
    logger.log("WE ARE " + id.ed25519.publicKey.toString("hex"))

    // INFO We start the server
    logger.bootstrap("[BOOTSTRAP] Starting the server\n")
    await server.listen(SERVER_PORT)
    logger.bootstrapSuccess("[SERVER] listening on *:" + SERVER_PORT + "\n")
    await networkServer.setupListeners(io_server)

    // Loading the peers

    // INFO Setting the common variables and propagating them
    const peerList = await peerBootstrap(PEER_LIST)
    peerManager.setPeerList(peerList)
    logger.bootstrapSuccess(
        "[BOOTSTRAP] Peers loaded (" + peerManager.getPeers().length + ")\n",
    )
    // INFO Now ensuring we have an initialized chain or initializing the genesis block
    await findGenesisBlock()
    // INFO Testing the messaging endpoint
    // await message_test()
    // INFO Starting the sync loop
    logger.log("[MAIN] Starting the sync loop\n")
    Sync(id) // NOTE We don't wait for the sync to finish because it will run indefinitely in the background
}

main()

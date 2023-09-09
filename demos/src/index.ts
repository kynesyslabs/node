/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/
var term = require( "terminal-kit" ).terminal
//import process from "node:process"
import * as fs from "fs"
import * as express from "express"
const http = require("http")
import { Server } from "socket.io"

import mainLoop from "./utilities/mainLoop"
import sharedState from "./utilities/sharedState"


import * as dotenv from "dotenv"
dotenv.config()

import { Identity } from "./libs/identity"
import { logger } from "./libs/utils"
import { PeerManager } from "./libs/peer"
import { server as networkServer } from "./libs/network"

import commandLine from "./utilities/commandLine"

import peerBootstrap from "./libs/peer/routines/peerBootstrap"
import findGenesisBlock from "./libs/blockchain/routines/findGenesisBlock"
import * as bitcoin from "bitcoinjs-lib"

let enough_peers = true
// INFO Loading the known peers
if (!fs.existsSync("./demos_peers")) {
    enough_peers = false
    console.log("No peers found, listening for peers...")
}


// ANCHOR Overrides
let OVERRIDE_PORT = null
let OVERRIDE_PEER_LIST_FILE = null
let OVERRIDE_IS_TESTER = null
let COMMANDLINE_MODE = null

let RPC_FEE: number = 10 // parseInt(process.env.RPC_FEE) || 10

let SERVER_PORT: number = 53550 // parseInt(process.env.SERVER_PORT, 10) || 53550
let PEER_LIST_FILE = "./demos_peers"

let PEER_LIST: any

const id = Identity.getInstance()
const app = express()
const server = http.createServer(app)
const io_server = new Server(server, {
    cors: {
        origin: "*",
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        preflightContinue: false,
    },
})

// Instances of classes we need to keep in memory for the rest of the modules, as we use them as state containers which will be passed around
const peerManager = PeerManager.getInstance()


// ANCHOR Routine to handle parameters in advanced mode
async function digestArguments() {
    let args = process.argv
    if (args.length > 3) {
        console.log("digest arguments")
        for (let i = 3; i < args.length; i++) {
            // Handle simple commands
            if (!(args[i].includes("="))) {
                console.log("cmd: " + args[i])
                process.exit(0)
            }
            // Handle configurations
            let param = args[i].split("=")
            // NOTE These are all the parameters supported
            switch (param[0]) {
                case "port":   
                    console.log("Overriding port")
                    OVERRIDE_PORT = param[1]
                    break
                case "peerfile":
                    console.log("Overriding peer list file")
                    OVERRIDE_PEER_LIST_FILE = param[1]
                    break
                case "tester":
                    console.log("Starting in tester mode")
                    OVERRIDE_IS_TESTER = true
                    break
                case "cli":
                    console.log("Starting in cli mode")
                    COMMANDLINE_MODE = true
                    break
                default:
                    console.log("Invalid parameter: " + param)

            }
        }
    }
}

// ANCHOR Entry point
async function main() {
    // NOTE Overriding if necessary
    if (OVERRIDE_PORT) SERVER_PORT = OVERRIDE_PORT
    sharedState.getInstance().serverPort = SERVER_PORT // Sharing this with any module that needs it
    sharedState.getInstance().rpcFee = RPC_FEE
    if (OVERRIDE_PEER_LIST_FILE) PEER_LIST_FILE = OVERRIDE_PEER_LIST_FILE
    PEER_LIST = JSON.parse(fs.readFileSync(PEER_LIST_FILE, "utf8"))

    // NOTE The whole first part of main ensures the environment is ready to run
    await id.ensureIdentity()
    // Log identity
    term.green("[MAIN] WE ARE " + id.ed25519.publicKey.toString("hex") + "\n")

    try {
        await Identity.getInstance().getPublicIP()
        logger.log("IP: " + Identity.getInstance().publicIP)
    } catch (e) {
        console.log(e)
        term.orange("[WARN] {OFFLINE?} Failed to get public IP\n")
    }

    // INFO We start the server
    term.yellow("[BOOTSTRAP] Starting the server\n")
    await server.listen(SERVER_PORT)
    term.green("[SERVER] listening on *:" + SERVER_PORT + "\n")
    await networkServer.setupListeners(io_server)

    // INFO Now ensuring we have an initialized chain or initializing the genesis block
    await findGenesisBlock()

    // Loading the peers

    // INFO Setting the common variables and propagating them
    const peerList = await peerBootstrap(PEER_LIST)
    for (const peer of peerList) {
        peerManager.addPeer(peer)
    }

    logger.bootstrapSuccess(
        "[BOOTSTRAP] Peers loaded (" + peerManager.getPeers().length + ")\n",
    )
    // Checking for listening mode
    if (peerManager.getPeers().length < 1) {
        console.log("[WARNING] No peers detected, listening...")
        enough_peers = false
    }
    // TODO Enough_peers will be shared between modules so that can be checked async
    if (enough_peers) {
        // INFO Testing the messaging endpoint
        // await message_test()
        // INFO Starting the sync loop
        if (OVERRIDE_IS_TESTER) return await commandLine() // Testing mode is just for debugging or showcase purposes
        if (COMMANDLINE_MODE) commandLine() // While doing the rest of the stuff needed, a comand line interface is available
        logger.log("[MAIN] Starting the background loop\n")
        mainLoop(id) // Is an async function so running without waiting send that to the background
    }
}

/* NOTE Uncomment this to enable never-fail stupid option
// First things first: global error management to avoid total crashes
// TODO See the link below for a better solution
// LINK https://github.com/foreversd/forever
// TODO EVEN BETTER
// LINK https://github.com/foreversd/forever-monitor
process.on("uncaughtException", (err, origin) => {
    term.red.bold("[FATAL] Uncaught exception: " + err.message + "\n")
    console.log(err)
    console.log("Origin: ")
    console.log(origin)
    term.red("[WARNING] The node will continue to run but unpredictable behavior could occur\n")
})
process.on("unhandledRejection", (reason, promise) => {
    term.red.bold("[FATAL] Unhandled Rejection. Details:")
    console.log("Unhandled Rejection at:", promise, "reason:", reason)
    term.red("[WARNING] The node will continue to run but unpredictable behavior could occur\n")
})
*/
  
digestArguments()
main()

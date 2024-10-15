/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import "reflect-metadata"

import * as dotenv from "dotenv"
import * as fs from "fs"

import { getSharedState } from "./utilities/sharedState"
import { server_rpc } from "./libs/network"
import terminalkit from "terminal-kit"

import findGenesisBlock from "./libs/blockchain/routines/findGenesisBlock"
// import * as eiows from 'eiows';
import { PeerManager } from "./libs/peer"
// import commandLine from "./utilities/commandLine"
import peerBootstrap from "./libs/peer/routines/peerBootstrap"
import groundControl from "./libs/utils/demostdlib/groundControl"
import mainLoop from "./utilities/mainLoop"
import log from "src/utilities/logger"
import { Peer } from "./libs/peer"
import { getNetworkTimestamp } from "./libs/utils/calibrateTime"
import getTimestampCorrection from "./libs/utils/calibrateTime"

const term = terminalkit.terminal

dotenv.config()

// INFO Cleaning the logs directory (except custom logs)
log.cleanLogs(false)

log.info("[MAIN] Starting the node")

let enough_peers = true // ? Review this
// INFO Loading the known peers
if (!fs.existsSync("./demos_peerlist.json")) {
    enough_peers = false
    console.log("No peers found, listening for peers...")
}

// ANCHOR Overrides
let OVERRIDE_PORT = null
let OVERRIDE_IS_TESTER = null
let COMMANDLINE_MODE = null

let PeerList: Peer[]

/* SECTION Environment variables loading and configuration */
let RPC_FEE: number = parseInt(process.env.RPC_FEE) || 10
// Allow overriding pg port through RPC_PG_PORT
let PG_PORT: number = parseInt(process.env.RPC_PG_PORT, 10) || 5332
// Allow overriding server port through RPC_PORT
let SERVER_PORT: number = parseInt(process.env.RPC_PORT, 10) || 0
if (SERVER_PORT == 0) {
    SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 53550
}
// Setting the server port to the shared state
getSharedState.serverPort = SERVER_PORT
// Exposed URL
getSharedState.connectionString =
    process.env.EXPOSED_URL || "http://localhost:" + SERVER_PORT
/* !SECTION Environment variables loading and configuration */

console.log("= Configured environment variables = \n")
console.log("PG_PORT: " + PG_PORT)
console.log("RPC_FEE: " + RPC_FEE)
console.log("SERVER_PORT: " + SERVER_PORT)
console.log("= End of Configuration = \n")
// Configure the logs directory
log.setLogsDir(SERVER_PORT)
// ? REVIEW Starting the server_rpc: should we keep this async?
// This should start the server_rpc without any other needed operation
log.info("[MAIN] Starting the RPC server")
server_rpc()

// Instances of classes we need to keep in memory for the rest of the modules, as we use them as state containers which will be passed around
const peerManager = PeerManager.getInstance()
console.log("[MAIN] peerManager started")

// ANCHOR Calibrating the time
async function calibrateTime() {
    await getTimestampCorrection()
    console.log("Timestamp correction: " + getSharedState.timestampCorrection)
    console.log("Network timestamp: " + getNetworkTimestamp())
}

// ANCHOR Routine to handle parameters in advanced mode
async function digestArguments() {
    let args = process.argv
    if (args.length > 3) {
        console.log("digest arguments")
        for (let i = 3; i < args.length; i++) {
            // Handle simple commands
            if (!args[i].includes("=")) {
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
                    log.warning(
                        "WARNING: Overriding peer list file is not supported anymore (see PeerManager)",
                    )
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
    // INFO Calibrating the time at the start of the node
    await calibrateTime()
    // NOTE Overriding if necessary
    if (OVERRIDE_PORT) {
        SERVER_PORT = OVERRIDE_PORT
    }
    getSharedState.serverPort = SERVER_PORT // Sharing this with any module that needs it
    getSharedState.rpcFee = RPC_FEE

    // ANCHOR The whole first part of main ensures the environment is ready to run
    await getSharedState.identity.ensureIdentity() // ? Should we generate the identity option based too? (see SERVER_PORT and others    )
    const id = getSharedState.identity
    term.green("[BOOTSTRAP] Our identity is ready\n")
    // Log identity
    term.green(
        "\n[MAIN] 🔗 WE ARE " + id.ed25519.publicKey.toString("hex") + " 🔗 \n",
    )
    // Creating ourselves as a peer // ? Should this be removed in production?
    let ourselves = "http://127.0.0.1:" + SERVER_PORT
    getSharedState.connectionString = ourselves
    log.info("Our connection string is: " + ourselves)
    // And saves the public key file
    const publicKeyHex = id.ed25519.publicKey.toString("hex")
    fs.writeFileSync("publickey_" + publicKeyHex, publicKeyHex + "\n")
    log.info("Our public key is: " + publicKeyHex)

    // ANCHOR Preparing the peer manager and loading the peer list
    PeerManager.getInstance().loadPeerList()
    PeerList = PeerManager.getInstance().getPeers()
    term.green("[BOOTSTRAP] Loaded a list of peers:\n")

    for (const peer of PeerList) {
        console.log(peer.identity + " @ " + peer.connection.string)
    }

    // ANCHOR Getting the public IP to check if we're online
    try {
        await getSharedState.identity.getPublicIP()
        term.green("IP: " + getSharedState.identity.publicIP + "\n")
    } catch (e) {
        console.log(e)
        term.yellow("[WARN] {OFFLINE?} Failed to get public IP\n")
    }

    // ANCHOR Looking for the genesis block
    term.yellow("[BOOTSTRAP] Looking for the genesis block\n")
    // INFO Now ensuring we have an initialized chain or initializing the genesis block
    await findGenesisBlock()
    term.green("[GENESIS] 🖥️ Found the genesis block\n")

    // Loading the peers
    //PeerList.push(ourselves)

    // ANCHOR Bootstrapping the peers
    term.yellow("[BOOTSTRAP] 🌐 Bootstrapping peers...\n")
    console.log(PeerList)
    await peerBootstrap(PeerList)
    // ? Remove the following code if it's not needed: peerManager.addPeer(peer) is called within peerBootstrap (hello_peer routines)
    /*for (const peer of peerList) {
        peerManager.addPeer(peer)
    }*/

    term.green(
        "[BOOTSTRAP] 🌐 Peers loaded (" + peerManager.getPeers().length + ")\n",
    )

    //console.log(peerManager.getPeers())

    // Checking for listening mode
    if (peerManager.getPeers().length < 1) {
        console.log("[WARNING] 🔍 No peers detected, listening...")
        enough_peers = false
    }
    // TODO Enough_peers will be shared between modules so that can be checked async
    if (enough_peers) {
        // INFO Testing the messaging endpoint
        // await message_test()
        // INFO Starting the sync loop
        if (OVERRIDE_IS_TESTER) {
            // return await commandLine() // Testing mode is just for debugging or showcase purposes
        }
        if (COMMANDLINE_MODE) {
            // commandLine() // While doing the rest of the stuff needed, a comand line interface is available
        }
        term.yellow("[MAIN] ✅ Starting the background loop\n")
        // ANCHOR Starting the main loop
        mainLoop() // Is an async function so running without waiting send that to the background
    }
}

// INFO Starting the main routine
digestArguments()
main()

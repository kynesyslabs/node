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
import { server_rpc } from "./libs/network" // NOTE This is started in warmup
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

import { SignalingServer } from "./features/InstantMessagingProtocol/signalingServer/signalingServer"

const term = terminalkit.terminal

dotenv.config()

// NOTE This is a global variable that will be used to store the warmup routine and the index needed variables
const indexState: {
    OVERRIDE_PORT: number | null
    OVERRIDE_IS_TESTER: boolean | null
    COMMANDLINE_MODE: boolean | null
    RPC_FEE: number
    SERVER_PORT: number
    SIGNALING_SERVER_PORT: number
    EXPOSED_URL: string
    PG_PORT: number
    enough_peers: boolean
    PeerList: Peer[]
    peerManager: PeerManager
} = {
    OVERRIDE_PORT: null,
    OVERRIDE_IS_TESTER: null,
    COMMANDLINE_MODE: null,
    RPC_FEE: 10,
    SERVER_PORT: 0,
    SIGNALING_SERVER_PORT: 0,
    EXPOSED_URL: "",
    PG_PORT: 5332,
    enough_peers: true,
    PeerList: [],
    peerManager: null,
}

// SECTION Preparation methods

// ANCHOR Calibrating the time
async function calibrateTime() {
    await getTimestampCorrection()
    console.log("Timestamp correction: " + getSharedState.timestampCorrection)
    console.log("Network timestamp: " + getNetworkTimestamp())
}
// ANCHOR Routine to handle parameters in advanced mode
async function digestArguments() {
    const args = process.argv
    if (args.length > 3) {
        console.log("digest arguments")
        for (let i = 3; i < args.length; i++) {
            // Handle simple commands
            if (!args[i].includes("=")) {
                console.log("cmd: " + args[i])
                process.exit(0)
            }
            // Handle configurations
            const param = args[i].split("=")
            // NOTE These are all the parameters supported
            switch (param[0]) {
                case "port":
                    console.log("Overriding port")
                    indexState.OVERRIDE_PORT = parseInt(param[1])
                    break
                case "peerfile":
                    log.warning(
                        "WARNING: Overriding peer list file is not supported anymore (see PeerManager)",
                    )
                    break
                case "tester":
                    console.log("Starting in tester mode")
                    indexState.OVERRIDE_IS_TESTER = true
                    break
                case "cli":
                    console.log("Starting in cli mode")
                    indexState.COMMANDLINE_MODE = true
                    break
                default:
                    console.log("Invalid parameter: " + param)
            }
        }
    }
}
// ANCHOR Warmup method
async function warmup() {
    // INFO Cleaning the logs directory (except custom logs)
    log.cleanLogs(false)

    log.info("[MAIN] Starting the node")

    indexState.enough_peers = true // ? Review this
    // INFO Loading the known peers
    if (!fs.existsSync("./demos_peerlist.json")) {
        indexState.enough_peers = false
        console.log("No peers found, listening for peers...")
    }

    // ANCHOR Overrides
    indexState.OVERRIDE_PORT = null
    indexState.OVERRIDE_IS_TESTER = null
    indexState.COMMANDLINE_MODE = null

    /* SECTION Environment variables loading and configuration */
    indexState.RPC_FEE = parseInt(process.env.RPC_FEE) || 10
    // Allow overriding pg port through RPC_PG_PORT
    indexState.PG_PORT = parseInt(process.env.RPC_PG_PORT, 10) || 5332
    // Allow overriding server port through RPC_PORT
    indexState.SERVER_PORT = parseInt(process.env.RPC_PORT, 10) || 0
    if (indexState.SERVER_PORT == 0) {
        indexState.SERVER_PORT = parseInt(process.env.SERVER_PORT, 10) || 53550
    }
    // Allow overriding signaling server port through RPC_SIGNALING_PORT
    indexState.SIGNALING_SERVER_PORT = parseInt(process.env.RPC_SIGNALING_PORT, 10) || 0
    if (indexState.SIGNALING_SERVER_PORT == 0) {
        indexState.SIGNALING_SERVER_PORT = parseInt(process.env.SIGNALING_SERVER_PORT, 10) || 3005
    }
    // Setting the server port to the shared state
    getSharedState.serverPort = indexState.SERVER_PORT
    // Exposed URL
    getSharedState.connectionString =
        process.env.EXPOSED_URL || "http://localhost:" + indexState.SERVER_PORT
    /* !SECTION Environment variables loading and configuration */

    console.log("= Configured environment variables = \n")
    console.log("PG_PORT: " + indexState.PG_PORT)
    console.log("RPC_FEE: " + indexState.RPC_FEE)
    console.log("SERVER_PORT: " + indexState.SERVER_PORT)
    console.log("SIGNALING_SERVER_PORT: " + indexState.SIGNALING_SERVER_PORT)
    console.log("= End of Configuration = \n")
    // Configure the logs directory
    log.setLogsDir(indexState.SERVER_PORT)
    // ? REVIEW Starting the server_rpc: should we keep this async?
    // This should start the server_rpc without any other needed operation
    log.info("[MAIN] Starting the RPC server")
    server_rpc()

    indexState.peerManager = PeerManager.getInstance()
    console.log("[MAIN] peerManager started")

    // Digest the arguments
    await digestArguments()
}
// ANCHOR Preparing the main loop
// ! Simplify this too
async function preMainLoop() {
    // NOTE Overriding if necessary
    if (indexState.OVERRIDE_PORT) {
        indexState.SERVER_PORT = indexState.OVERRIDE_PORT
    }
    getSharedState.serverPort = indexState.SERVER_PORT // Sharing this with any module that needs it
    getSharedState.rpcFee = indexState.RPC_FEE

    // ANCHOR The whole first part of main ensures the environment is ready to run
    await getSharedState.identity.ensureIdentity() // ? Should we generate the identity option based too? (see SERVER_PORT and others    )
    const id = getSharedState.identity
    term.green("[BOOTSTRAP] Our identity is ready\n")
    // Log identity
    term.green(
        "\n[MAIN] 🔗 WE ARE " + id.ed25519.publicKey.toString("hex") + " 🔗 \n",
    )
    // Creating ourselves as a peer // ? Should this be removed in production?
    const ourselves = "http://127.0.0.1:" + indexState.SERVER_PORT
    getSharedState.connectionString = ourselves
    log.info("Our connection string is: " + ourselves)
    // And saves the public key file
    const publicKeyHex = id.ed25519.publicKey.toString("hex")
    fs.writeFileSync("publickey_" + publicKeyHex, publicKeyHex + "\n")
    log.info("Our public key is: " + publicKeyHex)

    // ANCHOR Preparing the peer manager and loading the peer list
    PeerManager.getInstance().loadPeerList()
    indexState.PeerList = PeerManager.getInstance().getPeers()
    term.green("[BOOTSTRAP] Loaded a list of peers:\n")

    for (const peer of indexState.PeerList) {
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
    console.log(indexState.PeerList)
    await peerBootstrap(indexState.PeerList)
    // ? Remove the following code if it's not needed: indexState.peerManager.addPeer(peer) is called within peerBootstrap (hello_peer routines)
    /*for (const peer of peerList) {
        peerManager.addPeer(peer)
    }*/

    term.green(
        "[BOOTSTRAP] 🌐 Peers loaded (" +
            indexState.peerManager.getPeers().length +
            ")\n",
    )
}

// ANCHOR Entry point
async function main() {
    // INFO Warming up the node (including arguments digesting)
    await warmup()
    // INFO Calibrating the time at the start of the node
    await calibrateTime()
    // INFO Preparing the main loop
    await preMainLoop()

    // ANCHOR Based on the above methods, we can now start the main loop
    // Checking for listening mode
    if (indexState.peerManager.getPeers().length < 1) {
        console.log("[WARNING] 🔍 No peers detected, listening...")
        indexState.enough_peers = false
    }
    // TODO Enough_peers will be shared between modules so that can be checked async
    if (indexState.enough_peers) {
        // INFO Testing the messaging endpoint
        // await message_test()
        // INFO Starting the sync loop
        if (indexState.OVERRIDE_IS_TESTER) {
            // return await commandLine() // Testing mode is just for debugging or showcase purposes
        }
        if (indexState.COMMANDLINE_MODE) {
            // commandLine() // While doing the rest of the stuff needed, a comand line interface is available
        }
        // Starting the signaling server
        const signalingServer = new SignalingServer(indexState.SIGNALING_SERVER_PORT)
        if (signalingServer) {
            getSharedState.isSignalingServerStarted = true
            console.log("[MAIN] Signaling server started")
        } else {
            console.log("[MAIN] Failed to start the signaling server")
            process.exit(1)
        }
        term.yellow("[MAIN] ✅ Starting the background loop\n")
        // ANCHOR Starting the main loop
        mainLoop() // Is an async function so running without waiting send that to the background
    }
}

// INFO Starting the main routine
main()

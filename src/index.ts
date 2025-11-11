/* eslint-disable no-unused-vars */
/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import net from "net"
import * as fs from "fs"
import "reflect-metadata"
import * as dotenv from "dotenv"
import { Peer } from "./libs/peer"
import { PeerManager } from "./libs/peer"
import log, { TUIManager, CategorizedLogger } from "src/utilities/logger"
import Chain from "./libs/blockchain/chain"
import mainLoop from "./utilities/mainLoop"
import { serverRpcBun } from "./libs/network/server_rpc"
import { getSharedState } from "./utilities/sharedState"
import peerBootstrap from "./libs/peer/routines/peerBootstrap"
import { getNetworkTimestamp } from "./libs/utils/calibrateTime"
import getTimestampCorrection from "./libs/utils/calibrateTime"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import findGenesisBlock from "./libs/blockchain/routines/findGenesisBlock"
import { SignalingServer } from "./features/InstantMessagingProtocol/signalingServer/signalingServer"
import loadGenesisIdentities from "./libs/blockchain/routines/loadGenesisIdentities"
import { startOmniProtocolServer, stopOmniProtocolServer } from "./libs/omniprotocol/integration/startup"

dotenv.config()

// NOTE This is a global variable that will be used to store the warmup routine and the index needed variables
const indexState: {
    OVERRIDE_PORT: number | null
    OVERRIDE_IS_TESTER: boolean | null
    COMMANDLINE_MODE: boolean | null
    TUI_ENABLED: boolean
    RPC_FEE: number
    SERVER_PORT: number
    SIGNALING_SERVER_PORT: number
    EXPOSED_URL: string
    PG_PORT: number
    enough_peers: boolean
    PeerList: Peer[]
    peerManager: PeerManager
    MCP_SERVER_PORT: number
    MCP_ENABLED: boolean
    mcpServer: any
    tuiManager: TUIManager | null
} = {
    OVERRIDE_PORT: null,
    OVERRIDE_IS_TESTER: null,
    COMMANDLINE_MODE: null,
    TUI_ENABLED: true, // TUI enabled by default, use --no-tui to disable
    RPC_FEE: 10,
    SERVER_PORT: 0,
    SIGNALING_SERVER_PORT: 0,
    EXPOSED_URL: "",
    PG_PORT: 5332,
    enough_peers: true,
    PeerList: [],
    peerManager: null,
    MCP_SERVER_PORT: 0,
    MCP_ENABLED: true,
    mcpServer: null,
    tuiManager: null,
}

// SECTION Preparation methods

// ANCHOR Calibrating the time
async function calibrateTime() {
    await getTimestampCorrection()
    log.info("[SYNC] Timestamp correction: " + getSharedState.timestampCorrection)
    log.info("[SYNC] Network timestamp: " + getNetworkTimestamp())
}
// ANCHOR Routine to handle parameters in advanced mode
async function digestArguments() {
    const args = process.argv
    if (args.length > 3) {
        log.debug("[MAIN] Digesting arguments")
        for (let i = 3; i < args.length; i++) {
            // Handle simple commands
            if (!args[i].includes("=")) {
                log.info("[MAIN] cmd: " + args[i])
                process.exit(0)
            }
            // Handle configurations
            const param = args[i].split("=")
            // NOTE These are all the parameters supported
            switch (param[0]) {
                case "port":
                    log.info("[MAIN] Overriding port")
                    indexState.OVERRIDE_PORT = parseInt(param[1])
                    break
                case "peerfile":
                    log.warning(
                        "[PEER] Overriding peer list file is not supported anymore (see PeerManager)",
                    )
                    break
                case "tester":
                    log.info("[MAIN] Starting in tester mode")
                    indexState.OVERRIDE_IS_TESTER = true
                    break
                case "cli":
                    log.info("[MAIN] Starting in cli mode")
                    indexState.COMMANDLINE_MODE = true
                    break
                case "no-tui":
                    log.info("[MAIN] TUI disabled, using scrolling log output")
                    indexState.TUI_ENABLED = false
                    break
                default:
                    log.warning("[MAIN] Invalid parameter: " + param)
            }
        }
    }
}

async function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once("error", err => {
            server.close()
            if (err["code"] == "EADDRINUSE") {
                resolve(false)
            } else {
                resolve(false) // or throw error!!
                // reject(err);
            }
        })

        server.once("listening", () => {
            resolve(true)
            server.close()
        })
        server.listen(port)
    })
}

async function getNextAvailablePort(startFrom: number) {
    let availablePort: number = null
    while (startFrom < 65535 || !!availablePort) {
        if (await isPortAvailable(startFrom)) {
            availablePort = startFrom
            break
        }
        startFrom++
    }
    return availablePort
}

// ANCHOR Warmup method
async function warmup() {
    // INFO Cleaning the logs directory (except custom logs)
    log.cleanLogs(false)

    log.info("[MAIN] Starting the node")

    indexState.enough_peers = true // ? Review this

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
    indexState.SIGNALING_SERVER_PORT =
        parseInt(process.env.RPC_SIGNALING_PORT, 10) || 0
    if (indexState.SIGNALING_SERVER_PORT == 0) {
        indexState.SIGNALING_SERVER_PORT =
            parseInt(process.env.SIGNALING_SERVER_PORT, 10) || 3005
    }

    // Use next available port for the signaling server
    // (useful when we have multiple nodes running the same code on the same machine)
    indexState.SIGNALING_SERVER_PORT = await getNextAvailablePort(
        indexState.SIGNALING_SERVER_PORT,
    )

    // MCP Server configuration
    indexState.MCP_SERVER_PORT = parseInt(process.env.RPC_MCP_PORT, 10) || 0
    if (indexState.MCP_SERVER_PORT == 0) {
        indexState.MCP_SERVER_PORT =
            parseInt(process.env.MCP_SERVER_PORT, 10) || 3001
    }
    indexState.MCP_ENABLED = process.env.MCP_ENABLED !== "false"

    // OmniProtocol TCP Server configuration
    indexState.OMNI_ENABLED = process.env.OMNI_ENABLED === "true"
    indexState.OMNI_PORT = parseInt(process.env.OMNI_PORT, 10) || (indexState.SERVER_PORT + 1)

    // Setting the server port to the shared state
    getSharedState.serverPort = indexState.SERVER_PORT
    // Exposed URL
    getSharedState.connectionString =
        process.env.EXPOSED_URL || "http://localhost:" + indexState.SERVER_PORT
    /* !SECTION Environment variables loading and configuration */

    log.info("[MAIN] = Configured environment variables =")
    log.info("[MAIN] PG_PORT: " + indexState.PG_PORT)
    log.info("[MAIN] RPC_FEE: " + indexState.RPC_FEE)
    log.info("[MAIN] SERVER_PORT: " + indexState.SERVER_PORT)
    log.info("[MAIN] SIGNALING_SERVER_PORT: " + indexState.SIGNALING_SERVER_PORT)
    log.info("[MAIN] MCP_SERVER_PORT: " + indexState.MCP_SERVER_PORT)
    log.info("[MAIN] MCP_ENABLED: " + indexState.MCP_ENABLED)
    log.info("[MAIN] = End of Configuration =")
    // Configure the logs directory
    log.setLogsDir(indexState.SERVER_PORT)
    // ? REVIEW Starting the server_rpc: should we keep this async?
    // This should start the server_rpc without any other needed operation
    log.info("[MAIN] Starting the RPC server")
    //server_rpc()
    serverRpcBun()
    indexState.peerManager = PeerManager.getInstance()
    log.info("[MAIN] peerManager started")

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

    // INFO: Initialize Unified Crypto with ed25519 private key
    getSharedState.keypair = await getSharedState.identity.loadIdentity()

    log.info("[BOOTSTRAP] Our identity is ready")
    // Log identity
    const publicKeyHex = uint8ArrayToHex(
        getSharedState.keypair.publicKey as Uint8Array,
    )
    log.info("[MAIN] 🔗 WE ARE " + publicKeyHex + " 🔗")
    // Creating ourselves as a peer // ? Should this be removed in production?
    const ourselves = "http://127.0.0.1:" + indexState.SERVER_PORT
    getSharedState.connectionString = ourselves
    log.info("Our connection string is: " + ourselves)
    // And saves the public key file
    await fs.promises.writeFile(
        "publickey_" + getSharedState.signingAlgorithm + "_" + publicKeyHex,
        publicKeyHex + "\n",
    )
    log.info("Our public key is: " + publicKeyHex)

    // ANCHOR Preparing the peer manager and loading the peer list
    PeerManager.getInstance().loadPeerList()
    indexState.PeerList = PeerManager.getInstance().getPeers()
    log.info("[PEER] Loaded a list of peers:")

    for (const peer of indexState.PeerList) {
        log.info("[PEER] " + peer.identity + " @ " + peer.connection.string)
    }

    // ANCHOR Getting the public IP to check if we're online
    try {
        await getSharedState.identity.getPublicIP()
        log.info("[NETWORK] IP: " + getSharedState.identity.publicIP)
    } catch (e) {
        log.debug("[NETWORK] " + e)
        log.warning("[NETWORK] {OFFLINE?} Failed to get public IP")
    }

    // ANCHOR Looking for the genesis block
    log.info("[BOOTSTRAP] Looking for the genesis block")
    // INFO Now ensuring we have an initialized chain or initializing the genesis block
    await findGenesisBlock()
    await loadGenesisIdentities()
    log.info("[CHAIN] 🖥️ Found the genesis block")

    // Loading the peers
    //PeerList.push(ourselves)

    // ANCHOR Bootstrapping the peers
    log.info("[PEER] 🌐 Bootstrapping peers...")
    log.debug("[PEER] Peer list: " + JSON.stringify(indexState.PeerList.map(p => p.identity)))
    await peerBootstrap(indexState.PeerList)
    // ? Remove the following code if it's not needed: indexState.peerManager.addPeer(peer) is called within peerBootstrap (hello_peer routines)
    /*for (const peer of peerList) {
        peerManager.addPeer(peer)
    }*/

    log.info(
        "[PEER] 🌐 Peers loaded (" +
            indexState.peerManager.getPeers().length +
            ")",
    )
    // INFO: Set initial last block data
    const lastBlock = await Chain.getLastBlock()
    getSharedState.lastBlockNumber = lastBlock.number
    getSharedState.lastBlockHash = lastBlock.hash
}

// ANCHOR Entry point
async function main() {
    // Check for --no-tui flag early (before warmup processes args fully)
    if (process.argv.includes("no-tui") || process.argv.includes("--no-tui")) {
        indexState.TUI_ENABLED = false
    }

    // Initialize TUI if enabled
    if (indexState.TUI_ENABLED) {
        try {
            indexState.tuiManager = TUIManager.getInstance()
            // Enable TUI mode in logger (suppresses direct terminal output)
            CategorizedLogger.getInstance().enableTuiMode()
            // Start the TUI
            await indexState.tuiManager.start()
            // Set initial node info
            indexState.tuiManager.updateNodeInfo({
                version: "1.0.0",
                status: "starting",
                publicKey: "Loading...",
                port: 0,
                peersCount: 0,
                blockNumber: 0,
                isSynced: false,
            })

            // Listen for quit event from TUI for graceful shutdown
            indexState.tuiManager.on("quit", () => {
                log.info("[MAIN] Graceful shutdown initiated...")

                // Set a timeout fallback for forced termination
                const forceExitTimeout = setTimeout(() => {
                    log.warning("[MAIN] Graceful shutdown timeout, forcing exit...")
                    process.exit(1)
                }, 5000)

                // Perform cleanup operations
                Promise.resolve()
                    .then(async () => {
                        // Disconnect peers gracefully
                        if (indexState.peerManager) {
                            log.info("[MAIN] Disconnecting peers...")
                            // PeerManager cleanup if available
                        }

                        // Close MCP server if running
                        if (indexState.mcpServer) {
                            log.info("[MAIN] Stopping MCP server...")
                        }

                        log.info("[MAIN] Shutdown complete.")
                    })
                    .catch(err => {
                        log.error(`[MAIN] Error during shutdown: ${err}`)
                    })
                    .finally(() => {
                        clearTimeout(forceExitTimeout)
                        process.exit(0)
                    })
            })
        } catch (error) {
            console.error("Failed to start TUI, falling back to standard output:", error)
            indexState.TUI_ENABLED = false
        }
    }

    await Chain.setup()
    // INFO Warming up the node (including arguments digesting)
    await warmup()

    // Update TUI with port info after warmup
    if (indexState.TUI_ENABLED && indexState.tuiManager) {
        indexState.tuiManager.updateNodeInfo({
            port: indexState.SERVER_PORT,
        })
    }

    // INFO Calibrating the time at the start of the node
    await calibrateTime()
    // INFO Preparing the main loop
    await preMainLoop()

    // Update TUI with identity and chain info after preMainLoop
    if (indexState.TUI_ENABLED && indexState.tuiManager) {
        const publicKeyHex = uint8ArrayToHex(
            getSharedState.keypair.publicKey as Uint8Array,
        )
        indexState.tuiManager.updateNodeInfo({
            publicKey: publicKeyHex.slice(0, 16) + "...",
            peersCount: indexState.peerManager.getPeers().length,
            blockNumber: getSharedState.lastBlockNumber,
            status: "syncing",
        })
    }

    // ANCHOR Based on the above methods, we can now start the main loop
    // Checking for listening mode
    if (indexState.peerManager.getPeers().length < 1) {
        log.warning("[PEER] 🔍 No peers detected, listening...")
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
        const signalingServer = new SignalingServer(
            indexState.SIGNALING_SERVER_PORT,
        )
        if (signalingServer) {
            getSharedState.isSignalingServerStarted = true
            log.info("[NETWORK] Signaling server started")
        } else {
            log.error("[NETWORK] Failed to start the signaling server")
            process.exit(1)
        }

        // Start OmniProtocol TCP server (optional)
        if (indexState.OMNI_ENABLED) {
            try {
                const omniServer = await startOmniProtocolServer({
                    enabled: true,
                    port: indexState.OMNI_PORT,
                    maxConnections: 1000,
                    authTimeout: 5000,
                    connectionTimeout: 600000, // 10 minutes
                })
                indexState.omniServer = omniServer
                console.log(
                    `[MAIN] ✅ OmniProtocol server started on port ${indexState.OMNI_PORT}`,
                )
            } catch (error) {
                console.log("[MAIN] ⚠️  Failed to start OmniProtocol server:", error)
                // Continue without OmniProtocol (failsafe - falls back to HTTP)
            }
        } else {
            console.log("[MAIN] OmniProtocol server disabled (set OMNI_ENABLED=true to enable)")
        }

        // Start MCP server (failsafe)
        if (indexState.MCP_ENABLED) {
            try {
                const { createDemosMCPServer, createDemosNetworkTools } =
                    await import("./features/mcp")

                indexState.MCP_SERVER_PORT = await getNextAvailablePort(
                    indexState.MCP_SERVER_PORT,
                )

                const mcpServer = createDemosMCPServer({
                    transport: "sse",
                    port: indexState.MCP_SERVER_PORT,
                    host: "localhost",
                })

                const tools = createDemosNetworkTools()
                tools.forEach(tool => mcpServer.registerTool(tool))

                await mcpServer.start()

                indexState.mcpServer = mcpServer
                getSharedState.isMCPServerStarted = true
                log.info(
                    `[MCP] MCP server started on port ${indexState.MCP_SERVER_PORT}`,
                )
            } catch (error) {
                log.error("[MCP] Failed to start MCP server: " + error)
                getSharedState.isMCPServerStarted = false
                // Continue without MCP (failsafe)
            }
        }
        log.info("[MAIN] ✅ Starting the background loop")

        // Update TUI status to running
        if (indexState.TUI_ENABLED && indexState.tuiManager) {
            indexState.tuiManager.updateNodeInfo({
                status: "running",
                isSynced: getSharedState.syncStatus,
            })
        }

        // ANCHOR Starting the main loop
        mainLoop() // Is an async function so running without waiting send that to the background
    }
}

// INFO Starting the main routine
main()

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
    console.log(`\n[SHUTDOWN] Received ${signal}, shutting down gracefully...`)

    try {
        // Stop OmniProtocol server if running
        if (indexState.omniServer) {
            console.log("[SHUTDOWN] Stopping OmniProtocol server...")
            await stopOmniProtocolServer()
        }

        // Stop MCP server if running
        if (indexState.mcpServer) {
            console.log("[SHUTDOWN] Stopping MCP server...")
            try {
                await indexState.mcpServer.stop()
            } catch (error) {
                console.error("[SHUTDOWN] Error stopping MCP server:", error)
            }
        }

        console.log("[SHUTDOWN] Cleanup complete, exiting...")
        process.exit(0)
    } catch (error) {
        console.error("[SHUTDOWN] Error during shutdown:", error)
        process.exit(1)
    }
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))

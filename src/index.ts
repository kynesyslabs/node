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
import Chain from "./libs/blockchain/chain"
import mainLoop from "./utilities/mainLoop"
import { Waiter } from "./utilities/waiter"
import { TimeoutError, AbortError } from "@/errors"
import {
    startOmniProtocolServer,
    stopOmniProtocolServer,
} from "./libs/omniprotocol/integration/startup"
import { serverRpcBun } from "./libs/network/server_rpc"
import { getSharedState } from "./utilities/sharedState"
import {
    markSubsystem,
    subsystemError,
} from "./utilities/subsystemRegistry"
import { fastSync } from "./libs/blockchain/routines/Sync"
import peerBootstrap from "./libs/peer/routines/peerBootstrap"
import { getNetworkTimestamp } from "./libs/utils/calibrateTime"
import getTimestampCorrection from "./libs/utils/calibrateTime"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import findGenesisBlock from "./libs/blockchain/routines/findGenesisBlock"
import { ensureValidatorSeed } from "./libs/blockchain/routines/ensureValidatorSeed"
import { loadNetworkParameters } from "./libs/blockchain/routines/loadNetworkParameters"
import { SignalingServer } from "./features/InstantMessagingProtocol/signalingServer/signalingServer"
import log, { TUIManager, CategorizedLogger } from "src/utilities/logger"
import loadGenesisIdentities from "./libs/blockchain/routines/loadGenesisIdentities"
// DTR and L2PS imports
import Mempool from "./libs/blockchain/mempool"
import TxValidatorPool from "./libs/blockchain/validation/txValidatorPool"
import { DTRManager } from "./libs/network/dtr/dtrmanager"
import { L2PSHashService } from "./libs/l2ps/L2PSHashService"
import { L2PSBatchAggregator } from "./libs/l2ps/L2PSBatchAggregator"
import ParallelNetworks from "./libs/l2ps/parallelNetworks"

dotenv.config()

// Global error handlers — prevent crashes on unhandled errors.
// Uses the unified error module for consistent logging and classification.
import { handleError, ErrorSource } from "src/errors"
import { Config } from "src/config"

process.on("uncaughtException", (error: Error) => {
    handleError(error, "CORE", { source: ErrorSource.UNCAUGHT_EXCEPTION })
    // Record for /health + Prometheus observability (Epic 13 T8).
    // Swallow + continue behaviour preserved — observability only.
    try {
        getSharedState.uncaughtExceptionTotal++
        getSharedState.lastUncaughtException = {
            at: Date.now(),
            source: "uncaught_exception",
            message: error instanceof Error ? error.message : String(error),
        }
        // void + catch so a failed import inside the exception
        // handler doesn't emit a new unhandledRejection and re-enter
        // this hook. Bookkeeping is best-effort.
        void import("@/features/metrics")
            .then(({ getMetricsService }) => {
                try {
                    getMetricsService().incrementCounter(
                        "uncaught_exception_total",
                        { source: "uncaught_exception" },
                        1,
                    )
                } catch {
                    /* metrics not ready */
                }
            })
            .catch(() => {
                /* metrics import failed; original error already logged */
            })
    } catch {
        // SharedState may be mid-initialisation on a very early crash —
        // never let bookkeeping mask the original error.
    }
    // Don't exit — let the node try to continue serving RPC
})

process.on("unhandledRejection", (reason: unknown) => {
    handleError(reason, "CORE", { source: ErrorSource.UNHANDLED_REJECTION })
    try {
        getSharedState.unhandledRejectionTotal++
        getSharedState.lastUncaughtException = {
            at: Date.now(),
            source: "unhandled_rejection",
            message: reason instanceof Error ? reason.message : String(reason),
        }
        void import("@/features/metrics")
            .then(({ getMetricsService }) => {
                try {
                    getMetricsService().incrementCounter(
                        "unhandled_rejection_total",
                        { source: "unhandled_rejection" },
                        1,
                    )
                } catch {
                    /* metrics not ready */
                }
            })
            .catch(() => {
                /* metrics import failed */
            })
    } catch {
        // Same caveat as above.
    }
    // Don't exit — let the node try to continue serving RPC
})

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
    OMNI_ENABLED: boolean
    OMNI_PORT: number
    omniServer: any
    // REVIEW: TLSNotary configuration - new HTTPS attestation feature
    TLSNOTARY_ENABLED: boolean
    TLSNOTARY_PORT: number
    tlsnotaryService: any
    // REVIEW: Prometheus Metrics configuration
    METRICS_ENABLED: boolean
    METRICS_PORT: number
    metricsServer: any
    // Server references for graceful shutdown
    rpcServer: any
    signalingServer: any
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
    OMNI_ENABLED: false,
    OMNI_PORT: 0,
    omniServer: null,
    // REVIEW: TLSNotary defaults - disabled by default, requires signing key
    TLSNOTARY_ENABLED: Config.getInstance().tlsnotary.enabled,
    TLSNOTARY_PORT: Config.getInstance().tlsnotary.port,
    tlsnotaryService: null,
    // REVIEW: Prometheus Metrics defaults - enabled by default
    METRICS_ENABLED: Config.getInstance().metrics.enabled,
    METRICS_PORT: Config.getInstance().metrics.port,
    metricsServer: null,
    // Server references for graceful shutdown
    rpcServer: null,
    signalingServer: null,
}

// SECTION Preparation methods

// ANCHOR Calibrating the time
async function calibrateTime() {
    await getTimestampCorrection()
    log.info(
        "[SYNC] Timestamp correction: " + getSharedState.timestampCorrection,
    )
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
                case "log-level": {
                    const level = param[1]?.toLowerCase()
                    if (
                        [
                            "debug",
                            "info",
                            "warning",
                            "error",
                            "critical",
                        ].includes(level)
                    ) {
                        CategorizedLogger.getInstance().setMinLevel(
                            level as
                                | "debug"
                                | "info"
                                | "warning"
                                | "error"
                                | "critical",
                        )
                        log.info(`[MAIN] Log level set to: ${level}`)
                    } else {
                        log.warning(
                            `[MAIN] Invalid log level: ${param[1]}. Valid: debug, info, warning, error, critical`,
                        )
                    }
                    break
                }
                default:
                    log.warning("[MAIN] Invalid parameter: " + param)
            }
        }
    }
}

async function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once("error", (err: NodeJS.ErrnoException) => {
            server.close()
            if (err.code === "EADDRINUSE") {
                resolve(false)
            } else {
                reject(err)
            }
        })

        server.once("listening", () => {
            resolve(true)
            server.close()
        })
        server.listen(port)
    })
}

/**
 * Find the first free TCP port at or after `startFrom`.
 *
 * Emits a `[PORT]` warning when the chosen port differs from the requested
 * one — operators previously had no way to tell "I asked for 3005, I got
 * 3007" without packet capture. The `reason` arg is included in the log
 * so multiple callers in this file remain distinguishable. Epic 13 T4.
 */
async function getNextAvailablePort(
    startFrom: number,
    reason = "unspecified",
) {
    const originalStartFrom = startFrom
    let availablePort: number = null
    while (startFrom < 65535 || !!availablePort) {
        if (await isPortAvailable(startFrom)) {
            availablePort = startFrom
            break
        }
        startFrom++
    }
    if (availablePort !== null && availablePort !== originalStartFrom) {
        log.warning(
            `[PORT] ${reason} drifted from ${originalStartFrom} to ${availablePort}`,
        )
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
    const cfg = Config.getInstance()
    indexState.RPC_FEE = cfg.core.rpcFee
    // Allow overriding pg port through RPC_PG_PORT
    indexState.PG_PORT = cfg.database.port
    // Allow overriding server port through RPC_PORT
    indexState.SERVER_PORT = cfg.server.rpcPort
    // Allow overriding signaling server port through RPC_SIGNALING_PORT
    indexState.SIGNALING_SERVER_PORT =
        cfg.server.rpcSignalingPort || cfg.server.signalingServerPort

    // Use next available port for the signaling server
    // (useful when we have multiple nodes running the same code on the same machine)
    const signalingRequested = indexState.SIGNALING_SERVER_PORT
    indexState.SIGNALING_SERVER_PORT = await getNextAvailablePort(
        indexState.SIGNALING_SERVER_PORT,
        "signaling",
    )
    markSubsystem(getSharedState.subsystems, "signaling", "pending", {
        requestedPort: signalingRequested,
        port: indexState.SIGNALING_SERVER_PORT,
    })

    // MCP Server configuration
    indexState.MCP_SERVER_PORT =
        cfg.server.rpcMcpPort || cfg.server.mcpServerPort
    indexState.MCP_ENABLED = cfg.core.mcpEnabled

    // OmniProtocol TCP Server configuration
    indexState.OMNI_ENABLED = cfg.omni.enabled
    const omniRequested = cfg.omni.port
    indexState.OMNI_PORT = await getNextAvailablePort(cfg.omni.port, "omni")
    markSubsystem(getSharedState.subsystems, "omni", "pending", {
        requestedPort: omniRequested,
        port: indexState.OMNI_PORT,
        enabled: indexState.OMNI_ENABLED,
    })

    getSharedState.omniConfig.port = indexState.OMNI_PORT
    getSharedState.serverPort = indexState.SERVER_PORT
    getSharedState.connectionString = cfg.core.exposedUrl

    /* !SECTION Environment variables loading and configuration */
    log.info("[MAIN] = Configured environment variables =")
    log.info("[MAIN] PG_PORT: " + indexState.PG_PORT)
    log.info("[MAIN] RPC_FEE: " + indexState.RPC_FEE)
    log.info("[MAIN] SERVER_PORT: " + indexState.SERVER_PORT)
    log.info(
        "[MAIN] SIGNALING_SERVER_PORT: " + indexState.SIGNALING_SERVER_PORT,
    )
    log.info("[MAIN] MCP_SERVER_PORT: " + indexState.MCP_SERVER_PORT)
    log.info("[MAIN] MCP_ENABLED: " + indexState.MCP_ENABLED)
    log.info("[MAIN] = End of Configuration =")
    // Configure the logs directory
    log.setLogsDir(indexState.SERVER_PORT)
    // ? REVIEW Starting the server_rpc: should we keep this async?
    // This should start the server_rpc without any other needed operation
    log.info("[MAIN] Starting the RPC server")
    //server_rpc()
    indexState.rpcServer = await serverRpcBun()
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
    // REVIEW: Warn operators when EXPOSED_URL points at a loopback/unroutable
    // host so they don't silently run an unreachable node on the public network.
    try {
        const exposedUrl = Config.getInstance().core.exposedUrl
        const loopbackHosts = new Set([
            "localhost",
            "127.0.0.1",
            "0.0.0.0",
            "::1",
            "host.docker.internal",
        ])
        const exposedHost = new URL(exposedUrl).hostname
        if (loopbackHosts.has(exposedHost)) {
            log.warning(
                "\n============================================================\n" +
                    "⚠️  EXPOSED_URL is set to a loopback/unroutable address:\n" +
                    `     ${exposedUrl}\n` +
                    "     Other peers cannot reach this node at this address.\n" +
                    "     For real network participation, set EXPOSED_URL in .env\n" +
                    "     to your public IP or DNS name (e.g. http://YOUR_IP:53550).\n" +
                    '     See INSTALL.md → "Joining the network".\n' +
                    "============================================================",
            )
        }
    } catch (err) {
        // Malformed EXPOSED_URL — surface it so the operator can fix .env,
        // but don't crash the node over a config quirk.
        const message = err instanceof Error ? err.message : String(err)
        log.warning(
            "[CONFIG] EXPOSED_URL is not a valid URL — loopback check skipped. " +
                `Value: "${Config.getInstance().core.exposedUrl}". Error: ${message}`,
        )
    }
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
    await findGenesisBlock()
    await loadGenesisIdentities()
    // DEM-771: reconcile the validators table. No-op on healthy boot,
    // re-seeds from data/genesis.json when the table was emptied
    // out-of-band, throws when the chain is unrecoverable from local
    // state alone.
    {
        let genesisData: unknown = null
        try {
            const raw = fs.readFileSync("data/genesis.json", "utf8")
            genesisData = JSON.parse(raw)
            if (typeof genesisData === "string") {
                genesisData = JSON.parse(genesisData)
            }
        } catch (e) {
            // findGenesisBlock validates data/genesis.json on the
            // fresh-chain path; on a subsequent boot it can early-return
            // without re-reading the file, so a missing/corrupt file
            // here is genuinely possible (operator deleted it,
            // permissions changed, snapshot replay skipped). Log the
            // real cause so the operator sees it BEFORE the
            // ConsensusInvariantError from ensureValidatorSeed(null)
            // points them at a misleading "carries no validator set"
            // message.
            log.error(
                `[BOOT] failed to read data/genesis.json for validator seed reconcile: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        }
        await ensureValidatorSeed(genesisData)
    }
    log.info("[CHAIN] 🖥️ Found the genesis block")

    // Governance state must be in sharedState BEFORE any inbound traffic
    // hits a handler that reads networkParameters / fees. Order matters:
    // findGenesisBlock → loadNetworkParameters → peerBootstrap.
    await loadNetworkParameters()

    await peerBootstrap(indexState.PeerList)

    log.info("[PEER] 🌐 Bootstrapping peers...")
    log.debug(
        "[PEER] Peer list: " +
            JSON.stringify(indexState.PeerList.map(p => p.identity)),
    )

    // Loading the peers
    //PeerList.push(ourselves)

    // ANCHOR Bootstrapping the peers
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

/**
 * Bootstraps the node and starts its network services and background managers.
 *
 * Performs chain setup, warmup, time calibration, and pre-main-loop initialization; then ensures peer availability, starts the signaling server, optionally starts the MCP server, and initializes the DTR relay retry service when running in production.
 *
 * Side effects:
 * - May call process.exit(1) if the signaling server fails to start.
 * - Sets shared-state flags such as `isSignalingServerStarted` and `isMCPServerStarted`.
 * - Starts background services (MCP server and DTRManager) when configured.
 */
async function main() {
    getSharedState.isInitialized = false
    // Check for --no-tui flag early (before warmup processes args fully)
    if (process.argv.includes("no-tui") || process.argv.includes("--no-tui")) {
        indexState.TUI_ENABLED = false
    }

    getSharedState.keypair = await getSharedState.identity.loadIdentity()
    try {
        await TxValidatorPool.getInstance().start()
    } catch (error) {
        handleError(error, "CORE", { source: ErrorSource.WORKER_POOL_STARTUP })
        log.error(
            "[CORE] TxValidatorPool failed to start; aborting node startup.",
        )
        process.exit(1)
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
            // Delegate to the unified gracefulShutdown handler so all services
            // (L2PS, OmniProtocol, DTR, TLSNotary, Metrics, etc.) are stopped.
            indexState.tuiManager.on("quit", () => {
                gracefulShutdown("TUI_QUIT")
            })
        } catch (error) {
            handleError(error, "CORE", { source: ErrorSource.TUI_STARTUP })
            indexState.TUI_ENABLED = false
        }
    }

    // Bracket the silent-success boot steps so operators can see
    // "Chain DB ready" / "Mempool ready" markers (Epic 13 T3). Pre-fix,
    // these returned with no log; if `setupChainDb` hangs on Postgres,
    // there would be nothing on stdout until the next step ran.
    const bootTracker = getSharedState.bootTracker
    bootTracker.start("chain.setup")
    try {
        await Chain.setup()
        bootTracker.ready("chain.setup")
        markSubsystem(getSharedState.subsystems, "chain", "ready")
        log.info("[BOOT] Chain DB ready")
    } catch (e) {
        bootTracker.fail("chain.setup", e)
        subsystemError(getSharedState.subsystems, "chain", e)
        throw e
    }

    bootTracker.start("mempool.init")
    try {
        await Mempool.init()
        bootTracker.ready("mempool.init")
        log.info("[BOOT] Mempool ready")
    } catch (e) {
        bootTracker.fail("mempool.init", e)
        throw e
    }

    // INFO Warming up the node (including arguments digesting)
    bootTracker.start("warmup")
    try {
        await warmup()
        bootTracker.ready("warmup")
        // RPC server is up at this point (warmup awaits serverRpcBun).
        markSubsystem(getSharedState.subsystems, "rpc", "ready", {
            port: indexState.SERVER_PORT,
        })
    } catch (e) {
        bootTracker.fail("warmup", e)
        throw e
    }

    // Update TUI with port info after warmup
    if (indexState.TUI_ENABLED && indexState.tuiManager) {
        indexState.tuiManager.updateNodeInfo({
            port: indexState.SERVER_PORT,
        })
    }

    // INFO Calibrating the time at the start of the node
    await calibrateTime()

    // Start OmniProtocol TCP server (optional)
    if (indexState.OMNI_ENABLED) {
        bootTracker.start("omni.server")
        try {
            getSharedState.omniConfig.port = indexState.OMNI_PORT
            const omniServer = await startOmniProtocolServer(
                getSharedState.omniConfig,
            )
            indexState.omniServer = omniServer
            log.info(
                `[CORE] OmniProtocol server started on port ${indexState.OMNI_PORT}`,
            )

            // REVIEW: Initialize OmniProtocol client adapter for outbound peer communication
            // Use OMNI_ONLY mode for testing, OMNI_PREFERRED for production gradual rollout
            const omniMode =
                (Config.getInstance().omni.mode as
                    | "HTTP_ONLY"
                    | "OMNI_PREFERRED"
                    | "OMNI_ONLY") || "OMNI_ONLY"
            getSharedState.initOmniProtocol(omniMode)
            log.info(
                `[CORE] OmniProtocol client adapter initialized with mode: ${omniMode}`,
            )
            bootTracker.ready("omni.server")
            markSubsystem(getSharedState.subsystems, "omni", "ready", {
                port: indexState.OMNI_PORT,
                enabled: true,
            })
        } catch (error) {
            handleError(error, "NETWORK", { source: ErrorSource.OMNI_STARTUP })
            bootTracker.fail("omni.server", error)
            subsystemError(getSharedState.subsystems, "omni", error)
            // Continue without OmniProtocol (failsafe - falls back to HTTP)
        }

        if (!getSharedState.omniAdapter) {
            log.error("[CORE] Failed to start OmniProtocol server")
            process.exit(1)
        }
    } else {
        log.info(
            "[CORE] OmniProtocol server disabled (set OMNI_ENABLED=true to enable)",
        )
        markSubsystem(getSharedState.subsystems, "omni", "skipped", {
            reason: "OMNI_ENABLED=false",
            enabled: false,
        })
        bootTracker.skip("omni.server", "disabled")
    }
    // INFO Preparing the main loop
    bootTracker.start("pre_main_loop")
    try {
        await preMainLoop()
        bootTracker.ready("pre_main_loop")
    } catch (e) {
        bootTracker.fail("pre_main_loop", e)
        throw e
    }

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

    // REVIEW: Start Prometheus Metrics server (enabled by default)
    if (indexState.METRICS_ENABLED) {
        bootTracker.start("metrics.server")
        try {
            const { getMetricsServer, getMetricsCollector } =
                await import("./features/metrics")

            const metricsRequested = indexState.METRICS_PORT
            indexState.METRICS_PORT = await getNextAvailablePort(
                indexState.METRICS_PORT,
                "metrics",
            )

            const metricsServer = getMetricsServer({
                port: indexState.METRICS_PORT,
                enabled: true,
            })

            await metricsServer.start()

            indexState.metricsServer = metricsServer
            log.info(
                `[METRICS] Prometheus metrics server started on http://0.0.0.0:${indexState.METRICS_PORT}/metrics`,
            )

            // REVIEW: Start metrics collector for live data gathering
            const metricsCollector = getMetricsCollector({
                enabled: true,
                collectionIntervalMs: 2500, // 2.5 seconds for real-time monitoring
                dockerHealthEnabled: true,
                portHealthEnabled: true,
            })
            await metricsCollector.start()
            log.info("[METRICS] Metrics collector started")
            bootTracker.ready("metrics.server")
            markSubsystem(getSharedState.subsystems, "metrics", "ready", {
                port: indexState.METRICS_PORT,
                requestedPort: metricsRequested,
                enabled: true,
            })
        } catch (error) {
            log.error("[METRICS] Failed to start metrics server: " + error)
            bootTracker.fail("metrics.server", error)
            subsystemError(getSharedState.subsystems, "metrics", error)
            // Continue without metrics (failsafe)
        }
    } else {
        log.info(
            "[METRICS] Metrics server disabled (set METRICS_ENABLED=true to enable)",
        )
        markSubsystem(getSharedState.subsystems, "metrics", "skipped", {
            reason: "METRICS_ENABLED=false",
            enabled: false,
        })
        bootTracker.skip("metrics.server", "disabled")
    }

    // ANCHOR Based on the above methods, we can now start the main loop
    // Checking for listening mode
    if (indexState.peerManager.getPeers().length < 1) {
        log.warning("[PEER] 🔍 No peers detected, listening...")
        indexState.enough_peers = false
        // Dormant mode (Epic 13 T3) — surface in /health + metrics so the
        // operator can distinguish "intentionally idle, waiting for peers"
        // from "failing". Without this, RPC + metrics keep answering and
        // the node looks healthy while consensus is frozen.
        getSharedState.dormantMode = true
        log.warning(
            "[BOOT] DORMANT MODE: peer list empty; signaling / MCP / " +
                "TLSNotary / mainLoop / DTR / L2PS are skipped until peers " +
                "appear. /health will report status=dormant.",
        )
        for (const skipped of [
            "signaling",
            "mcp",
            "tlsnotary",
            "main_loop",
            "dtr",
            "l2ps",
        ]) {
            markSubsystem(getSharedState.subsystems, skipped, "skipped", {
                reason: "no peers",
            })
        }
        bootTracker.skip("dormant_block", "no peers")
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
        bootTracker.start("signaling")
        indexState.signalingServer = new SignalingServer(
            indexState.SIGNALING_SERVER_PORT,
        )
        if (indexState.signalingServer) {
            getSharedState.isSignalingServerStarted = true
            log.info("[NETWORK] Signaling server started")
            bootTracker.ready("signaling")
            markSubsystem(getSharedState.subsystems, "signaling", "ready", {
                port: indexState.SIGNALING_SERVER_PORT,
            })
        } else {
            log.error("[NETWORK] Failed to start the signaling server")
            bootTracker.fail(
                "signaling",
                new Error("constructor returned null"),
            )
            subsystemError(
                getSharedState.subsystems,
                "signaling",
                new Error("constructor returned null"),
            )
            process.exit(1)
        }

        // Start MCP server (failsafe)
        if (indexState.MCP_ENABLED) {
            bootTracker.start("mcp.server")
            try {
                const { createDemosMCPServer, createDemosNetworkTools } =
                    await import("./features/mcp")

                const mcpRequested = indexState.MCP_SERVER_PORT
                indexState.MCP_SERVER_PORT = await getNextAvailablePort(
                    indexState.MCP_SERVER_PORT,
                    "mcp",
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
                bootTracker.ready("mcp.server")
                markSubsystem(getSharedState.subsystems, "mcp", "ready", {
                    port: indexState.MCP_SERVER_PORT,
                    requestedPort: mcpRequested,
                    enabled: true,
                })
            } catch (error) {
                log.error("[MCP] Failed to start MCP server: " + error)
                getSharedState.isMCPServerStarted = false
                bootTracker.fail("mcp.server", error)
                subsystemError(getSharedState.subsystems, "mcp", error)
                // Continue without MCP (failsafe)
            }
        } else {
            markSubsystem(getSharedState.subsystems, "mcp", "skipped", {
                reason: "MCP_ENABLED=false",
                enabled: false,
            })
            bootTracker.skip("mcp.server", "disabled")
        }

        // REVIEW: Start TLSNotary service (failsafe - optional HTTPS attestation feature)
        if (indexState.TLSNOTARY_ENABLED) {
            bootTracker.start("tlsnotary")
            try {
                const {
                    initializeTLSNotary,
                    getTLSNotaryService,
                    isTLSNotaryFatal,
                    isTLSNotaryDebug,
                } = await import("./features/tlsnotary")
                const fatal = isTLSNotaryFatal()
                const debug = isTLSNotaryDebug()

                // REVIEW: Check for port collision with OmniProtocol
                // OmniProtocol derives peer ports as HTTP_PORT + 1, which could collide with TLSNotary
                if (indexState.OMNI_ENABLED) {
                    // Check if TLSNotary port could be hit by OmniProtocol peer connections
                    // This happens when a peer runs on HTTP port (TLSNotary port - 1)
                    const potentialCollisionPort = indexState.TLSNOTARY_PORT - 1
                    log.warning(
                        `[TLSNotary] ⚠️ OmniProtocol is enabled. If any peer runs on HTTP port ${potentialCollisionPort}, OmniProtocol will try to connect to port ${indexState.TLSNOTARY_PORT} (TLSNotary)`,
                    )
                    log.warning(
                        "[TLSNotary] This can cause 'WebSocket upgrade failed: Unsupported HTTP method' errors",
                    )
                    log.warning(
                        "[TLSNotary] Consider using a different TLSNOTARY_PORT to avoid collisions",
                    )
                }

                if (debug) {
                    log.info("[TLSNotary] Debug mode: TLSNOTARY_DEBUG=true")
                    log.info(`[TLSNotary] Fatal mode: TLSNOTARY_FATAL=${fatal}`)
                    log.info(`[TLSNotary] Port: ${indexState.TLSNOTARY_PORT}`)
                }

                const initialized = await initializeTLSNotary()
                if (initialized) {
                    indexState.tlsnotaryService = getTLSNotaryService()
                    log.info(
                        `[TLSNotary] WebSocket server started on port ${indexState.TLSNOTARY_PORT}`,
                    )
                    bootTracker.ready("tlsnotary")
                    markSubsystem(
                        getSharedState.subsystems,
                        "tlsnotary",
                        "ready",
                        {
                            port: indexState.TLSNOTARY_PORT,
                            enabled: true,
                        },
                    )
                    // Update TUI with TLSNotary info
                    if (indexState.TUI_ENABLED && indexState.tuiManager) {
                        indexState.tuiManager.updateNodeInfo({
                            tlsnotary: {
                                enabled: true,
                                port: indexState.TLSNOTARY_PORT,
                                running: true,
                            },
                        })
                    }
                } else {
                    const msg =
                        "[TLSNotary] Service disabled or failed to initialize (check TLSNOTARY_SIGNING_KEY)"
                    bootTracker.fail("tlsnotary", new Error(msg))
                    subsystemError(
                        getSharedState.subsystems,
                        "tlsnotary",
                        new Error(msg),
                    )
                    if (fatal) {
                        log.error("[TLSNotary] FATAL: " + msg)
                        process.exit(1)
                    }
                    log.warning(msg)
                }
            } catch (error) {
                log.error(
                    "[TLSNotary] Failed to start TLSNotary service: " + error,
                )
                bootTracker.fail("tlsnotary", error)
                subsystemError(
                    getSharedState.subsystems,
                    "tlsnotary",
                    error,
                )
                const { isTLSNotaryFatal } =
                    await import("./features/tlsnotary")
                if (isTLSNotaryFatal()) {
                    log.error(
                        "[TLSNotary] FATAL: Exiting due to TLSNotary failure",
                    )
                    process.exit(1)
                }
                // Continue without TLSNotary (failsafe)
            }
        } else {
            log.info(
                "[TLSNotary] Service disabled (set TLSNOTARY_ENABLED=true to enable)",
            )
            markSubsystem(getSharedState.subsystems, "tlsnotary", "skipped", {
                reason: "TLSNOTARY_ENABLED=false",
                enabled: false,
            })
            bootTracker.skip("tlsnotary", "disabled")
        }

        log.info("[MAIN] ✅ Starting the background loop")

        // Update TUI status to running
        if (indexState.TUI_ENABLED && indexState.tuiManager) {
            indexState.tuiManager.updateNodeInfo({
                status: "running",
                isSynced: getSharedState.syncStatus,
            })
        }

        const peers = indexState.peerManager.getPeers()

        if (
            peers.length === 1 &&
            peers[0].identity === getSharedState.publicKeyHex
        ) {
            log.info(
                "[MAIN] We are the anchor node, listening for peers ... (15s, press Enter to skip)",
            )
            // INFO: Wait for hello peer if we are the anchor node
            // useful when anchor node is re-joining the network

            // REVIEW: When TUI is enabled, don't manipulate stdin directly
            // terminal-kit already controls stdin via grabInput(), and calling
            // process.stdin.pause() will break TUI keyboard input.
            // Instead, just wait the timeout - TUI users can press 'q' to quit if needed.
            if (indexState.TUI_ENABLED) {
                // TUI mode: just wait, no stdin manipulation
                try {
                    await Waiter.wait(Waiter.keys.STARTUP_HELLO_PEER, 15_000) // 15 seconds
                } catch (error) {
                    if (error instanceof TimeoutError) {
                        log.info(
                            "[MAIN] No wild peers found, starting sync loop",
                        )
                    } else if (error instanceof AbortError) {
                        log.info("[MAIN] Wait aborted, starting sync loop")
                    }
                }
            } else {
                // Non-TUI mode: set up Enter key listener to skip the wait
                // ONLY DO THIS IF STDIN IS TTY
                let cleanupStdin = () => {}

                if (process.stdin.isTTY) {
                    const wasRawMode = process.stdin.isRaw
                    if (!wasRawMode && process.stdin.setRawMode) {
                        process.stdin.setRawMode(true)
                    }
                    process.stdin.resume()

                    const enterKeyHandler = (chunk: Buffer) => {
                        const key = chunk.toString()
                        if (key === "\r" || key === "\n" || key === "\u0003") {
                            // Enter key or Ctrl+C
                            if (
                                Waiter.isWaiting(Waiter.keys.STARTUP_HELLO_PEER)
                            ) {
                                Waiter.abort(Waiter.keys.STARTUP_HELLO_PEER)
                                log.info(
                                    "[MAIN] Wait skipped by user, starting sync loop",
                                )
                            }
                            cleanupStdin()
                        }
                    }

                    process.stdin.on("data", enterKeyHandler)

                    cleanupStdin = () => {
                        process.stdin.removeListener("data", enterKeyHandler)
                        if (!wasRawMode && process.stdin.setRawMode) {
                            process.stdin.setRawMode(false)
                        }
                        process.stdin.pause()
                    }
                }

                try {
                    await Waiter.wait(Waiter.keys.STARTUP_HELLO_PEER, 15_000) // 15 seconds
                } catch (error) {
                    if (error instanceof TimeoutError) {
                        log.info(
                            "[MAIN] No wild peers found, starting sync loop",
                        )
                    } else if (error instanceof AbortError) {
                        // Already logged above
                    }
                } finally {
                    cleanupStdin()
                }
            }
        }

        bootTracker.start("fast_sync")
        try {
            await Mempool.cleanMempool()
            await fastSync([], "index.ts")
            bootTracker.ready("fast_sync")
        } catch (e) {
            bootTracker.fail("fast_sync", e)
            throw e
        }
        getSharedState.isInitialized = true
        // ANCHOR Starting the main loop
        // Fire-and-forget mainLoop. Do NOT kill the process on exit —
        // the previous `process.exit(1)` in `.finally` was a debug aid
        // (commit 455d615b) that became permanent. It killed the node on
        // any mainLoop error despite the uncaughtException swallow policy
        // at the top of this file, and it also raced gracefulShutdown's
        // `process.exit(0)` so `docker stop` exited code 1. The wrapper
        // now records the exit in sharedState so /health and observability
        // tooling (Epic 13) can surface it. See
        // docs/discoveries/startup-assessment-2026-05-13/08-epic-3-blockers.md.
        mainLoop()
            .catch((error: Error) => {
                console.error(error)
                log.error("[CORE] Error in main loop: " + error)
                handleError(error, "CORE", { source: ErrorSource.MAIN_LOOP })
                getSharedState.mainLoopExitReason =
                    error instanceof Error ? error.message : String(error)
            })
            .finally(() => {
                getSharedState.mainLoopExited = true
                getSharedState.mainLoopExitedAt = Date.now()
                if (getSharedState.isShuttingDown) {
                    log.info(
                        "[CORE] Main loop stopped (graceful shutdown)",
                    )
                } else {
                    log.error(
                        "[CORE] Main loop terminated unexpectedly. " +
                            "Node continues serving RPC but is no longer producing blocks. " +
                            "Investigate.",
                    )
                    // Mirror the exit into the subsystem registry so
                    // MetricsCollector.collectObservability() drops
                    // demos_subsystem_up{subsystem="main_loop"} to 0
                    // and the `NodeFailing` Prom alert fires. Without
                    // this, /health flipped the local snapshot to
                    // "failed" but the registry stayed "running", so
                    // the metric + alert diverged silently from the
                    // health probe. Greptile P1.
                    markSubsystem(
                        getSharedState.subsystems,
                        "main_loop",
                        "failed",
                    )
                }
            })

        // mainLoop is fire-and-forget; mark it "running" eagerly so the
        // boot summary moves on. Heartbeat (Epic 13 T5) flips it to "ready"
        // on the first iteration and tracks staleness thereafter.
        bootTracker.start("main_loop")
        bootTracker.ready("main_loop")
        markSubsystem(getSharedState.subsystems, "main_loop", "running")


        // Load L2PS networks configuration
        bootTracker.start("l2ps.networks")
        try {
            await ParallelNetworks.getInstance().loadAllL2PS()
            bootTracker.ready("l2ps.networks")
            log.info(
                `[CORE] [L2PS] Loaded ${(getSharedState.l2psJoinedUids || []).length} joined L2PS network(s)`,
            )
        } catch (error) {
            handleError(error, "CORE", {
                source: ErrorSource.L2PS_NETWORK_LOADING,
            })
            bootTracker.fail("l2ps.networks", error)
            subsystemError(getSharedState.subsystems, "l2ps", error)
        }

        // Start L2PS hash generation service (for L2PS participating nodes)
        // Note: l2psJoinedUids is populated during ParallelNetworks initialization
        if (
            getSharedState.l2psJoinedUids &&
            getSharedState.l2psJoinedUids.length > 0
        ) {
            bootTracker.start("l2ps.services")
            try {
                const l2psHashService = L2PSHashService.getInstance()
                await l2psHashService.start()
                log.info(
                    `[CORE] [L2PS] Hash generation service started for ${getSharedState.l2psJoinedUids.length} L2PS networks`,
                )

                // Start L2PS batch aggregator (batches transactions and submits to main mempool)
                const l2psBatchAggregator = L2PSBatchAggregator.getInstance()
                await l2psBatchAggregator.start()
                log.info("[CORE] [L2PS] Batch aggregator service started")
                bootTracker.ready("l2ps.services")
                markSubsystem(getSharedState.subsystems, "l2ps", "ready", {
                    enabled: true,
                    extra: {
                        joined_uids: getSharedState.l2psJoinedUids.length,
                    },
                })
            } catch (error) {
                handleError(error, "CORE", {
                    source: ErrorSource.L2PS_SERVICES_STARTUP,
                })
                bootTracker.fail("l2ps.services", error)
                subsystemError(getSharedState.subsystems, "l2ps", error)
            }
        } else {
            log.info(
                "[CORE] [L2PS] No L2PS networks joined, L2PS services not started",
            )
            markSubsystem(getSharedState.subsystems, "l2ps", "skipped", {
                reason: "no joined networks",
                enabled: false,
            })
            bootTracker.skip("l2ps.services", "no joined networks")
        }
    }
}

// Graceful shutdown handling for services
// Redundant handlers removed. Cleanup logic moved to gracefulShutdown.

// INFO Starting the main routine
main().catch((error: Error) => {
    console.error(error)
    handleError(error, "CORE", { source: ErrorSource.MAIN, fatal: true })
    gracefulShutdown("main_error").catch(() => {
        process.exit(1)
    })
})
// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
    // Prevent re-entrant shutdown (e.g. second CTRL+C while already shutting down)
    if (getSharedState.isShuttingDown) {
        return
    }
    getSharedState.isShuttingDown = true
    getSharedState.runMainLoop = false

    log.info(`[CORE] Received ${signal}, shutting down gracefully...`)

    // Force exit after 10 seconds if graceful shutdown hangs
    const forceExitTimeout = setTimeout(() => {
        log.warning("[CORE] Shutdown timeout exceeded, forcing exit...")
        process.exit(0)
    }, 3_000)
    // Don't let this timer itself keep the process alive
    if (forceExitTimeout.unref) forceExitTimeout.unref()

    try {
        // Stop TUI first so terminal is restored for shutdown logs
        if (indexState.tuiManager) {
            try {
                indexState.tuiManager.stop()
            } catch (_) {
                /* ignore TUI errors during shutdown */
            }
        }

        // Stop L2PS services if running (await so their intervals are cleared)
        try {
            log.info("[CORE] Stopping L2PS services...")
            await Promise.allSettled([
                L2PSHashService.getInstance().stop(3000),
                L2PSBatchAggregator.getInstance().stop(3000),
            ])
        } catch (error) {
            handleError(error, "CORE", { source: ErrorSource.L2PS_SHUTDOWN })
        }

        // Stop TxValidatorPool workers
        try {
            log.info("[CORE] Stopping TxValidatorPool...")
            await TxValidatorPool.getInstance().stop(2_000)
        } catch (error) {
            handleError(error, "CORE", {
                source: ErrorSource.WORKER_POOL_SHUTDOWN,
            })
        }

        // Stop OmniProtocol server if running
        if (indexState.omniServer) {
            log.info("[CORE] Stopping OmniProtocol server...")
            try {
                await stopOmniProtocolServer()
            } catch (error) {
                handleError(error, "NETWORK", {
                    source: ErrorSource.OMNI_SHUTDOWN,
                })
            }
        }

        // Stop MCP server if running
        if (indexState.mcpServer) {
            log.info("[CORE] Stopping MCP server...")
            try {
                await indexState.mcpServer.stop()
            } catch (error) {
                handleError(error, "MCP", { source: ErrorSource.MCP_SHUTDOWN })
            }
        }

        // Stop TLSNotary service if running
        if (indexState.tlsnotaryService) {
            log.info("[CORE] Stopping TLSNotary service...")
            try {
                const { shutdownTLSNotary } =
                    await import("./features/tlsnotary")
                await shutdownTLSNotary()
            } catch (error) {
                handleError(error, "TLSN", {
                    source: ErrorSource.TLSN_SHUTDOWN,
                })
            }
        }

        // Stop Metrics collector and server if running
        if (indexState.metricsServer) {
            log.info("[CORE] Stopping Metrics collector and server...")
            try {
                const { getMetricsCollector } =
                    await import("./features/metrics")
                getMetricsCollector().stop()
                indexState.metricsServer.stop()
            } catch (error) {
                handleError(error, "CORE", {
                    source: ErrorSource.METRICS_SHUTDOWN,
                })
            }
        }

        // Stop HTTP RPC server
        if (indexState.rpcServer) {
            log.info("[CORE] Stopping RPC server...")
            try {
                indexState.rpcServer.stop()
            } catch (error) {
                handleError(error, "NETWORK", {
                    source: ErrorSource.RPC_SHUTDOWN,
                })
            }
        }

        // Stop Signaling server
        if (indexState.signalingServer) {
            log.info("[CORE] Stopping Signaling server...")
            try {
                indexState.signalingServer.disconnect()
            } catch (error) {
                handleError(error, "NETWORK", {
                    source: ErrorSource.SIGNALING_SHUTDOWN,
                })
            }
        }

        // Stop HTTP rate limiter cleanup interval
        try {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const { RateLimiter: HttpRateLimiter } =
                await import("./libs/network/middleware/rateLimiter")
            HttpRateLimiter.getInstance().destroy()
        } catch (_) {
            /* may not be initialized */
        }

        log.info("[CORE] Cleanup complete, exiting...")
        clearTimeout(forceExitTimeout)
        process.exit(0)
    } catch (error) {
        handleError(error, "CORE", {
            source: ErrorSource.GRACEFUL_SHUTDOWN,
            fatal: true,
        })
        clearTimeout(forceExitTimeout)
        process.exit(1)
    }
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
process.on("SIGINT", () => gracefulShutdown("SIGINT"))

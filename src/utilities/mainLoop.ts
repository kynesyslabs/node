import Chain from "src/libs/blockchain/chain"
import { fastSync } from "src/libs/blockchain/routines/Sync"
import { consensusRoutine } from "src/libs/consensus/v2/PoRBFT"
import { Peer, PeerManager } from "src/libs/peer"
import checkOfflinePeers from "src/libs/peer/routines/checkOfflinePeers"
import Diagnostic, {
    DiagnosticData,
    DiagnosticResponse,
} from "src/utilities/Diagnostic"
import log from "src/utilities/logger"
import * as consensusTime from "../libs/consensus/routines/consensusTime"
import { isNetworkAhead } from "src/libs/consensus/v2/routines/networkAheadVeto"
import { getSharedState } from "./sharedState"
import { peerGossip } from "src/libs/peer/routines/peerGossip"
import { handleError } from "src/errors/handleError"
import { Config } from "src/config"
import {
    markStep,
    reportWedgedLoops,
    startLoopTask,
} from "./loopScheduler"

// INFO The main loop executed in background by index.ts

export default async function mainLoop() {
    log.info("[MAIN LOOP] ✅ Started")

    const interval = () => getSharedState.mainLoopSleepTime

    await Promise.all([
        startLoopTask({
            name: "block_watchdog",
            fn: blockWatchdogTask,
            intervalMs: interval,
            budgetMs: 30_000,
            runWhilePaused: true,
        }),
        startLoopTask({
            name: "peer_recheck",
            fn: peerRecheckTask,
            intervalMs: interval,
            budgetMs: 30_000,
        }),
        startLoopTask({
            name: "sync_guard",
            fn: syncGuardTask,
            intervalMs: interval,
            budgetMs: 30_000,
        }),
        startLoopTask({
            name: "consensus_trigger",
            fn: consensusTriggerTask,
            intervalMs: interval,
            budgetMs: 30_000,
        }),
    ])
}

async function blockWatchdogTask() {
    // Heartbeat (Epic 13 T5). /health derives staleness from this — once
    // the gap exceeds 3× the loop interval, status flips to "failing".
    // First heartbeat also flips the `main_loop` subsystem to "ready".
    const isFirst = getSharedState.mainLoopHeartbeatAt === null
    getSharedState.mainLoopHeartbeatAt = Date.now()
    getSharedState.mainLoopIterations++
    // Mirror into Prometheus. Lazy import so the metrics module can stay
    // optional / disabled without breaking mainLoop.
    try {
        const { getMetricsService } = await import("@/features/metrics")
        getMetricsService().incrementCounter(
            "main_loop_iterations_total",
            {},
            1,
        )
    } catch {
        // Metrics disabled or not yet initialised — fine.
    }
    if (isFirst) {
        const { markSubsystem } = await import("./subsystemRegistry")
        markSubsystem(getSharedState.subsystems, "main_loop", "ready")
    }

    reportWedgedLoops()

    if (getSharedState.mainLoopPaused) {
        return
    }

    await checkBlockWatchdog()
}

async function peerRecheckTask() {
    try {
        await checkOfflinePeers()
    } catch (e) {
        handleError(e, "PEER", { source: "checkOfflinePeers" })
    }
}

async function syncGuardTask() {
    let ahead: boolean
    markStep("sync_guard", "isNetworkAhead")
    try {
        ahead = await isNetworkAhead("mainLoop")
    } finally {
        markStep("sync_guard", null)
    }

    getSharedState.networkAhead = ahead
    getSharedState.networkAheadCheckedAt = Date.now()

    if (ahead) {
        fastSync([], "networkAheadVeto").catch(e =>
            handleError(e, "SYNC", { source: "networkAheadVeto" }),
        )
    }
}

async function consensusTriggerTask() {
    log.info(
        "\n============================================================\n",
        true,
    )

    if (!getSharedState.syncStatus) {
        log.warning("[MAIN LOOP] Not in sync, starting sync loop", true)
        fastSync([], "syncRecovery").catch(e =>
            handleError(e, "SYNC", { source: "syncRecovery" }),
        )
        return
    }

    const checkedAt = getSharedState.networkAheadCheckedAt
    const maxVerdictAge = Math.max(3 * getSharedState.mainLoopSleepTime, 30_000)
    if (checkedAt === null || Date.now() - checkedAt > maxVerdictAge) {
        log.warning(
            "[MAIN LOOP] Network-ahead verdict is missing or stale, skipping consensus this tick",
            true,
        )
        return
    }

    if (getSharedState.networkAhead) {
        return
    }

    // ANCHOR Check if we have to forge the block now
    const isConsensusTimeReached = await consensusTime.checkConsensusTime()
    log.debug("Is consensus time reached:", isConsensusTimeReached)
    log.debug("Sync status:", getSharedState.syncStatus)
    log.debug("Starting consensus:", getSharedState.startingConsensus)
    // NOTE We need both the consensus time and the sync status to be true, to avoid
    // conflicts with the sync loop that would alead to a failure in the consensus mechanism.

    if (
        isConsensusTimeReached &&
        getSharedState.syncStatus &&
        !getSharedState.startingConsensus
    ) {
        // Set the startingConsensus flag to true to avoid conflicts with starting loops
        getSharedState.startingConsensus = true
        log.debug("[MAIN LOOP] Consensus time reached and sync status is true")
        // ANCHOR Calling the consensus routine if is time for it
        consensusRoutine()
    }
}

async function checkBlockWatchdog(): Promise<boolean> {
    const core = Config.getInstance().core
    if (
        !core.blockWatchdogEnabled ||
        getSharedState.lastBlockInsertedAt === null ||
        getSharedState.isShuttingDown
    ) {
        return false
    }

    const staleSeconds = Math.round(
        (Date.now() - getSharedState.lastBlockInsertedAt) / 1000,
    )
    if (staleSeconds <= core.blockWatchdogTimeoutSeconds) {
        return false
    }

    log.error(
        `[BLOCK WATCHDOG] No block accepted for ${staleSeconds}s (threshold ${core.blockWatchdogTimeoutSeconds}s), last block ${getSharedState.lastBlockNumber} — shutting down for operator inspection`,
    )
    const { gracefulShutdown } = await import("src/index")
    await gracefulShutdown("block_watchdog", 42)
    return true
}

// ANCHOR Unified peer routine
async function peerRoutine(): Promise<Peer[]> {
    // Logging the current peerlist
    log.info("[PEERROUTINE] Logging peerlist", false)
    PeerManager.getInstance().logPeerList()

    // REVIEW Re check offline peers asynchronously
    log.info("[MAINLOOP]: checking offline peers", false)
    checkOfflinePeers() // NOTE This is an async method that will be executed in the background
    log.info("[MAINLOOP]: checked offline peers", false)

    // every block write online list
    log.info("[MAINLOOP]: getting online peers", false)
    const onlinePeers = await PeerManager.getInstance().getOnlinePeers()
    log.info("[MAINLOOP]: got online peers", false)

    // check if online peers have been online for 3 blocks

    // if its the first block ever or we are doing a regenesis, we might want to skip this check, but we still need a list of reliable nodes.
    // In the "3 block online" the history of online peers is validated by the blockchain AND by the consensus so it can be relied on.

    let currentlyOnlinePeers: Peer[]

    log.info("[MAINLOOP]: getting online peers for last three blocks", false)
    // ? Is the below method necessary?
    const peersOnlineForLastThreeBlocks =
        await Chain.getOnlinePeersForLastThreeBlocks() // REVIEW if this works with hello_peer

    if (peersOnlineForLastThreeBlocks.length > 0) {
        // We found peers that have been online for 3 blocks. Use them in the consensus loop
        currentlyOnlinePeers = peersOnlineForLastThreeBlocks
    } else {
        // We didn't find peers that have been online for 3 blocks. Use the online peers list as it is
        // In this case we assume the node is isolated, starting up or that other nodes are not online or still connencting to the network
        log.info("[MAINLOOP]: using online peers list as it is", false)
        currentlyOnlinePeers = onlinePeers
    }

    // ! TODO Peer gossiping here
    peerGossip() // ? Await or not? I'd say not because it's good to have it in the background having anyway a reentry prevention

    log.info("[MAINLOOP]: family:", true)
    const famLen = currentlyOnlinePeers.length
    let famString = ""
    for (let i = 0; i < famLen; i++) {
        famString += "🐸 "
    }
    log.info("[MAINLOOP]: family: " + famString, true)

    // Returns the list of currently online peers
    return currentlyOnlinePeers
}

// Diagnostic

async function logCurrentDiagnostics() {
    const diagnosticData: DiagnosticResponse = {
        diagnostics: {} as DiagnosticData,
    }
    Diagnostic.insertDiagnostics(diagnosticData)

    const { cpu, ram, disk, network } = diagnosticData.diagnostics

    let diagnosticString = "Current System Diagnostics:\n"
    diagnosticString += "==========================\n"
    diagnosticString += "CPU:\n"
    diagnosticString += `  Type: ${cpu.type}\n`
    diagnosticString += `  Info: ${cpu.info}\n`
    diagnosticString += `  Current Usage: ${cpu.currentUsage.toFixed(2)}%\n`
    diagnosticString += `  Average Usage: ${cpu.averageUsage.toFixed(2)}%\n\n`

    diagnosticString += "RAM:\n"
    diagnosticString += `  Type: ${ram.type}\n`
    diagnosticString += `  Info: ${ram.info}\n`
    diagnosticString += `  Current Usage: ${ram.currentUsage.toFixed(2)}%\n`
    diagnosticString += `  Average Usage: ${ram.averageUsage.toFixed(2)}%\n\n`

    diagnosticString += "Disk:\n"
    diagnosticString += `  Type: ${disk.type}\n`
    diagnosticString += `  Info: ${disk.info}\n`
    diagnosticString += `  Current Usage: ${disk.currentUsage.toFixed(2)}%\n`
    diagnosticString += `  Average Usage: ${disk.averageUsage.toFixed(2)}%\n\n`

    diagnosticString += "Network:\n"
    if (
        network.downloadSpeed !== undefined &&
        network.uploadSpeed !== undefined
    ) {
        diagnosticString += `  Download Speed: ${network.downloadSpeed.toFixed(
            2,
        )} Mbps\n`
        diagnosticString += `  Upload Speed: ${network.uploadSpeed.toFixed(
            2,
        )} Mbps\n`
    } else {
        diagnosticString += "  No network speed data available\n"
    }

    // Print to debug log
    log.debug("[MAIN LOOP] " + diagnosticString)

    // Log to file using log.custom
    log.custom("diagnostics", diagnosticString, false, true)
}

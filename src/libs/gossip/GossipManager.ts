import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn, ChildProcess } from "node:child_process"
import type { Block, ValidityData } from "@kynesyslabs/demosdk/types"
import { isSelfStaked, onSelfStakeChange } from "src/libs/consensus/stakedSet"

import log from "src/utilities/logger"
import { Config, isLoopbackHost, parseNodeUrl } from "src/config"
import { getSharedState } from "@/utilities/sharedState"
import { Peer, PeerManager } from "src/libs/peer"
import { reportTwin } from "src/libs/peer/identityLiveness"

import {
    buildHeightsRecord,
    HeightsRecord,
    isHeightsRecordShape,
} from "./records"
import {
    validateBlockMessage,
    validateHeightsMessage,
    validateTxMessage,
} from "./validators"
import { BLOCKS_TOPIC, HEIGHTS_TOPIC, TXS_TOPIC } from "./topics"
import {
    countHeightsRecord,
    countPublishSkipped,
    registerGossipMetrics,
    setMeshPeersGauge,
    setReadyGauge,
    countTxIngest,
    countSidecarRestart,
    countSidecarRelaunchFailure,
    setSidecarDegradedGauge,
    countInbound,
    countSilenceProbe,
} from "./metrics"
import {
    INBOUND_SILENCE_MS,
    judgeSidecarHealth,
    relaunchDelayMs,
    RestartBudget,
    STATS_STALE_MS,
} from "./sidecarHealth"
import { getStakedSet } from "src/libs/consensus/stakedSet"
import { markSubsystem, subsystemError } from "src/utilities/subsystemRegistry"

const PROTOCOL_VERSION = 1
const READY_TIMEOUT_MS = 10_000
const IPC_RETRY_INTERVAL_MS = 100
const STOP_KILL_ESCALATION_MS = 2000
/** Restarts in a window beyond which a flapping sidecar is relaunched only after a backoff. */
const RESTART_MAX = 3
const RESTART_WINDOW_MS = 5 * 60_000
/** Peers to hello when gossip is silent, to tell a dead mesh from a dead network. */
const SILENCE_PROBE_PEERS = 3
/** Sidecar stderr lines kept for the fatal report. */
const SIDECAR_TAIL_LINES = 30

interface SidecarStats {
    connections: number
    perTopic: Record<
        string,
        {
            subscribers: number
            mesh: number
            subscribed?: boolean
            inbound?: number
        }
    >
    lastInboundAt?: number
}

/** Fixed metric label per restart cause; the detail goes to the log. */
type RestartKind =
    | "process_exit"
    | "process_error"
    | "ipc_closed"
    | "stats_stalled"
    | "stats_stalled_hard"
    | "mesh_silent"
    | "process_gone"
    | "first_launch_failed"

/** Configuration no relaunch can fix; fatal at first boot only. */
class SidecarConfigError extends Error {}

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

export class GossipManager {
    private static instance: GossipManager | null = null

    private proc: ChildProcess | null = null
    private sock: net.Socket | null = null
    private started = false
    private stopping = false
    private readyInfo: { peerId: string; addrs: string[] } | null = null
    private lastStats: SidecarStats | null = null
    private lastStatsAt = 0
    private heightsTimer: ReturnType<typeof setInterval> | null = null
    private recvBuffer = ""
    private stakeUnsubscribe: (() => void) | null = null
    private txSubscribed = false
    private restarting = false
    private lastInboundAt = 0
    private readonly restartBudget = new RestartBudget(
        RESTART_MAX,
        RESTART_WINDOW_MS,
    )
    private silenceProbeInFlight = false
    private lastSilenceProbeAt = 0
    private aloneLogged = false
    private sidecarTail: string[] = []
    /** Budget refusals in a row; grows the backoff for a sidecar that keeps dying after a good launch. */
    private flapStreak = 0
    private recovery: Promise<void> | null = null
    private wakeRetry: (() => void) | null = null
    private degraded: {
        since: number
        reason: string
        failedAttempts: number
        nextAttemptAt: number | null
    } | null = null

    constructor(
        private readonly backoff: {
            baseMs?: number
            capMs?: number
            random?: () => number
        } = {},
    ) {}

    static getInstance(): GossipManager {
        if (!GossipManager.instance) {
            GossipManager.instance = new GossipManager()
        }
        return GossipManager.instance
    }

    static isEnabled(): boolean {
        return Config.getInstance().gossip.enabled
    }

    // Only for configuration that no retry can fix, found at first boot.
    private fatal(context: string, error: unknown): never {
        const tail =
            this.sidecarTail.length > 0
                ? `\n--- last ${this.sidecarTail.length} sidecar stderr line(s) ---\n${this.sidecarTail.join("\n")}`
                : ""
        log.error(
            `[GOSSIP] FATAL in ${context}: ${
                error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error)
            }${tail}`,
        )
        process.exit(1)
    }

    private ipcPath(): string {
        const cfg = Config.getInstance().gossip
        return (
            process.env.GOSSIP_IPC_PATH ??
            path.join(".", `gossip-${cfg.port}.sock`)
        )
    }

    private sidecarEntry(): string {
        if (process.env.GOSSIP_SIDECAR_PATH) {
            return process.env.GOSSIP_SIDECAR_PATH
        }
        const bundled = "sidecar/dist/gossip-sidecar.mjs"
        if (fs.existsSync(bundled)) return bundled
        return "sidecar/src/index.js"
    }

    /**
     * Brings gossip up. Exits the process only when the sidecar cannot run
     * here at all (entry or Node runtime missing); a launch that merely
     * fails, e.g. a slow IPC socket on a loaded host, leaves the node
     * running on HTTP while the sidecar is relaunched in the background.
     */
    async start(): Promise<void> {
        if (this.started) return
        const cfg = Config.getInstance().gossip

        let entry: string
        try {
            registerGossipMetrics()
            entry = this.sidecarEntry()
            if (!fs.existsSync(entry)) {
                throw new SidecarConfigError(
                    `sidecar entry not found at ${entry} — run 'bun run sidecar:build' (or set GOSSIP_SIDECAR_PATH)`,
                )
            }
        } catch (e) {
            this.fatal("start()", e)
        }

        let firstLaunchError: unknown = null
        try {
            await this.launchSidecar(entry)
        } catch (e) {
            if (e instanceof SidecarConfigError) this.fatal("start()", e)
            firstLaunchError = e
            await this.teardownSidecar()
        }
        if (this.stopping) return

        this.lastTickAt = Date.now()
        this.heightsTimer = setInterval(() => {
            this.checkSidecarHealth(cfg.heightsIntervalMs)
            this.publishOwnHeights().catch(e =>
                log.warning(
                    `[GOSSIP] heights publish failed: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                ),
            )
            this.retryHeldTxs()
            this.refreshGauges()
        }, cfg.heightsIntervalMs)

        this.started = true
        // Receive-only unless staked: the tx topic is joined and left
        // as the node's own stake status changes. Heights and blocks
        // are always received; publishing them is gated per call.
        this.stakeUnsubscribe = onSelfStakeChange(staked =>
            this.setTxSubscription(staked),
        )

        if (firstLaunchError !== null) {
            void this.restartSidecar(
                `first launch failed: ${errorText(firstLaunchError)}`,
                { afterFailedLaunch: true, kind: "first_launch_failed" },
            )
            return
        }
        this.markUp()
        log.info(
            `[GOSSIP] started: sidecar peerId ${this.readyInfo?.peerId}, gossip port ${cfg.port}`,
        )
    }

    /**
     * Spawn the sidecar, connect IPC, wait for ready, and restore
     * subscriptions and dials. On failure the caller tears the attempt down.
     */
    private async launchSidecar(entry: string): Promise<void> {
        const cfg = Config.getInstance().gossip
        log.info(`[GOSSIP] spawning sidecar: node ${entry}`)
        const proc = spawn("node", [entry], {
            env: {
                ...process.env,
                GOSSIP_PORT: String(cfg.port),
                GOSSIP_KEY_FILE: cfg.keyFile,
                GOSSIP_IPC_PATH: this.ipcPath(),
            },
            stdio: ["pipe", "ignore", "pipe"],
        })
        this.proc = proc
        let launched = false
        let failLaunch: (e: Error) => void = () => undefined
        const launchFailed = new Promise<never>((_, reject) => {
            failLaunch = reject
        })
        proc.on("error", e => {
            const err =
                (e as NodeJS.ErrnoException).code === "ENOENT"
                    ? new SidecarConfigError(
                          "Node.js runtime not found on PATH — the gossip sidecar requires Node >= 20 (GOSSIP_ENABLED=false also starts, but the node then learns of new blocks only by polling its peers)",
                      )
                    : e
            if (!launched) {
                failLaunch(err)
                return
            }
            log.error(`[GOSSIP] sidecar process error: ${err.message}`)
            if (this.proc === proc) {
                this.onSidecarGone(`process error: ${err.message}`, "process_error")
            }
        })
        this.sidecarTail = []
        proc.stderr?.on("data", (d: Buffer) => {
            for (const line of d.toString().split("\n")) {
                if (!line.trim()) continue
                log.warning(`[GOSSIP-SIDECAR] ${line}`)
                this.sidecarTail.push(line)
                if (this.sidecarTail.length > SIDECAR_TAIL_LINES) {
                    this.sidecarTail.shift()
                }
            }
        })
        // "close" fires after stdio has drained, so the last stderr lines are logged first.
        proc.on("close", (code, signal) => {
            const why = `process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`
            if (!launched) {
                failLaunch(new Error(`sidecar ${why} before it was ready`))
                return
            }
            if (this.proc !== proc) return // a superseded process
            this.onSidecarGone(why, "process_exit")
        })

        const ready = this.awaitReady()
        try {
            await Promise.race([
                this.connectIpc(proc, cfg.ipcConnectTimeoutMs).then(() =>
                    ready.arm(),
                ),
                launchFailed,
            ])
        } finally {
            ready.cancel()
        }
        if (this.proc !== proc) {
            throw new Error("sidecar launch superseded or stopped")
        }
        launched = true

        // Judge staleness and silence from now.
        const now = Date.now()
        this.lastStatsAt = now
        this.lastInboundAt = now

        this.txSubscribed = false
        const staked = await isSelfStaked().catch(() => false)
        if (this.started && staked) this.setTxSubscription(true)
        const addrs = new Set<string>()
        for (const peer of PeerManager.getInstance().getAll()) {
            for (const a of peer.gossip?.addrs ?? []) addrs.add(a)
        }
        if (addrs.size > 0) {
            this.send({ type: "dial", addrs: [...addrs] })
            log.info(`[GOSSIP] re-dialing ${addrs.size} known multiaddr(s)`)
        }
        // Its exit during the awaits above was ignored as part of the
        // launch, so it must fail the launch here or nothing relaunches it.
        if (
            this.proc !== proc ||
            proc.exitCode !== null ||
            proc.signalCode !== null ||
            !this.sock ||
            this.sock.destroyed
        ) {
            throw new Error("sidecar went away right after reporting ready")
        }
    }

    /** The sidecar died or its bridge closed on its own. */
    private onSidecarGone(reason: string, kind: RestartKind): void {
        // Before start() completes, a failed first launch is handled there.
        if (!this.started || this.stopping || this.restarting) return
        void this.restartSidecar(reason, { kind })
    }

    /**
     * Replace the sidecar, retrying failed launches with capped, jittered
     * backoff until one succeeds or the node stops. Never exits the
     * process: consensus, sync and block/tx propagation fall back to HTTP
     * while gossip is down.
     */
    private restartSidecar(
        reason: string,
        opts: { afterFailedLaunch?: boolean; kind: RestartKind },
    ): Promise<void> {
        if (this.restarting || this.stopping) {
            return this.recovery ?? Promise.resolve()
        }
        this.restarting = true
        this.recovery = this.runRecovery(reason, opts)
            .catch(e => {
                // The health tick sees the stale sidecar and starts a new recovery.
                log.error(`[GOSSIP] sidecar recovery aborted: ${errorText(e)}`)
            })
            .finally(() => {
                this.restarting = false
                this.recovery = null
            })
        return this.recovery
    }

    private async runRecovery(
        reason: string,
        opts: { afterFailedLaunch?: boolean; kind: RestartKind },
    ): Promise<void> {
        const now = Date.now()
        countSidecarRestart(opts.kind)
        if (this.restartBudget.take(now)) {
            this.flapStreak = 0
        } else {
            this.flapStreak++
        }
        let failedAttempts = opts.afterFailedLaunch ? 1 : 0
        this.enterDegraded(reason, failedAttempts)
        log.error(
            `[GOSSIP] restarting sidecar: ${reason} (restart ${this.restartBudget.used(now)}/${RESTART_MAX} in window${
                this.flapStreak > 0
                    ? `, flapping: relaunches delayed (streak ${this.flapStreak})`
                    : ""
            }); node continues without gossip, HTTP fallback in use`,
        )
        setReadyGauge(false)

        let delay = this.relaunchDelay(failedAttempts + this.flapStreak)
        for (;;) {
            if (delay > 0) {
                this.noteNextAttempt(failedAttempts, Date.now() + delay)
                await this.sleepUnlessStopping(delay)
            }
            if (this.stopping) return
            try {
                await this.teardownSidecar()
                this.readyInfo = null
                this.lastStats = null
                if (this.stopping) return
                await this.launchSidecar(this.sidecarEntry())
                if (this.stopping) {
                    await this.teardownSidecar()
                    return
                }
                const downMs = this.degraded
                    ? Date.now() - this.degraded.since
                    : 0
                this.markUp()
                log.info(
                    `[GOSSIP] sidecar restarted: peerId ${this.readyInfo?.peerId} (gossip was down ${downMs}ms, ${failedAttempts} failed attempt(s))`,
                )
                return
            } catch (e) {
                if (this.stopping) {
                    await this.teardownSidecar()
                    return
                }
                failedAttempts++
                countSidecarRelaunchFailure()
                const tail =
                    this.sidecarTail.length > 0
                        ? `; last sidecar stderr: ${this.sidecarTail.slice(-3).join(" | ")}`
                        : ""
                await this.teardownSidecar()
                delay = this.relaunchDelay(failedAttempts + this.flapStreak)
                log.error(
                    `[GOSSIP] sidecar relaunch attempt ${failedAttempts} failed: ${errorText(e)}${tail}; node keeps running without gossip, retrying in ${delay}ms`,
                )
                this.noteFailure(e, failedAttempts)
            }
        }
    }

    private relaunchDelay(index: number): number {
        return relaunchDelayMs(
            index,
            this.backoff.random,
            this.backoff.baseMs,
            this.backoff.capMs,
        )
    }

    private sleepUnlessStopping(ms: number): Promise<void> {
        if (this.stopping) return Promise.resolve()
        return new Promise(resolve => {
            const t = setTimeout(() => {
                this.wakeRetry = null
                resolve()
            }, ms)
            this.wakeRetry = () => {
                clearTimeout(t)
                this.wakeRetry = null
                resolve()
            }
        })
    }

    private enterDegraded(reason: string, failedAttempts: number): void {
        const now = Date.now()
        if (!this.degraded) {
            this.degraded = {
                since: now,
                reason,
                failedAttempts,
                nextAttemptAt: null,
            }
            subsystemError(getSharedState.subsystems, "gossip", reason, "sidecar")
        } else {
            this.degraded.reason = reason
            this.degraded.failedAttempts = failedAttempts
        }
        setSidecarDegradedGauge(true)
        this.publishDegraded()
    }

    private noteNextAttempt(failedAttempts: number, at: number): void {
        if (!this.degraded) return
        this.degraded.failedAttempts = failedAttempts
        this.degraded.nextAttemptAt = at
        this.publishDegraded()
    }

    private noteFailure(e: unknown, failedAttempts: number): void {
        if (!this.degraded) return
        this.degraded.failedAttempts = failedAttempts
        this.degraded.reason = errorText(e)
        this.publishDegraded()
    }

    private publishDegraded(): void {
        const d = this.degraded
        if (!d) return
        try {
            markSubsystem(getSharedState.subsystems, "gossip", "failed", {
                enabled: true,
                extra: {
                    degraded: true,
                    downSince: d.since,
                    reason: d.reason,
                    failedAttempts: d.failedAttempts,
                    nextAttemptAt: d.nextAttemptAt,
                },
            })
        } catch {
            /* health reporting must never break recovery */
        }
    }

    private markUp(): void {
        this.degraded = null
        setSidecarDegradedGauge(false)
        try {
            markSubsystem(getSharedState.subsystems, "gossip", "ready", {
                enabled: true,
                extra: { degraded: false, peerId: this.readyInfo?.peerId },
            })
        } catch {
            /* health reporting must never break gossip */
        }
    }

    /** Degraded state for health probes; null while the sidecar is up. */
    getDegradedState(): {
        since: number
        reason: string
        failedAttempts: number
        nextAttemptAt: number | null
    } | null {
        return this.degraded ? { ...this.degraded } : null
    }

    private async teardownSidecar(): Promise<void> {
        const sock = this.sock
        const proc = this.proc
        this.sock = null
        this.proc = null
        this.recvBuffer = ""
        sock?.removeAllListeners("close")
        sock?.destroy()
        if (proc && proc.exitCode === null && proc.signalCode === null) {
            proc.kill()
        }
        // Wait for "close" so the old sidecar's stderr is fully logged.
        if (proc && !this.hasClosed(proc)) {
            await new Promise<void>(resolve => {
                const t = setTimeout(() => {
                    proc.kill("SIGKILL")
                    resolve()
                }, STOP_KILL_ESCALATION_MS)
                proc.once("close", () => {
                    clearTimeout(t)
                    resolve()
                })
            })
        }
    }

    private hasClosed(proc: ChildProcess): boolean {
        const stderr = proc.stderr
        return (
            (proc.exitCode !== null || proc.signalCode !== null) &&
            (stderr === null || stderr.destroyed)
        )
    }

    private connectIpc(proc: ChildProcess, timeoutMs: number): Promise<void> {
        const ipc = this.ipcPath()
        const deadline = Date.now() + timeoutMs
        return new Promise((resolve, reject) => {
            const tryConnect = () => {
                if (this.stopping || this.proc !== proc) {
                    reject(new Error("sidecar launch abandoned"))
                    return
                }
                const sock = net.connect(ipc)
                sock.on("connect", () => {
                    if (this.stopping || this.proc !== proc) {
                        sock.destroy()
                        reject(new Error("sidecar launch abandoned"))
                        return
                    }
                    sock.removeAllListeners("error")
                    sock.on("error", () => sock.destroy())
                    this.sock = sock
                    sock.on("data", (d: Buffer) => this.onIpcData(d))
                    sock.on("close", () => {
                        if (this.sock !== sock) return // superseded
                        this.onSidecarGone(
                            "IPC connection to sidecar closed",
                            "ipc_closed",
                        )
                    })
                    this.send({ type: "hello" })
                    resolve()
                })
                sock.on("error", () => {
                    sock.destroy()
                    if (Date.now() > deadline) {
                        reject(
                            new Error(
                                `could not connect to sidecar IPC at ${ipc} within ${timeoutMs}ms`,
                            ),
                        )
                        return
                    }
                    setTimeout(tryConnect, IPC_RETRY_INTERVAL_MS)
                })
            }
            tryConnect()
        })
    }

    /**
     * Resolves on the sidecar's "ready". Registered before the IPC connect
     * so a "ready" right behind the hello is not missed; the timeout runs
     * from arm(), once IPC is connected.
     */
    private awaitReady(): {
        promise: Promise<void>
        arm: () => Promise<void>
        cancel: () => void
    } {
        let timer: ReturnType<typeof setTimeout> | null = null
        let done = false
        let settle: (e?: Error) => void = () => undefined
        const promise = new Promise<void>((resolve, reject) => {
            settle = e => {
                done = true
                if (timer) clearTimeout(timer)
                timer = null
                this.onReady = null
                if (e) reject(e)
                else resolve()
            }
            this.onReady = () => settle()
        })
        // A launch that fails before IPC connects never awaits this promise.
        promise.catch(() => undefined)
        return {
            promise,
            arm: () => {
                if (done) return promise
                timer = setTimeout(
                    () =>
                        settle(
                            new Error(
                                `sidecar did not report ready in ${READY_TIMEOUT_MS}ms`,
                            ),
                        ),
                    READY_TIMEOUT_MS,
                )
                return promise
            },
            cancel: () => settle(new Error("sidecar launch ended")),
        }
    }

    private onReady: (() => void) | null = null

    private send(obj: Record<string, unknown>): void {
        if (!this.sock || this.sock.destroyed) return
        this.sock.write(JSON.stringify({ v: PROTOCOL_VERSION, ...obj }) + "\n")
    }

    private onIpcData(chunk: Buffer): void {
        this.recvBuffer += chunk.toString()
        for (;;) {
            const nl = this.recvBuffer.indexOf("\n")
            if (nl === -1) break
            const line = this.recvBuffer.slice(0, nl)
            this.recvBuffer = this.recvBuffer.slice(nl + 1)
            if (!line.trim()) continue
            let msg: Record<string, never>
            try {
                msg = JSON.parse(line)
            } catch {
                log.warning(
                    `[GOSSIP] unparseable IPC line (${line.length} bytes)`,
                )
                continue
            }
            this.onIpcMessage(msg).catch(e =>
                log.error(
                    `[GOSSIP] IPC message handler error: ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                ),
            )
        }
    }

    private async onIpcMessage(msg: {
        type?: string
        [k: string]: unknown
    }): Promise<void> {
        switch (msg.type) {
            case "hello":
                break
            case "ready": {
                this.readyInfo = {
                    peerId: String(msg.peerId),
                    addrs: (msg.addrs as string[]) ?? [],
                }
                this.lastStatsAt = Date.now()
                this.onReady?.()
                break
            }
            case "stats": {
                const perTopic =
                    (msg.perTopic as SidecarStats["perTopic"]) ?? {}
                this.lastStats = {
                    connections: Number(msg.connections),
                    perTopic,
                    lastInboundAt: Number(msg.lastInboundAt ?? 0),
                }
                this.lastStatsAt = Date.now()
                for (const [topic, t] of Object.entries(perTopic)) {
                    countInbound(topic, t.inbound ?? 0)
                }
                if (
                    typeof msg.lastInboundAt === "number" &&
                    msg.lastInboundAt > this.lastInboundAt
                ) {
                    this.lastInboundAt = msg.lastInboundAt
                }
                break
            }
            case "peer": {
                const line = `[GOSSIP] peer ${msg.event}: ${msg.peerId} (${msg.connections} connections)`
                if (msg.event === "disconnect") log.info(line)
                else log.debug(line)
                break
            }
            case "message": {
                this.lastInboundAt = Date.now()
                if (this.aloneLogged) {
                    this.aloneLogged = false
                    log.info("[GOSSIP] mesh traffic resumed")
                }
                await this.onGossipMessage(
                    String(msg.topic),
                    Buffer.from(String(msg.data), "base64"),
                    String(msg.from ?? ""),
                )
                break
            }
            case "publish_result": {
                if (msg.ok !== true) {
                    log.warning(
                        `[GOSSIP] publish to ${msg.topic} failed in sidecar: ${msg.error}`,
                    )
                    countPublishSkipped("sidecar_error")
                }
                break
            }
            default:
                log.debug(`[GOSSIP] unknown IPC message type: ${msg.type}`)
        }
    }

    async stop(): Promise<void> {
        if (!this.started && !this.proc) return
        log.info("[GOSSIP] stopping")
        this.stopping = true
        this.started = false
        if (this.heightsTimer) clearInterval(this.heightsTimer)
        this.heightsTimer = null
        this.stakeUnsubscribe?.()
        this.stakeUnsubscribe = null
        setReadyGauge(false)
        this.wakeRetry?.()
        this.proc?.stdin?.end()
        await this.teardownSidecar()
        await this.recovery
        setSidecarDegradedGauge(false)
    }

    private lastTickAt = 0

    /** Act on the health verdict: restart on a fault, probe on silence. */
    private checkSidecarHealth(intervalMs: number): void {
        const now = Date.now()
        const tickLateMs = now - this.lastTickAt - intervalMs
        this.lastTickAt = now
        if (this.restarting || this.stopping) return
        const proc = this.proc
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
            void this.restartSidecar("sidecar process is gone", {
                kind: "process_gone",
            })
            return
        }

        const verdict = judgeSidecarHealth({
            now,
            tickLateMs,
            lastStatsAt: this.lastStatsAt,
            lastInboundAt: this.lastInboundAt,
            heightsSubscribers:
                this.lastStats?.perTopic[HEIGHTS_TOPIC]?.subscribers ?? 0,
            processExited:
                this.proc?.exitCode !== null &&
                this.proc?.exitCode !== undefined,
        })
        switch (verdict.kind) {
            case "ok":
                return
            case "deferred":
                log.warning(
                    `[GOSSIP] own event loop stalled ${tickLateMs}ms; stats are ${now - this.lastStatsAt}ms old but the reading is contaminated — deferring to the next clean tick`,
                )
                return
            case "fault":
                void this.restartSidecar(
                    `${verdict.reason}: no stats for ${now - this.lastStatsAt}ms (threshold ${STATS_STALE_MS}ms)`,
                    { kind: verdict.reason },
                )
                return
            case "silent":
                void this.probeSilence(now)
                return
        }
    }

    /** Hello a few staked peers over HTTP; restart the sidecar if any answers, else log that the node is alone. */
    private async probeSilence(now: number): Promise<void> {
        if (this.silenceProbeInFlight) return
        if (now - this.lastSilenceProbeAt < INBOUND_SILENCE_MS) return
        this.silenceProbeInFlight = true
        this.lastSilenceProbeAt = now
        try {
            const staked = await getStakedSet()
            const self = getSharedState.publicKeyHex?.toLowerCase()
            const candidates = PeerManager.getInstance()
                .getAll()
                .filter(
                    p =>
                        p.identity &&
                        p.identity.toLowerCase() !== self &&
                        staked.has(p.identity.toLowerCase()) &&
                        Boolean(p.connection?.string),
                )
                .sort(() => Math.random() - 0.5)
                .slice(0, SILENCE_PROBE_PEERS)
            if (candidates.length === 0) {
                countSilenceProbe("no_candidates")
                this.logAlone("no staked peers to probe")
                return
            }
            const verdicts = await Promise.all(
                candidates.map(p =>
                    PeerManager.sayHelloToPeer(
                        new Peer(p.connection.string, p.identity),
                    ).catch(() => "unreachable" as const),
                ),
            )
            const alive = verdicts.some(
                v => v !== "unreachable" && v !== "skipped",
            )
            if (alive) {
                countSilenceProbe("peers_alive")
                void this.restartSidecar(
                    `mesh silent for ${now - this.lastInboundAt}ms while ${verdicts.filter(v => v !== "unreachable" && v !== "skipped").length}/${candidates.length} probed peer(s) answer over HTTP`,
                    { kind: "mesh_silent" },
                )
                return
            }
            countSilenceProbe("alone")
            this.logAlone(
                `${candidates.length} probed peer(s) unreachable over HTTP`,
            )
        } catch (e) {
            countSilenceProbe("error")
            log.warning(
                `[GOSSIP] silence probe failed: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        } finally {
            this.silenceProbeInFlight = false
        }
    }

    private logAlone(detail: string): void {
        if (this.aloneLogged) return
        this.aloneLogged = true
        log.warning(
            `[GOSSIP] no mesh traffic for ${INBOUND_SILENCE_MS}ms and ${detail}: assuming the node is alone, keeping the sidecar and falling back to HTTP until traffic resumes`,
        )
    }

    /** Sidecar running, stats fresh, and at least one heights subscriber. Gates publishing. */
    private sidecarUp(): boolean {
        if (!this.started || !this.readyInfo || !this.lastStats) return false
        if (this.restarting) return false
        if (Date.now() - this.lastStatsAt > STATS_STALE_MS) return false
        return (this.lastStats.perTopic[HEIGHTS_TOPIC]?.subscribers ?? 0) >= 1
    }

    /** Sidecar up and the mesh delivered something recently. Gates reads, not publishing. */
    isReady(): boolean {
        if (!this.sidecarUp()) return false
        return Date.now() - this.lastInboundAt <= INBOUND_SILENCE_MS
    }

    getListenAddr(): string | null {
        if (!this.readyInfo) return null
        const port = Config.getInstance().gossip.port

        // EXPOSED_URL is the operator's declaration of how peers reach this
        // node; advertise the gossip port on the same host.
        const exposed = parseNodeUrl(getSharedState.exposedUrl)
        if (exposed) {
            const host = isLoopbackHost(exposed.hostname)
                ? "127.0.0.1"
                : exposed.hostname
            const proto = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? "ip4" : "dns4"
            return `/${proto}/${host}/tcp/${port}/p2p/${this.readyInfo.peerId}`
        }

        const publicIP = getSharedState.identity?.publicIP
        if (publicIP) {
            return `/ip4/${publicIP}/tcp/${port}/p2p/${this.readyInfo.peerId}`
        }
        const external = this.readyInfo.addrs.find(
            a => !a.includes("/127.0.0.1/") && !a.includes("/0.0.0.0/"),
        )
        return external ?? this.readyInfo.addrs[0] ?? null
    }

    getPeerId(): string | null {
        return this.readyInfo?.peerId ?? null
    }

    dial(addrs: string[]): void {
        if (!this.started) return
        this.send({ type: "dial", addrs })
    }

    private setTxSubscription(on: boolean): void {
        if (!this.started || this.txSubscribed === on) return
        this.txSubscribed = on
        this.send({ type: on ? "subscribe" : "unsubscribe", topic: TXS_TOPIC })
        log.info(
            `[GOSSIP] ${on ? "joined" : "left"} ${TXS_TOPIC} (node ${on ? "is" : "is not"} staked)`,
        )
    }

    /** Publishing changes network state; only a staked node may do it. */
    private async mayPublish(topic: string): Promise<boolean> {
        if (!this.sidecarUp()) {
            countPublishSkipped("not_ready")
            this.logPublishSkipped(topic, "sidecar not up or no subscribers")
            return false
        }
        if (!(await isSelfStaked())) {
            countPublishSkipped("not_staked")
            this.logPublishSkipped(topic, "node is not staked")
            return false
        }
        return true
    }

    private retryingHeldTxs = false

    /** Re-offer txs whose publish was skipped; one pass in flight at a time. */
    private retryHeldTxs(): void {
        if (this.retryingHeldTxs || !this.sidecarUp()) return
        this.retryingHeldTxs = true
        void import("src/libs/network/txSubmission")
            .then(m => m.retryUnpublishedTxs())
            .catch(e =>
                log.warning(
                    `[GOSSIP] held tx retry failed: ${e instanceof Error ? e.message : String(e)}`,
                ),
            )
            .finally(() => {
                this.retryingHeldTxs = false
            })
    }

    private lastSkipLog = new Map<string, number>()

    /** Log a skipped publish at most once per topic per 30 s. */
    private logPublishSkipped(topic: string, why: string): void {
        const now = Date.now()
        if (now - (this.lastSkipLog.get(topic) ?? 0) < 30_000) return
        this.lastSkipLog.set(topic, now)
        log.debug(`[GOSSIP] publish to ${topic} skipped: ${why}`)
    }

    /** Publish a validated transaction envelope. Fire and forget. */
    async publishTx(validityData: ValidityData): Promise<boolean> {
        if (!(await this.mayPublish(TXS_TOPIC))) return false
        this.send({
            type: "publish",
            topic: TXS_TOPIC,
            data: Buffer.from(JSON.stringify(validityData)).toString("base64"),
        })
        log.debug(
            `[GOSSIP] published tx ${validityData.data.transaction.hash} to ${this.lastStats?.perTopic[TXS_TOPIC]?.subscribers ?? 0} topic peers`,
        )
        return true
    }

    async publishOwnHeights(): Promise<boolean> {
        if (!(await this.mayPublish(HEIGHTS_TOPIC))) return false
        const advertised = this.getListenAddr()
        const record = await buildHeightsRecord(
            this.getPeerId() ?? "",
            advertised ? [advertised] : (this.readyInfo?.addrs ?? []),
        )
        this.send({
            type: "publish",
            topic: HEIGHTS_TOPIC,
            data: Buffer.from(JSON.stringify(record)).toString("base64"),
        })
        log.debug(
            `[GOSSIP] published heights: height ${record.height}, seq ${record.seq}, ${this.lastStats?.perTopic[HEIGHTS_TOPIC]?.subscribers ?? 0} topic peers`,
        )
        return true
    }

    async publishBlock(block: Block): Promise<boolean> {
        if (!(await this.mayPublish(BLOCKS_TOPIC))) return false
        this.send({
            type: "publish",
            topic: BLOCKS_TOPIC,
            data: Buffer.from(JSON.stringify(block)).toString("base64"),
        })
        log.info(
            `[GOSSIP] published block ${block.number} (${block.hash}) to ${this.lastStats?.perTopic[BLOCKS_TOPIC]?.subscribers ?? 0} topic peers`,
        )
        return true
    }

    private lastReady = false
    private lastMeshCount = -1

    private refreshGauges(): void {
        const ready = this.isReady()
        if (ready !== this.lastReady) {
            this.lastReady = ready
            log.info(
                `[GOSSIP] ready state changed: ${
                    ready
                        ? "READY (mesh delivering)"
                        : this.sidecarUp()
                          ? "NOT READY (mesh quiet; still publishing, reads via HTTP)"
                          : "NOT READY (sidecar down or no subscribers)"
                }`,
            )
        }
        setReadyGauge(ready)
        const stats = this.lastStats
        if (!stats) return
        const mesh = stats.perTopic[HEIGHTS_TOPIC]?.mesh ?? 0
        if (mesh !== this.lastMeshCount) {
            log.info(
                `[GOSSIP] mesh peers on '${HEIGHTS_TOPIC}': ${this.lastMeshCount < 0 ? "" : `${this.lastMeshCount} -> `}${mesh} (subscribers: ${stats.perTopic[HEIGHTS_TOPIC]?.subscribers ?? 0}, connections: ${stats.connections})`,
            )
            this.lastMeshCount = mesh
        }
        for (const topic of [HEIGHTS_TOPIC, BLOCKS_TOPIC]) {
            setMeshPeersGauge(topic, stats.perTopic[topic]?.subscribers ?? 0)
        }
    }

    /** Connection URL of the message originator, from the peerId binding
     * learned via heights records; falls back to the raw peerId. */
    private senderUrl(fromPeerId: string): string {
        if (!fromPeerId) return "unknown"
        const peer = PeerManager.getInstance()
            .getAll()
            .find(p => p.gossip?.peerId === fromPeerId)
        return peer?.connection.string || fromPeerId
    }

    // Phase-1 validation placement: the sidecar relays without app-level
    // gating, so every delivered message is validated here before applying.
    private async onGossipMessage(
        topic: string,
        data: Buffer,
        from: string,
    ): Promise<void> {
        if (topic !== HEIGHTS_TOPIC) {
            let seq: number | undefined
            try {
                seq = JSON.parse(data.toString())?.seq
            } catch {
                /* validator rejects unparseable payloads below */
            }
            log.debug(
                `[GOSSIP] message received on '${topic}' (${data.length} bytes) from ${this.senderUrl(from)}${seq !== undefined ? `, seq: ${seq}` : ""}`,
            )
        }
        if (topic === HEIGHTS_TOPIC) {
            const { result, record } = await validateHeightsMessage(
                new Uint8Array(data),
            )
            if (result !== "accept" || !record) return
            await this.applyHeightsRecord(record)
        } else if (topic === BLOCKS_TOPIC) {
            const { result, block } = await validateBlockMessage(
                new Uint8Array(data),
            )
            if (result !== "accept" || !block) return
            log.info(
                `[GOSSIP] block ${block.number} (${block.hash}) received via gossip`,
            )
            await this.applyBlock(block)
        } else if (topic === TXS_TOPIC) {
            const { result, validityData } = await validateTxMessage(
                new Uint8Array(data),
                from,
            )
            if (result !== "accept" || !validityData) return
            await this.applyTx(validityData)
        }
    }

    private async applyTx(validityData: ValidityData): Promise<void> {
        const hash = validityData.data.transaction.hash
        const mempoolModule = await import("src/libs/blockchain/mempool")
        const outcome = await mempoolModule.default.ingestGossiped(validityData)
        if (outcome.accepted) {
            countTxIngest("accepted")
            log.debug(
                `[GOSSIP] tx ${hash} ingested from ${validityData.rpc_public_key.data}, target block ${outcome.confirmationBlock}`,
            )
            return
        }
        const duplicate =
            outcome.reason?.startsWith("in_mempool") ||
            outcome.reason?.startsWith("on_chain") ||
            outcome.reason?.includes("already")
        countTxIngest(duplicate ? "duplicate" : "rejected")
        log.debug(`[GOSSIP] tx ${hash} not ingested: ${outcome.reason}`)
    }

    private async applyHeightsRecord(record: HeightsRecord): Promise<void> {
        if (
            record.pubkey.toLowerCase() ===
            getSharedState.publicKeyHex?.toLowerCase()
        ) {
            reportTwin("heights", record.url || record.addrs.join(","))
            return
        }
        const peerman = PeerManager.getInstance()
        const { BroadcastManager: broadcaster } =
            await import("src/libs/communications/broadcastManager")

        const status =
            record.height >= getSharedState.lastBlockNumber ? "1" : "0"
        const res = await broadcaster.handleUpdatePeerSyncData(
            record.pubkey,
            `${status}:${record.height}:${record.headHash}`,
        )
        countHeightsRecord(res?.result === 200 ? "applied" : "not_applied")
        if (res?.result !== 200) {
            log.debug(
                `[GOSSIP] heights record for ${record.pubkey} not applied: ${res?.message ?? "unknown"}`,
            )
        }

        const peer = peerman.getPeer(record.pubkey)
        if (peer) {
            const known = peer.gossip
            peer.gossip = {
                peerId: record.peerId,
                addrs: record.addrs,
                seq: record.seq,
                height: record.height,
                headHash: record.headHash,
            }
            peerman.updatePeerLastSeen(record.pubkey)

            if (record.url && record.url !== peer.connection.string) {
                const updated = new Peer(record.url, record.pubkey)
                updated.sync = peer.sync
                updated.gossip = peer.gossip
                updated.status = peer.status
                updated.verification = peer.verification
                const [ok, message] = peerman.addPeer(updated, true)
                log.info(
                    `[GOSSIP] ${record.pubkey} announced new URL ${record.url}: ${ok ? "updated" : `rejected (${message})`}`,
                )
            }

            if (
                !known ||
                known.peerId !== record.peerId ||
                known.addrs.join(",") !== record.addrs.join(",")
            ) {
                log.debug(
                    `[GOSSIP] new transport binding for ${record.pubkey}: peerId ${record.peerId}, dialing advertised addrs`,
                )
                this.dial(record.addrs)
            }
        } else if (record.url) {
            this.helloUnknownPeer(record.pubkey, record.url)
        }
    }

    private helloAttempts = new Map<string, number>()
    private helloUnknownPeer(pubkey: string, url: string): void {
        const now = Date.now()
        if ((this.helloAttempts.get(pubkey) ?? 0) > now) return
        this.helloAttempts.set(pubkey, now + 60_000)

        log.info(
            `[GOSSIP] heights record from unknown staked peer ${pubkey} at ${url}: verifying with a hello`,
        )
        void PeerManager.sayHelloToPeer(new Peer(url, pubkey)).catch(e =>
            log.debug(
                `[GOSSIP] hello to unknown peer ${pubkey} failed: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            ),
        )
    }

    private async applyBlock(block: Block): Promise<void> {
        const sender = this.resolveBlockSender(block)
        if (!sender) {
            log.warning(
                `[GOSSIP] no reachable sender candidate for block ${block.number}; leaving it to the poller`,
            )
            return
        }

        log.info(
            `[GOSSIP] handing block ${block.number} to handleNewBlock (tx fetch peer: ${sender})`,
        )
        const { BroadcastManager: broadcaster } =
            await import("src/libs/communications/broadcastManager")
        const { syncLock } = await import("src/libs/blockchain/routines/Sync")
        await syncLock.runExclusive(() =>
            broadcaster.handleNewBlock(sender, block as never, "gossip"),
        )
    }

    /** Fetch the block's tx bodies over HTTP from a signer, else any peer past this height. */
    private resolveBlockSender(block: Block): string | null {
        const peerman = PeerManager.getInstance()
        const signers = Object.keys(block.validation_data?.signatures ?? {})

        for (const signer of signers) {
            const peer = peerman.getPeer(signer)
            if (peer && peer.status.online) return signer
        }
        const synced = peerman
            .getPeers()
            .find(p => p.status.online && p.sync.block >= block.number)
        return synced?.identity ?? null
    }
}

export default GossipManager

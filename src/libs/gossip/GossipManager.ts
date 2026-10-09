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
    countInbound,
    countSilenceProbe,
} from "./metrics"
import {
    INBOUND_SILENCE_MS,
    judgeSidecarHealth,
    RestartBudget,
    STATS_STALE_MS,
} from "./sidecarHealth"
import { getStakedSet } from "src/libs/consensus/stakedSet"

const PROTOCOL_VERSION = 1
const IPC_CONNECT_TIMEOUT_MS = 5000
const STOP_KILL_ESCALATION_MS = 2000
/** Restarts allowed per window before the node gives up (D11 fatal). */
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

    static getInstance(): GossipManager {
        if (!GossipManager.instance) {
            GossipManager.instance = new GossipManager()
        }
        return GossipManager.instance
    }

    static isEnabled(): boolean {
        return Config.getInstance().gossip.enabled
    }

    // any gossip failure is fatal by design (debug posture).
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

    async start(): Promise<void> {
        if (this.started) return
        const cfg = Config.getInstance().gossip

        try {
            registerGossipMetrics()

            const entry = this.sidecarEntry()
            if (!fs.existsSync(entry)) {
                throw new Error(
                    `sidecar entry not found at ${entry} — run 'bun run sidecar:build' (or set GOSSIP_SIDECAR_PATH)`,
                )
            }

            await this.launchSidecar(entry)

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
                this.refreshGauges()
            }, cfg.heightsIntervalMs)

            this.started = true
            // Receive-only unless staked: the tx topic is joined and left
            // as the node's own stake status changes. Heights and blocks
            // are always received; publishing them is gated per call.
            this.stakeUnsubscribe = onSelfStakeChange(staked =>
                this.setTxSubscription(staked),
            )
            log.info(
                `[GOSSIP] started: sidecar peerId ${this.readyInfo?.peerId}, gossip port ${cfg.port}`,
            )
        } catch (e) {
            this.fatal("start()", e)
        }
    }

    /**
     * Spawn the sidecar, bring the IPC bridge up, and wait for ready.
     * Used both at start and on every restart; the heights timer and the
     * stake listener live outside it and survive restarts.
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
        proc.on("error", e => {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                this.fatal(
                    "sidecar spawn",
                    new Error(
                        "Node.js runtime not found on PATH — the gossip sidecar requires Node >= 20 (or set GOSSIP_ENABLED=false)",
                    ),
                )
            }
            this.fatal("sidecar spawn", e)
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
        // "close", not "exit": it fires once stdio has drained, so the
        // sidecar's last stderr lines (its crash reason) are logged first.
        proc.on("close", (code, signal) => {
            if (this.proc !== proc) return // a superseded process
            this.onSidecarGone(
                `process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
            )
        })

        await this.connectIpc()
        await this.awaitReady()

        // Fresh start grace: judge silence from now, not from epoch.
        const now = Date.now()
        this.lastStatsAt = now
        this.lastInboundAt = now

        // Re-establish everything the previous sidecar knew.
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
    }

    /** The sidecar died or its bridge closed on its own. */
    private onSidecarGone(reason: string): void {
        if (this.stopping || this.restarting) return
        void this.restartSidecar(reason)
    }

    /**
     * Replace a sidecar that positive evidence says is broken. Bounded by
     * the restart budget; past it, the node goes down with the sidecar as
     * D11 intends.
     */
    private async restartSidecar(reason: string): Promise<void> {
        if (this.restarting || this.stopping) return
        this.restarting = true
        const now = Date.now()
        countSidecarRestart(reason)
        if (!this.restartBudget.take(now)) {
            this.fatal(
                "sidecar restart budget",
                new Error(
                    `${reason}; ${RESTART_MAX} restarts already in the last ${RESTART_WINDOW_MS / 60_000} min`,
                ),
            )
        }
        log.error(
            `[GOSSIP] restarting sidecar: ${reason} (restart ${this.restartBudget.used(now)}/${RESTART_MAX} in window)`,
        )
        setReadyGauge(false)
        try {
            await this.teardownSidecar()
            this.readyInfo = null
            this.lastStats = null
            await this.launchSidecar(this.sidecarEntry())
            log.info(
                `[GOSSIP] sidecar restarted: peerId ${this.readyInfo?.peerId}`,
            )
        } catch (e) {
            this.fatal("sidecar restart", e)
        } finally {
            this.restarting = false
        }
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
        // Wait for "close" (stdio drained) so the old sidecar's final
        // stderr lines land in the log before the restart/fatal message.
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
        // Streams are closed and destroyed once "close" has fired.
        const stderr = proc.stderr
        return (
            (proc.exitCode !== null || proc.signalCode !== null) &&
            (stderr === null || stderr.destroyed)
        )
    }

    private connectIpc(): Promise<void> {
        const ipc = this.ipcPath()
        const deadline = Date.now() + IPC_CONNECT_TIMEOUT_MS
        return new Promise((resolve, reject) => {
            const tryConnect = () => {
                const sock = net.connect(ipc)
                sock.on("connect", () => {
                    this.sock = sock
                    sock.on("data", (d: Buffer) => this.onIpcData(d))
                    sock.on("close", () => {
                        if (this.sock !== sock) return // superseded
                        this.onSidecarGone("IPC connection to sidecar closed")
                    })
                    this.send({ type: "hello" })
                    resolve()
                })
                sock.on("error", () => {
                    sock.destroy()
                    if (Date.now() > deadline) {
                        reject(
                            new Error(
                                `could not connect to sidecar IPC at ${ipc} within ${IPC_CONNECT_TIMEOUT_MS}ms`,
                            ),
                        )
                        return
                    }
                    setTimeout(tryConnect, 100)
                })
            }
            tryConnect()
        })
    }

    private awaitReady(): Promise<void> {
        return new Promise((resolve, reject) => {
            const t = setTimeout(
                () => reject(new Error("sidecar did not report ready in 10s")),
                10_000,
            )
            this.onReady = () => {
                clearTimeout(t)
                this.onReady = null
                resolve()
            }
        })
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
                // Seed the staleness clock so the wedge check never compares
                // against epoch 0 before the first stats message is read.
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
        this.stakeUnsubscribe?.()
        this.stakeUnsubscribe = null
        setReadyGauge(false)
        this.proc?.stdin?.end()
        await this.teardownSidecar()
    }

    private lastTickAt = 0

    /**
     * Liveness, once per heights tick. The verdict comes from the pure
     * judge in sidecarHealth.ts; this method only acts on it. A stalled
     * heartbeat is a fault. Silence is not: it goes to the HTTP probe,
     * which decides whether the mesh is dead or the node is alone.
     */
    private checkSidecarHealth(intervalMs: number): void {
        const now = Date.now()
        const tickLateMs = now - this.lastTickAt - intervalMs
        this.lastTickAt = now
        if (this.restarting || this.stopping) return

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
                )
                return
            case "silent":
                void this.probeSilence(now)
                return
        }
    }

    /**
     * Gossip has been silent with subscribers present. Ask the network over
     * HTTP: any staked peer that answers a hello proves the network is
     * alive and the mesh is at fault. Nobody answering means the node is
     * alone, which is not a fault and must not restart anything.
     */
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

    /**
     * The sidecar is up, reporting, and has at least one heights
     * subscriber. This is the publish gate: a node must keep speaking into
     * a quiet mesh, otherwise a network where every node waits to hear
     * something first never produces anything to hear.
     */
    private sidecarUp(): boolean {
        if (!this.started || !this.readyInfo || !this.lastStats) return false
        if (this.restarting) return false
        if (Date.now() - this.lastStatsAt > STATS_STALE_MS) return false
        return (this.lastStats.perTopic[HEIGHTS_TOPIC]?.subscribers ?? 0) >= 1
    }

    /**
     * Whether callers should prefer gossip over HTTP right now: the sidecar
     * is up AND the mesh has delivered something recently. Never used to
     * gate publishing (see sidecarUp).
     */
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

    private lastSkipLog = new Map<string, number>()

    /** One debug line per topic per 30 s, so a quiet log still says why. */
    private logPublishSkipped(topic: string, why: string): void {
        const now = Date.now()
        if (now - (this.lastSkipLog.get(topic) ?? 0) < 30_000) return
        this.lastSkipLog.set(topic, now)
        log.debug(`[GOSSIP] publish to ${topic} skipped: ${why}`)
    }

    /**
     * Publish a validated transaction envelope. Fire and forget: no ack,
     * no retry. Receivers dedup on the tx hash; the per-block mempool merge
     * repairs anything the mesh dropped.
     */
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
        let seq: number | undefined
        try {
            seq = JSON.parse(data.toString())?.seq
        } catch {
            /* validator rejects unparseable payloads below */
        }
        log.debug(
            `[GOSSIP] message received on '${topic}' (${data.length} bytes) from ${this.senderUrl(from)}${seq !== undefined ? `, seq: ${seq}` : ""}`,
        )
        if (topic === HEIGHTS_TOPIC) {
            const { result, record } = await validateHeightsMessage(
                new Uint8Array(data),
            )
            if (result !== "accept" || !record) return
            log.debug(
                `[GOSSIP] heights record from ${record.pubkey}: height ${record.height}, seq ${record.seq}`,
            )
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
        log.debug(
            `[GOSSIP] heights record for ${record.pubkey} ${
                res?.result === 200
                    ? "applied to peer sync state"
                    : `not applied: ${res?.message ?? "unknown"}`
            }`,
        )

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

    /**
     * The gossip deliverer is a mesh relay, not HTTP-callable. Tx bodies
     * are fetched over HTTP from a block signer (guaranteed to have them),
     * else any peer synced past this height.
     */
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

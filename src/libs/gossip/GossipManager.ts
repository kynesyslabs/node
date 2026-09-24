import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn, ChildProcess } from "node:child_process"
import type { Block } from "@kynesyslabs/demosdk/types"

import log from "src/utilities/logger"
import { Config } from "src/config"
import { getSharedState } from "@/utilities/sharedState"
import { PeerManager } from "src/libs/peer"

import {
    buildHeightsRecord,
    HeightsRecord,
    isHeightsRecordShape,
} from "./records"
import { validateBlockMessage, validateHeightsMessage } from "./validators"
import { BLOCKS_TOPIC, HEIGHTS_TOPIC } from "./topics"
import {
    countHeightsRecord,
    countPublishSkipped,
    registerGossipMetrics,
    setMeshPeersGauge,
    setReadyGauge,
} from "./metrics"

const PROTOCOL_VERSION = 1
const IPC_CONNECT_TIMEOUT_MS = 5000
const STOP_KILL_ESCALATION_MS = 2000
const STATS_STALE_FATAL_MS = 5000

interface SidecarStats {
    connections: number
    perTopic: Record<string, { subscribers: number; mesh: number }>
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
        log.error(
            `[GOSSIP] FATAL in ${context}: ${
                error instanceof Error
                    ? (error.stack ?? error.message)
                    : String(error)
            }`,
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

            log.info(`[GOSSIP] spawning sidecar: node ${entry}`)
            this.proc = spawn("node", [entry], {
                env: {
                    ...process.env,
                    GOSSIP_PORT: String(cfg.port),
                    GOSSIP_KEY_FILE: cfg.keyFile,
                    GOSSIP_IPC_PATH: this.ipcPath(),
                },
                stdio: ["pipe", "ignore", "pipe"],
            })
            this.proc.on("error", e => {
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
            this.proc.stderr?.on("data", (d: Buffer) => {
                for (const line of d.toString().split("\n")) {
                    if (line.trim()) log.warning(`[GOSSIP-SIDECAR] ${line}`)
                }
            })
            this.proc.on("exit", code => {
                if (!this.stopping) {
                    this.fatal(
                        "sidecar process",
                        new Error(`sidecar exited unexpectedly with code ${code}`),
                    )
                }
            })

            await this.connectIpc()
            await this.awaitReady()

            this.heightsTimer = setInterval(() => {
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
            log.info(
                `[GOSSIP] started: sidecar peerId ${this.readyInfo?.peerId}, gossip port ${cfg.port}`,
            )
        } catch (e) {
            this.fatal("start()", e)
        }
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
                        if (!this.stopping) {
                            this.fatal(
                                "ipc socket",
                                new Error("IPC connection to sidecar closed"),
                            )
                        }
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
        this.sock.write(
            JSON.stringify({ v: PROTOCOL_VERSION, ...obj }) + "\n",
        )
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
                log.warning(`[GOSSIP] unparseable IPC line (${line.length} bytes)`)
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
                this.onReady?.()
                break
            }
            case "stats": {
                this.lastStats = {
                    connections: Number(msg.connections),
                    perTopic: (msg.perTopic as SidecarStats["perTopic"]) ?? {},
                }
                this.lastStatsAt = Date.now()
                break
            }
            case "peer": {
                const line = `[GOSSIP] peer ${msg.event}: ${msg.peerId} (${msg.connections} connections)`
                if (msg.event === "disconnect") log.info(line)
                else log.debug(line)
                break
            }
            case "message": {
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
        setReadyGauge(false)
        this.sock?.end()
        this.proc?.stdin?.end()
        const proc = this.proc
        if (proc) {
            await new Promise<void>(resolve => {
                const t = setTimeout(() => {
                    proc.kill()
                    resolve()
                }, STOP_KILL_ESCALATION_MS)
                proc.on("exit", () => {
                    clearTimeout(t)
                    resolve()
                })
            })
        }
        this.proc = null
        this.sock = null
    }

    isReady(): boolean {
        if (!this.started || !this.readyInfo || !this.lastStats) return false
        if (Date.now() - this.lastStatsAt > STATS_STALE_FATAL_MS) {
            this.fatal(
                "stats heartbeat",
                new Error(
                    `no stats from sidecar for ${Date.now() - this.lastStatsAt}ms — sidecar wedged`,
                ),
            )
        }
        return (this.lastStats.perTopic[HEIGHTS_TOPIC]?.subscribers ?? 0) >= 1
    }

    getListenAddr(): string | null {
        if (!this.readyInfo) return null
        const publicIP = getSharedState.identity?.publicIP
        if (publicIP) {
            const port = Config.getInstance().gossip.port
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

    async publishOwnHeights(): Promise<boolean> {
        if (!this.isReady()) {
            countPublishSkipped("not_ready")
            return false
        }
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
        if (!this.isReady()) {
            countPublishSkipped("not_ready")
            return false
        }
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
                `[GOSSIP] ready state changed: ${ready ? "READY (mesh has peers)" : "NOT READY (mesh empty)"}`,
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
        }
    }

    private async applyHeightsRecord(record: HeightsRecord): Promise<void> {
        const peerman = PeerManager.getInstance()
        const { BroadcastManager: broadcaster } = await import(
            "src/libs/communications/broadcastManager"
        )

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
        }
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
        const { BroadcastManager: broadcaster } = await import(
            "src/libs/communications/broadcastManager"
        )
        await broadcaster.handleNewBlock(sender, block as never, "gossip")
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

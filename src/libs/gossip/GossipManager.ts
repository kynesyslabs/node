import { createLibp2p, Libp2p } from "libp2p"
import { tcp } from "@libp2p/tcp"
import { noise } from "@chainsafe/libp2p-noise"
import { yamux } from "@chainsafe/libp2p-yamux"
import { identify } from "@libp2p/identify"
import { gossipsub, GossipSub } from "@chainsafe/libp2p-gossipsub"
import { multiaddr } from "@multiformats/multiaddr"
import type { Message, PeerId } from "@libp2p/interface"
import type { Block } from "@kynesyslabs/demosdk/types"

import log from "src/utilities/logger"
import { Config } from "src/config"
import { getSharedState } from "src/utilities/sharedState"
import { PeerManager } from "src/libs/peer"

import { loadOrCreateTransportKey } from "./identity"
import {
    buildHeightsRecord,
    HeightsRecord,
    isHeightsRecordShape,
} from "./records"
import { validateBlockMessage, validateHeightsMessage } from "./validators"
import {
    BLOCKS_TOPIC,
    GOSSIPSUB_PARAMS,
    gossipMsgId,
    HEIGHTS_TOPIC,
} from "./topics"
import {
    countHeightsRecord,
    countPublishSkipped,
    registerGossipMetrics,
    setMeshPeersGauge,
    setReadyGauge,
} from "./metrics"

const REQ_PROTOCOL = "/demos/req/1.0.0"

export class GossipManager {
    private static instance: GossipManager | null = null

    private node: Libp2p | null = null
    private started = false
    private heightsTimer: ReturnType<typeof setInterval> | null = null
    private requestHandler: ((data: Uint8Array) => Promise<Uint8Array>) | null =
        null

    static getInstance(): GossipManager {
        if (!GossipManager.instance) {
            GossipManager.instance = new GossipManager()
        }
        return GossipManager.instance
    }

    static isEnabled(): boolean {
        return Config.getInstance().gossip.enabled
    }

    private pubsub(): GossipSub {
        return this.node!.services.pubsub as GossipSub
    }

    // any gossip-module failure is fatal by design (debug posture).
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

    async start(): Promise<void> {
        if (this.started) return
        const cfg = Config.getInstance().gossip

        try {
            registerGossipMetrics()
            const privateKey = await loadOrCreateTransportKey(cfg.keyFile)

            this.node = await createLibp2p({
                privateKey,
                addresses: { listen: [`/ip4/0.0.0.0/tcp/${cfg.port}`] },
                transports: [tcp()],
                connectionEncrypters: [noise()],
                streamMuxers: [yamux()],
                services: {
                    identify: identify(),
                    pubsub: gossipsub({
                        ...GOSSIPSUB_PARAMS,
                        msgIdFn: gossipMsgId,
                    }),
                },
            })

            const pubsub = this.pubsub()
            pubsub.topicValidators.set(
                HEIGHTS_TOPIC,
                async (_peer: PeerId, msg: Message) =>
                    (await validateHeightsMessage(msg)).result,
            )
            pubsub.topicValidators.set(
                BLOCKS_TOPIC,
                async (_peer: PeerId, msg: Message) =>
                    (await validateBlockMessage(msg)).result,
            )

            pubsub.addEventListener("message", evt => {
                this.onMessage(evt.detail).catch(e =>
                    log.error(
                        `[GOSSIP] message handler error: ${
                            e instanceof Error ? e.message : String(e)
                        }`,
                    ),
                )
            })

            this.node.addEventListener("peer:connect", evt => {
                log.debug(
                    `[GOSSIP] peer connected: ${evt.detail.toString()} (${this.node?.getConnections().length ?? 0} connections)`,
                )
            })
            this.node.addEventListener("peer:disconnect", evt => {
                log.debug(
                    `[GOSSIP] peer disconnected: ${evt.detail.toString()} (${this.node?.getConnections().length ?? 0} connections)`,
                )
            })
            pubsub.addEventListener("subscription-change", evt => {
                for (const sub of evt.detail.subscriptions) {
                    log.debug(
                        `[GOSSIP] ${evt.detail.peerId.toString()} ${sub.subscribe ? "subscribed to" : "unsubscribed from"} '${sub.topic}'`,
                    )
                }
            })

            pubsub.subscribe(HEIGHTS_TOPIC)
            pubsub.subscribe(BLOCKS_TOPIC)
            log.debug(
                `[GOSSIP] subscribed to '${HEIGHTS_TOPIC}' and '${BLOCKS_TOPIC}'`,
            )

            await this.node.handle(REQ_PROTOCOL, ({ stream }) => {
                void this.serveRequest(stream)
            })

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
                `[GOSSIP] started: peerId ${this.node.peerId.toString()}, listening on port ${cfg.port}`,
            )
        } catch (e) {
            this.fatal("start()", e)
        }
    }

    async stop(): Promise<void> {
        if (!this.started) return
        log.info("[GOSSIP] stopping")
        this.started = false
        if (this.heightsTimer) clearInterval(this.heightsTimer)
        setReadyGauge(false)
        try {
            await this.node?.stop()
        } catch (e) {
            this.fatal("stop()", e)
        }
    }

    isReady(): boolean {
        if (!this.started || !this.node) return false
        try {
            return this.pubsub().getSubscribers(HEIGHTS_TOPIC).length >= 1
        } catch {
            return false
        }
    }

    getListenAddr(): string | null {
        if (!this.started || !this.node) return null
        const publicIP = getSharedState.identity?.publicIP
        if (publicIP) {
            const port = Config.getInstance().gossip.port
            return `/ip4/${publicIP}/tcp/${port}/p2p/${this.node.peerId.toString()}`
        }
        const addrs = this.node.getMultiaddrs().map(a => a.toString())
        if (addrs.length === 0) return null
        const external = addrs.find(
            a => !a.includes("/127.0.0.1/") && !a.includes("/0.0.0.0/"),
        )
        return external ?? addrs[0]
    }

    getPeerId(): string | null {
        return this.node?.peerId.toString() ?? null
    }

    dial(addrs: string[]): void {
        if (!this.started || !this.node) return
        for (const addr of addrs) {
            log.debug(`[GOSSIP] dialing ${addr}`)
            this.node
                .dial(multiaddr(addr))
                .then(() => log.debug(`[GOSSIP] dial succeeded: ${addr}`))
                .catch(e =>
                    log.debug(
                        `[GOSSIP] dial ${addr} failed: ${
                            e instanceof Error ? e.message : String(e)
                        }`,
                    ),
                )
        }
    }

    async publishOwnHeights(): Promise<boolean> {
        if (!this.isReady()) {
            countPublishSkipped("not_ready")
            return false
        }
        const advertised = this.getListenAddr()
        const record = await buildHeightsRecord(
            this.getPeerId() ?? "",
            advertised
                ? [advertised]
                : this.node!.getMultiaddrs().map(a => a.toString()),
        )
        await this.pubsub().publish(
            HEIGHTS_TOPIC,
            new TextEncoder().encode(JSON.stringify(record)),
        )
        log.debug(
            `[GOSSIP] published heights: height ${record.height}, seq ${record.seq}, ${this.pubsub().getSubscribers(HEIGHTS_TOPIC).length} topic peers`,
        )
        return true
    }

    async publishBlock(block: Block): Promise<boolean> {
        if (!this.isReady()) {
            countPublishSkipped("not_ready")
            return false
        }
        await this.pubsub().publish(
            BLOCKS_TOPIC,
            new TextEncoder().encode(JSON.stringify(block)),
        )
        log.info(
            `[GOSSIP] published block ${block.number} (${block.hash}) to ${this.pubsub().getSubscribers(BLOCKS_TOPIC).length} topic peers`,
        )
        return true
    }

    private lastReady = false

    private refreshGauges(): void {
        const ready = this.isReady()
        if (ready !== this.lastReady) {
            this.lastReady = ready
            log.info(
                `[GOSSIP] ready state changed: ${ready ? "READY (mesh has peers)" : "NOT READY (mesh empty)"}`,
            )
        }
        setReadyGauge(ready)
        if (!this.node) return
        try {
            setMeshPeersGauge(
                HEIGHTS_TOPIC,
                this.pubsub().getSubscribers(HEIGHTS_TOPIC).length,
            )
            setMeshPeersGauge(
                BLOCKS_TOPIC,
                this.pubsub().getSubscribers(BLOCKS_TOPIC).length,
            )
        } catch {
            /* gauges only */
        }
    }

    // The 'message' event only fires for messages the topic validators
    // accepted, so this only re-parses; re-validating would consume the
    // heights seq LRU twice and drop every record.
    private async onMessage(msg: Message): Promise<void> {
        log.debug(
            `[GOSSIP] message received on '${msg.topic}' (${msg.data.length} bytes)`,
        )
        let payload: unknown
        try {
            payload = JSON.parse(new TextDecoder().decode(msg.data))
        } catch {
            return
        }
        if (msg.topic === HEIGHTS_TOPIC && isHeightsRecordShape(payload)) {
            log.debug(
                `[GOSSIP] heights record from ${payload.pubkey}: height ${payload.height}, seq ${payload.seq}`,
            )
            await this.applyHeightsRecord(payload)
        } else if (msg.topic === BLOCKS_TOPIC) {
            const block = payload as Block
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

    // --- Unicast request/response ---

    onRequest(handler: (data: Uint8Array) => Promise<Uint8Array>): void {
        this.requestHandler = handler
    }

    async request(addr: string, data: Uint8Array): Promise<Uint8Array> {
        if (!this.started || !this.node) {
            throw new Error("gossip not started")
        }
        log.debug(
            `[GOSSIP] request to ${addr} (${data.length} bytes) on ${REQ_PROTOCOL}`,
        )
        const stream = await this.node.dialProtocol(
            multiaddr(addr),
            REQ_PROTOCOL,
        )
        await stream.sink([data])
        const chunks: Uint8Array[] = []
        for await (const chunk of stream.source) {
            chunks.push(chunk.subarray())
        }
        return concat(chunks)
    }

    private async serveRequest(stream: {
        sink: (source: Iterable<Uint8Array>) => Promise<void>
        source: AsyncIterable<{ subarray: () => Uint8Array }>
        close?: () => Promise<void>
    }): Promise<void> {
        try {
            const chunks: Uint8Array[] = []
            for await (const chunk of stream.source) {
                chunks.push(chunk.subarray())
            }
            const request = concat(chunks)
            log.debug(
                `[GOSSIP] inbound request (${request.length} bytes), handler ${this.requestHandler ? "registered" : "missing"}`,
            )
            const response = this.requestHandler
                ? await this.requestHandler(request)
                : new Uint8Array(0)
            await stream.sink([response])
        } catch (e) {
            log.debug(
                `[GOSSIP] request serve failed: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            )
        }
    }
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
        out.set(c, offset)
        offset += c.length
    }
    return out
}

export default GossipManager

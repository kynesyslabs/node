// Demos gossip sidecar: a Node.js libp2p host driven by the Bun node over
// a Unix-socket NDJSON bridge (specs/gossip-sidecar.md). It moves bytes
// and maintains the mesh — no chain logic lives here.
import "./polyfill.js"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { createHash } from "node:crypto"
import { inspect } from "node:util"
import readline from "node:readline"

import { createLibp2p } from "libp2p"
import { tcp } from "@libp2p/tcp"
import { noise } from "@chainsafe/libp2p-noise"
import { yamux } from "@chainsafe/libp2p-yamux"
import { identify } from "@libp2p/identify"
import { gossipsub } from "@chainsafe/libp2p-gossipsub"
import { multiaddr } from "@multiformats/multiaddr"
import {
    generateKeyPair,
    privateKeyFromProtobuf,
    privateKeyToProtobuf,
} from "@libp2p/crypto/keys"

const PROTOCOL_VERSION = 1
const HEIGHTS_TOPIC = "demos/heights/1"
const BLOCKS_TOPIC = "demos/blocks/1"
// Reserved for phase 2: validate, verdict, set_validators, request, respond

const PORT = parseInt(process.env.GOSSIP_PORT ?? "9095", 10)
const KEY_FILE = process.env.GOSSIP_KEY_FILE ?? ".demos_gossip_key"
const IPC_PATH =
    process.env.GOSSIP_IPC_PATH ?? path.join(".", `gossip-${PORT}.sock`)
const STATS_INTERVAL_MS = 1000
const CLIENT_GONE_EXIT_MS = 5000

const slog = (msg) => process.stderr.write(`[SIDECAR] ${msg}\n`)

// Errors that mean a gossipsub stream silently died; the node must know.
const FATAL_LOG_PATTERNS = ["outbound pipe error"]

function componentLogger() {
    const makeLogger = (component) => {
        const noop = () => {}
        const logger = noop
        logger.error = (...args) => {
            const message = args
                .map((a) => {
                    if (a instanceof Error) return a.stack ?? a.message
                    if (typeof a === "object" && a !== null) {
                        return inspect(a, { depth: 3, breakLength: Infinity })
                    }
                    return String(a)
                })
                .join(" ")
            slog(`libp2p:${component} ERROR ${message}`)
            if (FATAL_LOG_PATTERNS.some((p) => message.includes(p))) {
                slog(`FATAL stream failure in ${component}: ${message}`)
                process.exit(1)
            }
        }
        logger.trace = noop
        logger.enabled = false
        logger.newScope = (name) => makeLogger(`${component}:${name}`)
        return logger
    }
    return { forComponent: makeLogger }
}

// Content-derived message IDs — MUST stay in sync with the rules in
// src/libs/gossip/topics.ts (block hash for blocks, pubkey+seq for heights).
function gossipMsgId(msg) {
    const enc = new TextEncoder()
    try {
        const payload = JSON.parse(new TextDecoder().decode(msg.data))
        if (msg.topic === BLOCKS_TOPIC && typeof payload?.hash === "string") {
            return enc.encode(`block:${payload.hash}`)
        }
        if (
            msg.topic === HEIGHTS_TOPIC &&
            typeof payload?.pubkey === "string" &&
            typeof payload?.seq === "number"
        ) {
            return enc.encode(`heights:${payload.pubkey}:${payload.seq}`)
        }
    } catch {
        // malformed payload: fall through, content hash still dedups
    }
    return new Uint8Array(createHash("sha256").update(msg.data).digest())
}

async function loadOrCreateTransportKey(keyFile) {
    try {
        if (fs.existsSync(keyFile)) {
            return privateKeyFromProtobuf(new Uint8Array(fs.readFileSync(keyFile)))
        }
    } catch (e) {
        slog(`transport key at ${keyFile} unreadable (${e.message}); regenerating`)
    }
    const key = await generateKeyPair("Ed25519")
    fs.writeFileSync(keyFile, privateKeyToProtobuf(key), { mode: 0o600 })
    return key
}

// --- libp2p host ---

const privateKey = await loadOrCreateTransportKey(KEY_FILE)
const node = await createLibp2p({
    privateKey,
    logger: componentLogger(),
    addresses: { listen: [`/ip4/0.0.0.0/tcp/${PORT}`] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
        identify: identify(),
        pubsub: gossipsub({
            D: 8,
            Dlo: 6,
            Dhi: 12,
            doPX: true,
            allowPublishToZeroTopicPeers: true,
            msgIdFn: gossipMsgId,
        }),
    },
})
const pubsub = node.services.pubsub
pubsub.subscribe(HEIGHTS_TOPIC)
pubsub.subscribe(BLOCKS_TOPIC)
slog(`libp2p up: peerId ${node.peerId.toString()} port ${PORT}`)

// --- IPC bridge ---

let client = null
let clientGoneTimer = null

function send(obj) {
    if (!client || client.destroyed) return
    client.write(JSON.stringify({ v: PROTOCOL_VERSION, ...obj }) + "\n")
}

function statsPayload() {
    const perTopic = {}
    for (const topic of [HEIGHTS_TOPIC, BLOCKS_TOPIC]) {
        perTopic[topic] = {
            subscribers: pubsub.getSubscribers(topic).length,
            mesh: pubsub.getMeshPeers(topic).length,
        }
    }
    return { connections: node.getConnections().length, perTopic }
}

node.addEventListener("peer:connect", (evt) => {
    slog(`peer connected: ${evt.detail.toString()}`)
    send({
        type: "peer",
        event: "connect",
        peerId: evt.detail.toString(),
        connections: node.getConnections().length,
    })
})
node.addEventListener("peer:disconnect", (evt) => {
    slog(`peer disconnected: ${evt.detail.toString()}`)
    send({
        type: "peer",
        event: "disconnect",
        peerId: evt.detail.toString(),
        connections: node.getConnections().length,
    })
})
pubsub.addEventListener("message", (evt) => {
    send({
        type: "message",
        topic: evt.detail.topic,
        from: evt.detail.from?.toString?.() ?? "",
        data: Buffer.from(evt.detail.data).toString("base64"),
    })
})

async function handleCommand(cmd) {
    switch (cmd.type) {
        case "hello": {
            if (cmd.v !== PROTOCOL_VERSION) {
                slog(`protocol version mismatch: client v${cmd.v}, ours v${PROTOCOL_VERSION}`)
                process.exit(1)
            }
            send({ type: "hello" })
            send({
                type: "ready",
                peerId: node.peerId.toString(),
                addrs: node.getMultiaddrs().map((a) => a.toString()),
            })
            send({ type: "stats", ...statsPayload() })
            break
        }
        case "publish": {
            try {
                await pubsub.publish(cmd.topic, Buffer.from(cmd.data, "base64"))
                send({ type: "publish_result", topic: cmd.topic, ok: true })
            } catch (e) {
                slog(`publish to ${cmd.topic} failed: ${e.message}`)
                send({
                    type: "publish_result",
                    topic: cmd.topic,
                    ok: false,
                    error: e.message,
                })
            }
            break
        }
        case "dial": {
            for (const addr of cmd.addrs ?? []) {
                const idIdx = addr.lastIndexOf("/p2p/")
                const targetId = idIdx === -1 ? null : addr.slice(idIdx + 5)
                if (
                    targetId &&
                    node
                        .getConnections()
                        .some((c) => c.remotePeer.toString() === targetId)
                ) {
                    slog(`already connected to ${targetId}, skipping dial`)
                    continue
                }
                slog(`dialing ${addr}`)
                node.dial(multiaddr(addr))
                    .then(() => slog(`dial succeeded: ${addr}`))
                    .catch((e) => slog(`dial ${addr} failed: ${e.message}`))
            }
            break
        }
        case "stats": {
            send({ type: "stats", ...statsPayload() })
            break
        }
        default:
            slog(`unknown command type: ${cmd.type}`)
    }
}

try {
    fs.unlinkSync(IPC_PATH)
} catch {
    /* no stale socket */
}

const server = net.createServer((socket) => {
    if (client && !client.destroyed) {
        slog("second IPC client rejected")
        socket.destroy()
        return
    }
    slog("IPC client connected")
    client = socket
    if (clientGoneTimer) clearTimeout(clientGoneTimer)
    const rl = readline.createInterface({ input: socket })
    rl.on("line", (line) => {
        let cmd
        try {
            cmd = JSON.parse(line)
        } catch {
            slog(`unparseable IPC line (${line.length} bytes)`)
            return
        }
        handleCommand(cmd).catch((e) => slog(`command ${cmd.type} threw: ${e.message}`))
    })
    socket.on("close", () => {
        slog("IPC client disconnected")
        client = null
        clientGoneTimer = setTimeout(() => {
            slog(`no IPC client for ${CLIENT_GONE_EXIT_MS}ms; exiting`)
            process.exit(0)
        }, CLIENT_GONE_EXIT_MS)
    })
    socket.on("error", () => socket.destroy())
})

server.listen(IPC_PATH, () => {
    fs.chmodSync(IPC_PATH, 0o600)
    slog(`IPC listening on ${IPC_PATH}`)
})

setInterval(() => send({ type: "stats", ...statsPayload() }), STATS_INTERVAL_MS)

// Orphan prevention: die with the parent.
process.stdin.resume()
process.stdin.on("end", () => {
    slog("stdin closed; exiting")
    process.exit(0)
})
process.stdin.on("close", () => process.exit(0))

process.on("SIGTERM", async () => {
    await node.stop().catch(() => {})
    process.exit(0)
})

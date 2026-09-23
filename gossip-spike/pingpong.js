import os from 'node:os'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { mplex } from '@libp2p/mplex'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { multiaddr } from '@multiformats/multiaddr'

const PORT = process.env.PORT ?? '9095'
const PEER = process.env.PEER ?? ''
const NAME = process.env.NAME ?? os.hostname()
const PAYLOAD_BYTES = parseInt(process.env.PAYLOAD_BYTES ?? '0', 10)
const TOPIC = 'spike/pingpong/1'
const PING_INTERVAL_MS = 2000

const enc = new TextEncoder()
const dec = new TextDecoder()
const log = (...args) => console.log(new Date().toISOString(), ...args)

const TRANSPORT = process.env.TRANSPORT ?? 'tcp'
const MUXER = process.env.MUXER ?? 'yamux'

const node = await createLibp2p({
    addresses: {
        listen: [
            TRANSPORT === 'ws'
                ? `/ip4/0.0.0.0/tcp/${PORT}/ws`
                : `/ip4/0.0.0.0/tcp/${PORT}`,
        ],
    },
    transports: [TRANSPORT === 'ws' ? webSockets() : tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [MUXER === 'mplex' ? mplex() : yamux()],
    services: {
        identify: identify(),
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true })
    }
})

const pubsub = node.services.pubsub

log(`[${NAME}] peerId: ${node.peerId.toString()}`)
log(`[${NAME}] listening on:`)
for (const addr of node.getMultiaddrs()) {
    log(`    ${addr.toString()}`)
}
log(`[${NAME}] on the OTHER server, run:`)
log(`    PEER=/ip4/<THIS_SERVER_PUBLIC_IP>/tcp/${PORT}/p2p/${node.peerId.toString()} bun run pingpong.js`)

node.addEventListener('peer:connect', evt => {
    log(`[${NAME}] connected to ${evt.detail.toString()}`)
})
node.addEventListener('peer:disconnect', evt => {
    log(`[${NAME}] disconnected from ${evt.detail.toString()}`)
})

const inflight = new Map()
pubsub.addEventListener('message', evt => {
    if (evt.detail.topic !== TOPIC) return
    let msg
    try {
        msg = JSON.parse(dec.decode(evt.detail.data))
    } catch {
        log(`[${NAME}] undecodable message, ignoring`)
        return
    }
    if (msg.type === 'ping' && msg.from !== NAME) {
        log(`[${NAME}] PING #${msg.n} from ${msg.from} -> sending PONG`)
        publish({ type: 'pong', from: NAME, to: msg.from, n: msg.n, ts: msg.ts })
    } else if (msg.type === 'pong' && msg.to === NAME) {
        const sent = inflight.get(msg.n)
        inflight.delete(msg.n)
        const rtt = sent ? `${Date.now() - sent}ms` : 'unknown (restarted?)'
        log(`[${NAME}] PONG #${msg.n} from ${msg.from} -- round trip ${rtt}`)
    }
})

async function publish(obj) {
    try {
        await pubsub.publish(TOPIC, enc.encode(JSON.stringify(obj)))
    } catch (err) {
        log(`[${NAME}] publish failed: ${err.message}`)
    }
}

pubsub.subscribe(TOPIC)
log(`[${NAME}] subscribed to '${TOPIC}'`)

if (PEER !== '') {
    const target = multiaddr(PEER)
    const dialLoop = async () => {
        for (;;) {
            try {
                await node.dial(target)
                log(`[${NAME}] dialed ${PEER}`)
                return
            } catch (err) {
                log(`[${NAME}] dial failed (${err.message}), retrying in 3s`)
                await new Promise(r => setTimeout(r, 3000))
            }
        }
    }
    dialLoop()
}

let n = 0
setInterval(() => {
    const subs = pubsub.getSubscribers(TOPIC).length
    if (subs === 0) {
        log(`[${NAME}] waiting for a topic peer (connections: ${node.getConnections().length})`)
        return
    }
    n += 1
    inflight.set(n, Date.now())
    log(`[${NAME}] sending PING #${n} (topic peers: ${subs}, payload ${PAYLOAD_BYTES}B)`)
    publish({
        type: 'ping',
        from: NAME,
        n,
        ts: Date.now(),
        pad: PAYLOAD_BYTES > 0 ? 'x'.repeat(PAYLOAD_BYTES) : undefined,
    })
}, PING_INTERVAL_MS)

process.on('SIGINT', async () => {
    log(`[${NAME}] stopping...`)
    await node.stop()
    log(`[${NAME}] stopped cleanly`)
    process.exit(0)
})

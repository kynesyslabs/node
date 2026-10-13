/**
 * DACS RFQ over L2PS messaging, against a running node, with the published
 * SDK: real ChannelSession envelopes, the real L2PSChannelTransport and
 * L2PSMessagingPeer on the wire.
 *
 * Covers what a multi-seller RFQ needs from the node:
 *   1. one RFQ fanned out to three sellers under one messageHash
 *   2. a seller's quote back to the buyer
 *   3. a resend after a lost acknowledgement is answered, not delivered twice
 *   4. a resend to an offline seller stays one queued message
 *   5. a captured register proof cannot be replayed; a stale one is refused;
 *      a proof naming a subnet works there only
 *   6. one key on two subnets at once, routed separately
 *   7. the buyer reads its history back and decrypts it with the subnet key
 *   8. getTxByHash answers an unknown hash as not found, with a height
 *
 * Env: NODE_RPC (http), MESSAGING_WS (ws), SUBNET_A, SUBNET_B, and
 * SUBNET_KEY_DIR holding <uid>/private_key.txt and <uid>/iv.txt (the node's
 * data/l2ps); history is served as ciphertext and decrypted here.
 * Run: bun testing/l2ps-messaging/rfq-e2e.ts  (or testing/l2ps-messaging/e2e.sh)
 */

import { Demos } from "@kynesyslabs/demosdk/websdk"
import { L2PSMessagingPeer } from "@kynesyslabs/demosdk/instant-messaging"
import { l2ps } from "@kynesyslabs/demosdk"
import { createCipheriv, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const channel = l2ps.channel

const NODE_RPC = process.env.NODE_RPC ?? "http://localhost:54550"
const MESSAGING_WS = process.env.MESSAGING_WS ?? "ws://localhost:54600"
const SUBNET_A = process.env.SUBNET_A ?? "rfq_e2e_a"
const SUBNET_B = process.env.SUBNET_B ?? "rfq_e2e_b"
const SUBNET_KEY_DIR = process.env.SUBNET_KEY_DIR ?? "data/l2ps"

// ─── Reporting ───────────────────────────────────────────────────

let failures = 0
let passes = 0

function check(name: string, ok: boolean, detail?: unknown): void {
    if (ok) {
        passes++
        console.log(`  ok   ${name}`)
    } else {
        failures++
        // One line per finding: nothing the node sent can break the log's structure.
        const shown = detail === undefined ? "" : ` — ${JSON.stringify(detail).replace(/[\r\n]+/g, " ")}`
        console.log(`  FAIL ${name}${shown}`)
    }
}

function step(title: string): void {
    console.log(`\n▸ ${title}`)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function until(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (cond()) return true
        await sleep(50)
    }
    return cond()
}

// ─── Participants ────────────────────────────────────────────────

interface Party {
    name: string
    demos: Demos
    publicKey: string
    claim: `demos:${string}`
    sign: (message: string | Uint8Array) => Promise<string>
}

async function party(name: string): Promise<Party> {
    const demos = new Demos()
    await demos.connectWallet(demos.newMnemonic())
    const address = (await demos.getEd25519Address()).replace(/^0x/, "").toLowerCase()
    const sign = async (message: string | Uint8Array) => {
        const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message
        const signed = await demos.crypto.sign("ed25519", bytes)
        return Buffer.from(signed.signature as Uint8Array).toString("hex")
    }
    return { name, demos, publicKey: address, claim: `demos:0x${address}`, sign }
}

function messagingPeer(p: Party, l2psUid: string): L2PSMessagingPeer {
    return new L2PSMessagingPeer({ serverUrl: MESSAGING_WS, publicKey: p.publicKey, l2psUid, signFn: p.sign })
}

/** Counts every frame a peer delivers, below the transport's own dedup. */
function countFrames(peer: L2PSMessagingPeer): { hashes: string[] } {
    const seen = { hashes: [] as string[] }
    peer.onMessage(m => seen.hashes.push(m.messageHash))
    return seen
}

async function rpc(message: string, data: Record<string, unknown>): Promise<any> {
    const res = await fetch(NODE_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data }] }),
    })
    return res.json()
}

function rawRegister(frame: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(MESSAGING_WS)
        const timer = setTimeout(() => reject(new Error("register timeout")), 5000)
        ws.addEventListener("open", () => ws.send(JSON.stringify(frame)))
        ws.addEventListener("message", e => {
            clearTimeout(timer)
            resolve({ reply: JSON.parse(e.data as string), ws })
        })
        ws.addEventListener("error", reject)
    })
}

// ─── Scenario ────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(`node ${NODE_RPC}  messaging ${MESSAGING_WS}  subnets ${SUBNET_A}, ${SUBNET_B}`)

    const buyer = await party("buyer")
    const sellers = await Promise.all(["seller-1", "seller-2", "seller-3"].map(party))
    const members = [buyer, ...sellers]
    const channelId = `rfq-e2e-${Date.now()}`
    // The channel transport encrypts under the subnet key; here that is a
    // fresh test key, held by the members only.
    const sharedKey = randomBytes(32)

    const peers = new Map<string, L2PSMessagingPeer>()
    const frames = new Map<string, { hashes: string[] }>()
    const received = new Map<string, any[]>()
    const transports = new Map<string, InstanceType<typeof channel.L2PSChannelTransport>>()

    step("1. register buyer and three sellers, open the channel")
    for (const p of members) {
        const peer = messagingPeer(p, SUBNET_A)
        frames.set(p.name, countFrames(peer))
        const reg = await peer.connect()
        check(`${p.name} registered on ${SUBNET_A}`, reg.success === true, reg)
        peers.set(p.name, peer)

        const session = new channel.ChannelSession({
            channelId,
            members: members.map(m => m.claim),
            me: p.claim,
            demos: p.demos,
        })
        await session.open()
        received.set(p.name, [])
        const transport = new channel.L2PSChannelTransport({
            session,
            peer,
            sharedKey,
            recipients: members.filter(m => m !== p).map(m => m.publicKey),
            onMessage: msg => received.get(p.name)!.push(msg),
            onError: err => console.log(`    (${p.name} transport) ${err.message}`),
        })
        transport.start()
        transports.set(p.name, transport)
    }

    step("2. buyer fans one RFQ out to every seller under one messageHash")
    const rfq = await transports.get("buyer")!.send({ type: "offer", body: { item: "1000 GPU-hours", maxPrice: "500 DEM" } })
    for (const s of sellers) {
        const got = await until(() => received.get(s.name)!.length >= 1)
        check(`${s.name} received the RFQ`, got && received.get(s.name)![0]?.sequence === rfq.sequence)
    }

    step("3. a seller quotes back")
    await transports.get("seller-2")!.send({ type: "counter", body: { price: "420 DEM" }, repliesTo: rfq.sequence })
    check("buyer received the quote", await until(() => received.get("buyer")!.length >= 1))
    check("other sellers see the quote on the channel", await until(() =>
        received.get("seller-1")!.length >= 2 && received.get("seller-3")!.length >= 2))

    step("4. resend after a lost acknowledgement")
    const s1 = sellers[0]
    const before = frames.get(s1.name)!.hashes.length
    // A frame for another channel: the transports drop it silently, so only
    // the node's delivery is being counted.
    const encrypted = encryptLike(sharedKey, JSON.stringify({ channelId: "probe-other-channel" }))
    const first = await peers.get("buyer")!.send(s1.publicKey, encrypted, "e2e-resend-hash")
    const again = await peers.get("buyer")!.send(s1.publicKey, encrypted, "e2e-resend-hash")
    check("first send accepted", (first as any).duplicate === undefined, first)
    check("resend answered as a duplicate of the accepted send", (again as any).duplicate === true, again)
    await sleep(300)
    check("seller received the frame exactly once", frames.get(s1.name)!.hashes.length - before === 1, frames.get(s1.name)!.hashes)

    step("5. resend to an offline seller stays one queued message")
    const offline = await party("offline-seller")
    const q1 = await peers.get("buyer")!.send(offline.publicKey, encrypted, "e2e-offline-hash")
    const q2 = await peers.get("buyer")!.send(offline.publicKey, encrypted, "e2e-offline-hash")
    check("queued", (q1 as any).status === "queued", q1)
    check("resend answered as queued duplicate", (q2 as any).status === "queued" && (q2 as any).duplicate === true, q2)
    const offlinePeer = messagingPeer(offline, SUBNET_A)
    const offlineFrames = countFrames(offlinePeer)
    await offlinePeer.connect()
    await until(() => offlineFrames.hashes.length >= 1)
    await sleep(300)
    check("offline seller gets it exactly once on connect", offlineFrames.hashes.filter(h => h === "e2e-offline-hash").length === 1, offlineFrames.hashes)
    offlinePeer.disconnect()

    step("6. register proofs")
    const intruder = await party("intruder")
    const ts = Date.now()
    const proof = await intruder.sign(`register:${intruder.publicKey}:${ts}`)
    const frame = { type: "register", payload: { publicKey: intruder.publicKey, l2psUid: SUBNET_A, proof }, timestamp: ts }
    const firstUse = await rawRegister(frame)
    check("fresh proof registers", firstUse.reply.type === "registered", firstUse.reply)
    const replay = await rawRegister(frame)
    check("replayed proof is refused", replay.reply.type === "error" && /already used/.test(replay.reply.payload.message), replay.reply)
    const staleTs = Date.now() - 5 * 60_000
    const stale = await rawRegister({
        type: "register",
        payload: { publicKey: intruder.publicKey, l2psUid: SUBNET_A, proof: await intruder.sign(`register:${intruder.publicKey}:${staleTs}`) },
        timestamp: staleTs,
    })
    check("stale proof is refused", stale.reply.type === "error" && stale.reply.payload.code === "INVALID_PROOF", stale.reply)
    const boundTs = Date.now()
    const boundProof = await intruder.sign(`register:${SUBNET_B}:${intruder.publicKey}:${boundTs}`)
    const bound = await rawRegister({ type: "register", payload: { publicKey: intruder.publicKey, l2psUid: SUBNET_B, proof: boundProof }, timestamp: boundTs })
    check("proof naming the subnet registers there", bound.reply.type === "registered", bound.reply)
    const misbound = await rawRegister({ type: "register", payload: { publicKey: intruder.publicKey, l2psUid: SUBNET_A, proof: boundProof }, timestamp: boundTs })
    check("the same proof is refused on another subnet", misbound.reply.type === "error" && misbound.reply.payload.code === "INVALID_PROOF", misbound.reply)
    for (const r of [firstUse, replay, stale, bound, misbound]) r.ws.close()

    step("7. one key on two subnets")
    const s3 = sellers[2]
    const onB = messagingPeer(s3, SUBNET_B)
    const framesB = countFrames(onB)
    const regB = await onB.connect()
    check(`${s3.name} also registered on ${SUBNET_B}`, regB.success === true, regB)
    const s3BeforeA = frames.get(s3.name)!.hashes.length
    await peers.get("buyer")!.send(s3.publicKey, encrypted, "e2e-subnet-a-only")
    check(`message on ${SUBNET_A} still reaches the ${SUBNET_A} connection`, await until(() => frames.get(s3.name)!.hashes.length > s3BeforeA))
    await sleep(300)
    check(`nothing leaks to the ${SUBNET_B} connection`, framesB.hashes.length === 0, framesB.hashes)
    onB.disconnect()

    step("8. buyer reads its history back and decrypts it with the subnet key")
    const historyTs = String(Date.now())
    const historySig = await buyer.sign(`getL2PSHistory:${SUBNET_A}:${buyer.publicKey}:${historyTs}`)
    const history = await rpc("getL2PSAccountTransactions", {
        l2psUid: SUBNET_A, address: buyer.publicKey, signature: historySig, timestamp: historyTs, limit: 50,
    })
    const rows = history?.response?.transactions ?? []
    check("history authenticated and returned rows", history?.result === 200 && rows.length > 0, history)
    // The node hands back the stored ciphertext, never a plaintext a reader
    // would have to take on trust; a member decrypts with the key it holds.
    check("every row carries its ciphertext", rows.length > 0 && rows.every((r: any) => r.encrypted_payload?.content), rows.slice(0, 2))
    const subnet = await subnetInstance(SUBNET_A)
    const decrypted: any[] = []
    for (const r of rows) {
        try {
            decrypted.push(await subnet.decryptTx(r.encrypted_payload))
        } catch (e) {
            console.log(`    (decrypt ${String(r.hash).slice(0, 12)}) ${(e as Error).message}`)
        }
    }
    const messages = decrypted.filter(tx => tx?.content?.data?.[0] === "instantMessaging")
    check("rows decrypt locally to instantMessaging transactions", messages.length === rows.length, { rows: rows.length, decrypted: messages.length })
    const rfqHash = rfq.signature.signature
    check("the RFQ fan-out is in history once per seller",
        messages.filter(tx => tx.content.data[1].messageHash === rfqHash).length === sellers.length,
        messages.map(tx => tx.content.data[1].messageHash))

    step("9. getTxByHash: unknown hash")
    const missing = await rpc("getTxByHash", { hash: "0x" + "ab".repeat(32) })
    check("404 not_found with the height searched", missing.result === 404 && missing.extra?.reason === "not_found" &&
        typeof missing.extra?.checkedThroughBlock === "number", missing)

    for (const peer of peers.values()) peer.disconnect()

    console.log(`\n${passes} passed, ${failures} failed`)
    process.exit(failures === 0 ? 0 : 1)
}

/** The subnet as a member holds it: the AES key and IV the node was given. */
async function subnetInstance(uid: string) {
    // The SDK takes forge byte strings, the same conversion the node applies to its key files.
    const bytes = (file: string) => Buffer.from(readFileSync(join(SUBNET_KEY_DIR, uid, file), "utf8").trim(), "hex").toString("latin1")
    const instance = await l2ps.L2PS.create(bytes("private_key.txt"), bytes("iv.txt"))
    instance.setConfig({ uid, config: { created_at_block: 0, known_rpcs: [] } })
    return instance
}

/** Same wire shape the channel transport produces (AES-256-GCM, base64). */
function encryptLike(key: Buffer, text: string): { ciphertext: string; nonce: string } {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, nonce)
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()])
    return { ciphertext: body.toString("base64"), nonce: nonce.toString("base64") }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})

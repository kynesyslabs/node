#!/usr/bin/env bun
/**
 * L2PS Messaging E2E Test
 *
 * Connects two peers to the L2PS messaging server, exchanges messages,
 * and verifies delivery. Requires a running node with L2PS_MESSAGING_ENABLED=true.
 *
 * Usage:
 *   bun scripts/l2ps-messaging-test.ts [--port 3006] [--l2ps-uid testnet_l2ps_001]
 */

import { parseArgs } from "node:util"
import * as forge from "node-forge"

// ─── CLI Args ────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        port: { type: "string", default: "3006" },
        "l2ps-uid": { type: "string", default: "testnet_l2ps_001" },
        host: { type: "string", default: "localhost" },
    },
})

const PORT = args.port ?? "3006"
const HOST = args.host ?? "localhost"
const L2PS_UID = args["l2ps-uid"] ?? "testnet_l2ps_001"
const WS_URL = `ws://${HOST}:${PORT}`

// ─── Helpers ─────────────────────────────────────────────────────

function generateEd25519KeyPair() {
    const seed = forge.random.getBytesSync(32)
    const keyPair = forge.pki.ed25519.generateKeyPair({ seed })
    return {
        publicKey: Buffer.from(keyPair.publicKey).toString("hex"),
        privateKey: keyPair.privateKey,
        publicKeyBytes: keyPair.publicKey,
    }
}

function signMessage(message: string, privateKey: any): string {
    // Sign using forge ed25519 — message as UTF-8 string (matches SDK's Cryptography.verify)
    const sig = forge.pki.ed25519.sign({
        message,
        encoding: "utf8",
        privateKey,
    })
    return Buffer.from(sig).toString("hex")
}

function frame(type: string, payload: Record<string, unknown>, ts?: number) {
    return JSON.stringify({ type, payload, timestamp: ts ?? Date.now() })
}

function connectWS(name: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL)
        const timeout = setTimeout(() => reject(new Error(`${name}: Connection timeout`)), 5000)
        ws.addEventListener("open", () => {
            clearTimeout(timeout)
            log(name, "Connected")
            resolve(ws)
        })
        ws.addEventListener("error", () => {
            clearTimeout(timeout)
            reject(new Error(`${name}: Connection failed`))
        })
    })
}

function waitFor(ws: WebSocket, type: string, timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${type}'`)), timeout)
        const handler = (event: MessageEvent) => {
            const msg = JSON.parse(event.data)
            if (msg.type === type) {
                clearTimeout(timer)
                ws.removeEventListener("message", handler)
                resolve(msg)
            }
        }
        ws.addEventListener("message", handler)
    })
}

function waitForAny(ws: WebSocket, types: string[], timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${types.join("|")}'`)), timeout)
        const handler = (event: MessageEvent) => {
            const msg = JSON.parse(event.data)
            if (types.includes(msg.type)) {
                clearTimeout(timer)
                ws.removeEventListener("message", handler)
                resolve(msg)
            }
        }
        ws.addEventListener("message", handler)
    })
}

function log(tag: string, msg: string) {
    console.log(`  [${tag}] ${msg}`)
}

// ─── Main Test ───────────────────────────────────────────────────

async function main() {
    console.log(`\n  L2PS Messaging E2E Test`)
    console.log(`  Server: ${WS_URL}`)
    console.log(`  L2PS UID: ${L2PS_UID}\n`)

    // Generate two key pairs
    const alice = generateEd25519KeyPair()
    const bob = generateEd25519KeyPair()
    log("SETUP", `Alice: ${alice.publicKey.slice(0, 16)}...`)
    log("SETUP", `Bob:   ${bob.publicKey.slice(0, 16)}...`)

    // ── Step 1: Connect ──────────────────────────────────────────
    console.log("\n  [1/5] Connecting...")
    let wsAlice: WebSocket
    let wsBob: WebSocket
    try {
        wsAlice = await connectWS("Alice")
        wsBob = await connectWS("Bob")
    } catch (e: any) {
        console.error(`\n  FAIL: ${e.message}`)
        console.error(`  Make sure the node is running with L2PS_MESSAGING_ENABLED=true`)
        process.exit(1)
    }

    // ── Step 2: Register ─────────────────────────────────────────
    console.log("\n  [2/5] Registering peers...")

    // Alice registration — timestamp must match between proof and frame.
    // Register the response listener BEFORE `send()`; otherwise a fast
    // server reply can land before we attach the handler, and the test
    // hangs until the waitFor timeout fires instead of seeing the
    // response immediately.
    const aliceTs = Date.now()
    const aliceProof = signMessage(`register:${alice.publicKey}:${aliceTs}`, alice.privateKey)
    const aliceRegPromise = waitForAny(wsAlice, ["registered", "error"])
    wsAlice.send(frame("register", {
        publicKey: alice.publicKey,
        l2psUid: L2PS_UID,
        proof: aliceProof,
    }, aliceTs))

    const aliceReg = await aliceRegPromise
    if (!aliceReg || aliceReg.type === "error") {
        console.error(`\n  FAIL: Alice registration failed`)
        if (aliceReg) console.error(`  Error: ${aliceReg.payload.code} - ${aliceReg.payload.message}`)
        wsAlice.close(); wsBob.close()
        process.exit(1)
    }
    log("Alice", `Registered. Online peers: ${aliceReg.payload.onlinePeers.length}`)

    // Bob registration — same listener-before-send rule.
    const bobTs = Date.now()
    const bobProof = signMessage(`register:${bob.publicKey}:${bobTs}`, bob.privateKey)
    const bobJoinedPromise = waitFor(wsAlice, "peer_joined")
    const bobRegPromise = waitForAny(wsBob, ["registered", "error"])
    wsBob.send(frame("register", {
        publicKey: bob.publicKey,
        l2psUid: L2PS_UID,
        proof: bobProof,
    }, bobTs))

    const bobReg = await bobRegPromise
    if (!bobReg || bobReg.type === "error") {
        console.error(`\n  FAIL: Bob registration failed`)
        if (bobReg) console.error(`  Error: ${bobReg.payload.code} - ${bobReg.payload.message}`)
        wsAlice.close(); wsBob.close()
        process.exit(1)
    }
    log("Bob", `Registered. Online peers: ${bobReg.payload.onlinePeers.length}`)

    const joined = await bobJoinedPromise
    log("Alice", `Received peer_joined notification for Bob`)

    // ── Step 3: Discover ─────────────────────────────────────────
    console.log("\n  [3/5] Discovering peers...")
    const discoverPromise = waitFor(wsAlice, "discover_response")
    wsAlice.send(frame("discover", {}))
    const discoverResp = await discoverPromise
    log("Alice", `Online peers: [${discoverResp.payload.peers.map((p: string) => p.slice(0, 12) + "...").join(", ")}]`)

    // ── Step 4: Send messages ────────────────────────────────────
    console.log("\n  [4/5] Exchanging messages...")

    // Alice -> Bob
    const msgPromiseBob = waitFor(wsBob, "message")
    wsAlice.send(frame("send", {
        to: bob.publicKey,
        encrypted: {
            ciphertext: Buffer.from("Hello Bob from Alice!").toString("base64"),
            nonce: Buffer.from("test_nonce_1").toString("base64"),
        },
        messageHash: "hash_alice_to_bob_" + Date.now(),
    }))

    const msgBob = await msgPromiseBob
    log("Bob", `Received message from ${msgBob.payload.from.slice(0, 12)}...`)
    log("Bob", `Decoded: ${Buffer.from(msgBob.payload.encrypted.ciphertext, "base64").toString()}`)

    const ackAlice = await waitForAny(wsAlice, ["message_sent", "message_queued", "error"])
    log("Alice", `Ack: type=${ackAlice.type}`)

    // Bob -> Alice
    const msgPromiseAlice = waitFor(wsAlice, "message")
    wsBob.send(frame("send", {
        to: alice.publicKey,
        encrypted: {
            ciphertext: Buffer.from("Hey Alice, got your message!").toString("base64"),
            nonce: Buffer.from("test_nonce_2").toString("base64"),
        },
        messageHash: "hash_bob_to_alice_" + Date.now(),
    }))

    const msgAlice = await msgPromiseAlice
    log("Alice", `Received message from ${msgAlice.payload.from.slice(0, 12)}...`)
    log("Alice", `Decoded: ${Buffer.from(msgAlice.payload.encrypted.ciphertext, "base64").toString()}`)

    const ackBob = await waitForAny(wsBob, ["message_sent", "message_queued", "error"])
    log("Bob", `Ack: type=${ackBob.type}`)

    // ── Step 5: Disconnect ───────────────────────────────────────
    console.log("\n  [5/5] Testing disconnect...")
    const leftPromise = waitFor(wsAlice, "peer_left")
    wsBob.close()
    const left = await leftPromise
    log("Alice", `Received peer_left for ${left.payload.publicKey.slice(0, 12)}...`)
    wsAlice.close()

    // ── Results ──────────────────────────────────────────────────
    console.log("\n  ══════════════════════════════════════════")
    console.log("  All E2E tests passed!")
    console.log("  ══════════════════════════════════════════")
    console.log(`
  Summary:
    - WebSocket connection:     OK
    - Peer registration:        OK (with ed25519 proof)
    - Peer discovery:           OK
    - Message delivery:         OK (Alice -> Bob, Bob -> Alice)
    - L2PS submission:          ${ackAlice.type === "message_sent" ? "OK" : "WARN: " + ackAlice.type}
    - Peer notifications:       OK (join + leave)
    - Disconnect handling:      OK
`)

    process.exit(0)
}

main().catch((err) => {
    console.error(`\n  FAIL: ${err.message}`)
    process.exit(1)
})

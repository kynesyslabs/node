import { afterEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../..")
const [realEncryption, realUtils] = await Promise.all([
    import("@kynesyslabs/demosdk/encryption"),
    import("@kynesyslabs/demosdk/utils"),
])

// Exercise the real listener without loading a chain or writing transactions.
for (const path of [
    "@/libs/blockchain/transaction",
    "@/libs/blockchain/chain",
    "@/libs/blockchain/mempool",
    "@/libs/crypto/hashing",
    "@/model/datasource",
    "@/libs/blockchain/validation/txValidatorPool",
]) {
    mock.module(path, () => ({ default: {} }))
}
mock.module("@/utilities/logger", () => ({
    default: { debug() {}, info() {}, warning() {}, error() {} },
}))
mock.module("@/utilities/sharedState", () => ({ getSharedState: () => ({}) }))
mock.module("@/model/entities/OfflineMessages", () => ({ OfflineMessage: class {} }))
mock.module("@/errors", () => ({ handleError() {} }))
mock.module("@/forks", () => ({
    serializeTransactionContent() {},
    txSignaturePreimageForPendingBlock() {},
}))
mock.module("@kynesyslabs/demosdk/encryption", () => ({
    ...realEncryption,
    signedObject: class {},
    ucrypto: {},
    Cryptography: {},
    uint8ArrayToHex() {},
}))
mock.module("@kynesyslabs/demosdk/utils", () => ({
    ...realUtils,
    deserializeUint8Array() {},
}))

const { SignalingServer } = await import("./signalingServer")
const DISCOVER = JSON.stringify({ type: "discover", payload: {} })
const PAYLOAD_LIMIT = 1024 * 1024
let signaling: InstanceType<typeof SignalingServer> | undefined

function start() {
    signaling = new SignalingServer(0)
    return signaling
}

afterEach(() => {
    // Force-close even unregistered test sockets.
    ;(signaling as any)?.server.stop(true)
    signaling = undefined
    mock.restore()
})

async function connect(host = "127.0.0.1") {
    const port = (signaling as any).server.port
    const address = host.includes(":") ? `[${host}]` : host
    const ws = new WebSocket(`ws://${address}:${port}`)
    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error("WebSocket failed to open"))
    })
    return ws
}

function nextMessage(ws: WebSocket) {
    return new Promise<string>(resolve => {
        ws.onmessage = event => resolve(String(event.data))
    })
}

function closed(ws: WebSocket) {
    return new Promise<CloseEvent>(resolve => {
        ws.onclose = resolve
    })
}

function replies(ws: WebSocket, expected: number) {
    return new Promise<void>((resolve, reject) => {
        let received = 0
        const timeout = setTimeout(() => reject(new Error(`Only ${received} replies`)), 3000)
        ws.onmessage = () => {
            if (++received === expected) {
                clearTimeout(timeout)
                resolve()
            }
        }
        ws.onclose = () => {
            clearTimeout(timeout)
            reject(new Error(`Socket closed after ${received} replies`))
        }
    })
}

describe("signaling listener limits", () => {
    it("keeps the listener reachable and accepts a discovery payload at the cap", async () => {
        start()
        const ws = await connect()
        const reply = nextMessage(ws)
        // Trailing JSON whitespace keeps the discovery request valid at 1 MiB.
        ws.send(DISCOVER + " ".repeat(PAYLOAD_LIMIT - DISCOVER.length))
        expect(JSON.parse(await reply)).toEqual({
            type: "discover", payload: { peers: [] },
        })
    })

    it("accepts IPv6 loopback connections", async () => {
        start()
        const ws = await connect("::1")
        const reply = nextMessage(ws)
        ws.send(DISCOVER)
        expect(JSON.parse(await reply).type).toBe("discover")
    })

    it.each(["text", "binary", "multibyte"])(
        "closes an oversized %s payload before application handlers run",
        async kind => {
            const server = start()
            let dispatched = 0
            ;(server as any).addResponseHandler(() => { dispatched++ })
            const ws = await connect()
            const close = closed(ws)
            const oversized = kind === "binary"
                ? new Uint8Array(PAYLOAD_LIMIT + 1)
                : kind === "multibyte"
                  ? "é".repeat(PAYLOAD_LIMIT / 2 + 1)
                  : "x".repeat(PAYLOAD_LIMIT + 1)
            ws.send(oversized)
            expect((await close).code).toBe(1009)
            expect(dispatched).toBe(0)
        },
    )

    it("accepts 31 two-frame operations on one connection", async () => {
        start()
        const ws = await connect()
        const received = replies(ws, 62)
        for (let i = 0; i < 31; i++) {
            ws.send(DISCOVER)
            ws.send(DISCOVER)
        }
        await received
        expect(ws.readyState).toBe(WebSocket.OPEN)
    })

    it("keeps two unpaced load sockets open past 60 frames each", async () => {
        start()
        const first = await connect()
        const second = await connect()
        const received = Promise.all([replies(first, 80), replies(second, 80)])
        for (let i = 0; i < 80; i++) {
            first.send(DISCOVER)
            second.send(DISCOVER)
        }
        await received
        expect(first.readyState).toBe(WebSocket.OPEN)
        expect(second.readyState).toBe(WebSocket.OPEN)
    })
})

describe("signaling deployment defaults", () => {
    it("requires a host bind opt-in and preserves custom ports and Caddy access", () => {
        const compose = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8")
        expect(compose).toContain(
            '"${RPC_SIGNALING_BIND:-127.0.0.1}:${RPC_SIGNALING_PORT:-3005}:${RPC_SIGNALING_PORT:-3005}"',
        )
        expect(compose).not.toContain(
            '"${RPC_SIGNALING_PORT:-3005}:${RPC_SIGNALING_PORT:-3005}"',
        )
        expect(compose).toContain("RPC_SIGNALING_PORT: ${RPC_SIGNALING_PORT:-3005}")
        const caddy = readFileSync(join(REPO_ROOT, "monitoring/caddy/Caddyfile"), "utf8")
        expect(caddy).toContain("handle_path /signaling/*")
        expect(caddy).toContain("reverse_proxy node:{$RPC_SIGNALING_PORT:3005}")
    })
})

describe("shared-process SDK imports", () => {
    it("keeps unrelated SDK exports available to other test files", async () => {
        const encryption = await import("@kynesyslabs/demosdk/encryption")
        const utils = await import("@kynesyslabs/demosdk/utils")
        expect(typeof encryption.Hashing).toBe("function")
        expect(typeof utils.validateEd25519Address).toBe("function")
    })
})

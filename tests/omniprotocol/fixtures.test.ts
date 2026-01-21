import { describe, expect, it } from "@jest/globals"
import { readFileSync } from "fs"
import path from "path"

const fixturesDir = path.resolve(__dirname, "../../fixtures")

function loadFixture<T>(name: string): T {
    const filePath = path.join(fixturesDir, `${name}.json`)
    const raw = readFileSync(filePath, "utf8")
    return JSON.parse(raw) as T
}

describe("Captured HTTP fixtures", () => {
    it("peerlist snapshot matches expected shape", () => {
        type PeerEntry = {
            connection: { string: string }
            identity: string
            sync: { status: boolean; block: number; block_hash: string }
            status: { online: boolean; ready: boolean }
        }

        const payload = loadFixture<{
            result: number
            response: PeerEntry[]
        }>("peerlist")

        expect(payload.result).toBe(200)
        expect(Array.isArray(payload.response)).toBe(true)
        expect(payload.response.length).toBeGreaterThan(0)
        for (const peer of payload.response) {
            expect(typeof peer.identity).toBe("string")
            expect(peer.connection?.string).toMatch(/^https?:\/\//)
            expect(typeof peer.sync.block).toBe("number")
        }
    })

    it("peerlist hash is hex", () => {
        const payload = loadFixture<{ result: number; response: string }>(
            "peerlist_hash",
        )

        expect(payload.result).toBe(200)
        expect(payload.response).toMatch(/^[0-9a-f]{64}$/)
    })

    it("mempool fixture returns JSON structure", () => {
        const payload = loadFixture<{ result: number; response: unknown }>(
            "mempool",
        )

        expect(payload.result).toBe(200)
        expect(payload.response).not.toBeUndefined()
    })

    it("block header fixture contains block number", () => {
        const payload = loadFixture<{
            result: number
            response: { number: number; hash: string }
        }>("block_header")

        expect(payload.result).toBe(200)
        expect(typeof payload.response.number).toBe("number")
        expect(payload.response.hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it("address info fixture reports expected structure", () => {
        const payload = loadFixture<{
            result: number
            response: { identity?: string; address?: string }
        }>("address_info")

        expect(payload.result).toBe(200)
        expect(typeof payload.response).toBe("object")
    })
})

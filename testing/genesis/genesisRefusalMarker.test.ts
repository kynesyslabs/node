import { describe, it, expect } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    clearRefusalMarker,
    pendingRefusal,
    writeRefusalMarker,
} from "src/libs/peer/routines/genesisRefusalMarker"

const BAD = "aa".repeat(32)
const PEER = "bb".repeat(32)
const GOOD = "cc".repeat(32)

const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "marker-"))
    return { dir, path: join(dir, "genesis.bootstrap-refused.json") }
}

describe("the bootstrap refusal marker", () => {
    it("is written with the message, both hashes and a timestamp", () => {
        const { dir, path } = setup()
        writeRefusalMarker(path, { message: "edited genesis", storedHash: BAD, peerHash: PEER })
        const marker = JSON.parse(readFileSync(path, "utf8"))
        expect(marker).toMatchObject({ message: "edited genesis", storedHash: BAD, peerHash: PEER })
        expect(Number.isNaN(Date.parse(marker.at))).toBe(false)
        rmSync(dir, { recursive: true })
    })

    it("re-raises on the next boot while the same block 0 is stored", () => {
        const { dir, path } = setup()
        writeRefusalMarker(path, { message: "edited genesis", storedHash: BAD, peerHash: PEER })
        const text = pendingRefusal(path, BAD)
        expect(text).toContain("edited genesis")
        expect(text).toContain(BAD)
        expect(text).toContain(PEER)
        expect(text).toContain(path)
        expect(existsSync(path)).toBe(true)
        rmSync(dir, { recursive: true })
    })

    it("is removed, and raises nothing, once the stored block 0 is another one", () => {
        const { dir, path } = setup()
        writeRefusalMarker(path, { message: "edited genesis", storedHash: BAD, peerHash: PEER })
        expect(pendingRefusal(path, GOOD)).toBeNull()
        expect(existsSync(path)).toBe(false)
        rmSync(dir, { recursive: true })
    })

    it("is cleared explicitly after a clean boot, and clearing nothing is harmless", () => {
        const { dir, path } = setup()
        expect(clearRefusalMarker(path)).toBe(false)
        writeRefusalMarker(path, { message: "m", storedHash: BAD, peerHash: PEER })
        expect(clearRefusalMarker(path)).toBe(true)
        expect(pendingRefusal(path, BAD)).toBeNull()
        rmSync(dir, { recursive: true })
    })

    it("treats an unreadable marker as still in force", () => {
        const { dir, path } = setup()
        writeFileSync(path, "{ not json")
        expect(pendingRefusal(path, BAD)).toContain("cannot be read")
        expect(existsSync(path)).toBe(true)
        rmSync(dir, { recursive: true })
    })

    it("raises nothing when there is no marker", () => {
        const { dir, path } = setup()
        expect(pendingRefusal(path, null)).toBeNull()
        rmSync(dir, { recursive: true })
    })
})

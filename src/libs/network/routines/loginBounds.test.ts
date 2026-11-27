import { describe, expect, it, setSystemTime } from "bun:test"

import { MAX_WEB_BUFFER_BYTES, normalizeWebBuffers } from "./normalizeWebBuffers"
import Sessions, { maxAddressLength, maxSessions } from "./sessionManager"

describe("normalizeWebBuffers", () => {
    it("accepts a byte array and a serialized Buffer", () => {
        expect(normalizeWebBuffers([1, 2, 3])[0]).toEqual(Buffer.from([1, 2, 3]))
        expect(normalizeWebBuffers('{"type":"Buffer","data":[1,2,3]}')[0]).toEqual(Buffer.from([1, 2, 3]))
    })

    it("refuses a length with no bytes behind it", () => {
        expect(normalizeWebBuffers({ length: 300000000 })[0]).toBeNull()
        expect(normalizeWebBuffers({ type: "Buffer", length: 300000000 })[0]).toBeNull()
    })

    it("refuses more bytes than the limit", () => {
        expect(normalizeWebBuffers(new Array(MAX_WEB_BUFFER_BYTES + 1).fill(0))[0]).toBeNull()
    })
})

describe("Sessions", () => {
    it("refuses an oversized address", () => {
        expect(new Sessions().newSession("k".repeat(maxAddressLength + 1))).toBeNull()
    })

    it("holds at most maxSessions and frees expired ones", () => {
        const sessions = new Sessions()
        for (let i = 0; i < maxSessions; i++) sessions.newSession("k" + i)
        expect(sessions.newSession("extra")).toBeNull()
        expect(sessions.newSession("k0")).not.toBeNull()

        setSystemTime(new Date(Date.now() + 6 * 60 * 1000))
        expect(sessions.newSession("extra")).not.toBeNull()
        expect(sessions.registry.size).toBe(1)
        setSystemTime()
    })
})

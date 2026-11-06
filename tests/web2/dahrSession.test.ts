/**
 * A DAHR session id is the only thing that names a caller's session, so it
 * must not be guessable, and an idle session must stop working soon instead
 * of living for a day.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

delete process.env.WEB2_SESSION_TTL_MS

mock.module("@/utilities/sharedState", () => ({
    __esModule: true,
    default: { getInstance: () => ({ PROD: false }) },
}))
const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
}
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const { DAHR } = await import("@/features/web2/dahr/DAHR")
const { DAHRFactory } = await import("@/features/web2/dahr/DAHRFactory")

const web2Request = { raw: { url: "https://example.com/", headers: {} } } as any

afterEach(() => {
    jest.restoreAllMocks()
})

describe("DAHR session id", () => {
    it("does not follow from the clock and Math.random", () => {
        spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
        spyOn(Math, "random").mockReturnValue(0.5)
        const a = new DAHR(web2Request).sessionId
        const b = new DAHR(web2Request).sessionId
        expect(a).not.toBe(b)
        expect(a).toMatch(/^[0-9a-f]{64}$/)
    })
})

describe("DAHR session lifetime", () => {
    it("is gone after 15 idle minutes, and kept alive by use", async () => {
        let now = 1_700_000_000_000
        spyOn(Date, "now").mockImplementation(() => now)
        const factory = DAHRFactory.instance
        const { sessionId } = await factory.createDAHR(web2Request)

        now += 14 * 60 * 1000
        expect(factory.getDAHR(sessionId)).toBeDefined()

        now += 14 * 60 * 1000
        expect(factory.getDAHR(sessionId)).toBeDefined()

        now += 15 * 60 * 1000 + 1
        expect(factory.getDAHR(sessionId)).toBeUndefined()
    })
})

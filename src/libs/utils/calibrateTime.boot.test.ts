import { beforeEach, describe, expect, it, mock } from "bun:test"

// Answers handed out in order, one per NTP request, whatever the server.
let answers: Array<Date | Error> = []
mock.module("ntp-client", () => ({
    getNetworkTime: (_server: string, _port: number, cb: (err: unknown, date?: Date) => void) => {
        const next = answers.shift() ?? new Error("no answer")
        if (next instanceof Error) cb(next)
        else cb(null, next)
    },
}))

const { getBootTimestampCorrection } = await import("./calibrateTime")
const { getSharedState } = await import("src/utilities/sharedState")

const at = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000)
// What ntp-client returns for a server that answers with a zero timestamp
const EPOCH_1900 = new Date(-2208988800 * 1000)

describe("getBootTimestampCorrection", () => {
    beforeEach(() => {
        answers = []
        getSharedState.timestampCorrection = 0
    })

    it("takes the correction when two readings agree", async () => {
        answers = [at(100), at(101)]
        const correction = await getBootTimestampCorrection()
        expect(Math.abs(correction - 101)).toBeLessThanOrEqual(1)
        expect(getSharedState.timestampCorrection).toBe(correction)
    })

    it("skips a 1900 answer and asks the next server", async () => {
        answers = [EPOCH_1900, at(0), at(0)]
        const correction = await getBootTimestampCorrection()
        expect(Math.abs(correction)).toBeLessThanOrEqual(1)
    })

    it("retries when the two readings disagree", async () => {
        answers = [at(0), at(86_400), at(5), at(6)]
        const correction = await getBootTimestampCorrection()
        expect(Math.abs(correction - 6)).toBeLessThanOrEqual(1)
    })

    it("refuses to start when no two readings ever agree", async () => {
        answers = Array.from({ length: 10 }, (_, i) => at(i % 2 === 0 ? 0 : 86_400))
        await expect(getBootTimestampCorrection()).rejects.toThrow(/trusted clock/)
    })

    it("refuses to start when every server answers 1900", async () => {
        answers = Array.from({ length: 40 }, () => EPOCH_1900)
        await expect(getBootTimestampCorrection()).rejects.toThrow(/trusted clock/)
    })
})

import { beforeEach, describe, expect, it, mock } from "bun:test"

// What ntp-client hands back for the next request, whatever the server.
let ntpAnswer: () => { err: unknown; date?: Date } = () => ({ err: new Error("no answer") })
mock.module("ntp-client", () => ({
    getNetworkTime: (_server: string, _port: number, cb: (err: unknown, date?: Date) => void) => {
        const { err, date } = ntpAnswer()
        cb(err, date)
    },
}))

const gauges = new Map<string, number>()
mock.module("src/features/metrics/MetricsService", () => ({
    getMetricsService: () => ({
        createGauge: () => undefined,
        setGauge: (name: string, value: number) => gauges.set(name, value),
    }),
}))

const {
    NTP_PROBE_SERVERS,
    checkClockAtBoot,
    probeClockOffset,
    queryNtpOffset,
} = await import("./clockProbe")

// Each server answers with its offset in ms, or fails when it maps to an Error.
const answers = (byServer: Record<string, number | Error>) => async (server: string) => {
    const answer = byServer[server] ?? new Error(`${server} unreachable`)
    if (answer instanceof Error) throw answer
    return answer
}
const [S1, S2, S3, S4] = NTP_PROBE_SERVERS
const TOLERANCE_S = 60

describe("probeClockOffset", () => {
    it("takes the median of the servers that agree", async () => {
        const result = await probeClockOffset(answers({ [S1]: 100, [S2]: 300, [S3]: 200 }))
        expect(result).toEqual({ offsetMs: 200, agreeing: 3, answered: 3 })
    })

    it("leaves out a server far from the others", async () => {
        const result = await probeClockOffset(answers({ [S1]: 100, [S2]: 86_400_000, [S3]: 300 }))
        expect(result.offsetMs).toBe(200)
        expect(result.agreeing).toBe(2)
        expect(result.answered).toBe(3)
    })

    it("has no reading from a single answer", async () => {
        const result = await probeClockOffset(answers({ [S1]: 120_000 }))
        expect(result).toEqual({ offsetMs: null, agreeing: 1, answered: 1 })
    })

    it("has no reading when no server answers", async () => {
        const result = await probeClockOffset(answers({}))
        expect(result).toEqual({ offsetMs: null, agreeing: 0, answered: 0 })
    })

    it("has no reading when two pairs of servers disagree", async () => {
        const result = await probeClockOffset(
            answers({ [S1]: 0, [S2]: 500, [S3]: 86_400_000, [S4]: 86_400_500 }),
        )
        expect(result.offsetMs).toBeNull()
    })

    it("needs the agreeing answers within the span of each other, not of the median", async () => {
        const result = await probeClockOffset(answers({ [S1]: 59_000, [S2]: 62_900 }))
        expect(result.offsetMs).toBeNull()
    })

    it("has no reading when the answers chain apart in equal windows", async () => {
        const result = await probeClockOffset(answers({ [S1]: 0, [S2]: 1_500, [S3]: 3_000 }))
        expect(result.offsetMs).toBeNull()
    })

    it("survives a query that throws before returning a promise", async () => {
        const result = await probeClockOffset(server => {
            if (server === S1) throw new Error("boom")
            return Promise.resolve(50)
        })
        expect(result.offsetMs).toBe(50)
        expect(result.answered).toBe(3)
    })
})

describe("checkClockAtBoot", () => {
    beforeEach(() => gauges.clear())

    it("refuses a production start when two servers agree the host is past the tolerance", async () => {
        const query = answers({ [S1]: 61_000, [S2]: 61_500 })
        await expect(
            checkClockAtBoot({ production: true, toleranceSeconds: TOLERANCE_S, query }),
        ).rejects.toThrow(/61\.3s ahead of NTP.*Fix the host's NTP/)
    })

    it("refuses a host that is behind as well", async () => {
        const query = answers({ [S1]: -90_000, [S2]: -90_000, [S3]: -90_000 })
        await expect(
            checkClockAtBoot({ production: true, toleranceSeconds: TOLERANCE_S, query }),
        ).rejects.toThrow(/90\.0s behind NTP/)
    })

    it("starts outside production whatever the offset", async () => {
        const query = answers({ [S1]: 61_000, [S2]: 61_500 })
        const result = await checkClockAtBoot({ production: false, toleranceSeconds: TOLERANCE_S, query })
        expect(result.offsetMs).toBe(61_250)
    })

    it("starts within the tolerance and publishes the offset", async () => {
        const query = answers({ [S1]: 1500, [S2]: 2500 })
        const result = await checkClockAtBoot({ production: true, toleranceSeconds: TOLERANCE_S, query })
        expect(result.offsetMs).toBe(2000)
        expect(gauges.get("clock_offset_seconds")).toBe(2)
        expect(gauges.get("clock_probe_agreeing_servers")).toBe(2)
    })

    it("starts when no NTP server answers", async () => {
        const result = await checkClockAtBoot({ production: true, toleranceSeconds: TOLERANCE_S, query: answers({}) })
        expect(result.offsetMs).toBeNull()
        expect(gauges.get("clock_probe_agreeing_servers")).toBe(0)
        expect(gauges.has("clock_offset_seconds")).toBe(false)
    })

    it("starts when only one server reports a large offset", async () => {
        const query = answers({ [S1]: 3_600_000 })
        const result = await checkClockAtBoot({ production: true, toleranceSeconds: TOLERANCE_S, query })
        expect(result.offsetMs).toBeNull()
    })

    it("starts when the servers disagree", async () => {
        const query = answers({ [S1]: 0, [S2]: 3_600_000 })
        const result = await checkClockAtBoot({ production: true, toleranceSeconds: TOLERANCE_S, query })
        expect(result.offsetMs).toBeNull()
    })
})

describe("queryNtpOffset", () => {
    it("reports a host clock ahead of the server as positive", async () => {
        ntpAnswer = () => ({ err: null, date: new Date(Date.now() - 10_000) })
        const offset = await queryNtpOffset(S1)
        expect(offset).toBeGreaterThan(9_000)
        expect(offset).toBeLessThan(11_000)
    })

    it("rejects the 1900 answer of an unsynchronised server", async () => {
        ntpAnswer = () => ({ err: null, date: new Date(-2208988800 * 1000) })
        await expect(queryNtpOffset(S1)).rejects.toThrow(/implausible time/)
    })

    it("passes a transport error on", async () => {
        ntpAnswer = () => ({ err: "Timeout waiting for NTP response." })
        await expect(queryNtpOffset(S1)).rejects.toThrow(/Timeout/)
    })
})

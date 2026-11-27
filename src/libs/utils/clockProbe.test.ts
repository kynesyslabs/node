import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import dgram from "node:dgram"

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
            checkClockAtBoot({ production: true, query }),
        ).rejects.toThrow(/61\.3s ahead of NTP.*Fix the host's NTP/)
    })

    it("refuses a host further ahead than members sign a block timestamp", async () => {
        // Inside the 60 s sync tolerance, but every block it stamped as
        // secretary would be refused.
        const query = answers({ [S1]: 10_000, [S2]: 10_000 })
        await expect(checkClockAtBoot({ production: true, query })).rejects.toThrow(
            /10\.0s ahead of NTP.*more than the 5s members accept/,
        )
    })

    it("refuses a host just past the signing limit and starts one just inside it", async () => {
        await expect(
            checkClockAtBoot({ production: true, query: answers({ [S1]: -5_500, [S2]: -5_500 }) }),
        ).rejects.toThrow(/5\.5s behind NTP/)
        const inside = await checkClockAtBoot({
            production: true,
            query: answers({ [S1]: 4_500, [S2]: 4_500 }),
        })
        expect(inside.offsetMs).toBe(4_500)
    })

    it("refuses a host that is behind as well", async () => {
        const query = answers({ [S1]: -90_000, [S2]: -90_000, [S3]: -90_000 })
        await expect(
            checkClockAtBoot({ production: true, query }),
        ).rejects.toThrow(/90\.0s behind NTP/)
    })

    it("starts outside production whatever the offset", async () => {
        const query = answers({ [S1]: 61_000, [S2]: 61_500 })
        const result = await checkClockAtBoot({ production: false, query })
        expect(result.offsetMs).toBe(61_250)
    })

    it("starts within the tolerance and publishes the offset", async () => {
        const query = answers({ [S1]: 1500, [S2]: 2500 })
        const result = await checkClockAtBoot({ production: true, query })
        expect(result.offsetMs).toBe(2000)
        expect(gauges.get("clock_offset_seconds")).toBe(2)
        expect(gauges.get("clock_probe_agreeing_servers")).toBe(2)
    })

    it("starts when no NTP server answers", async () => {
        const result = await checkClockAtBoot({ production: true, query: answers({}) })
        expect(result.offsetMs).toBeNull()
        expect(gauges.get("clock_probe_agreeing_servers")).toBe(0)
        expect(gauges.has("clock_offset_seconds")).toBe(false)
    })

    it("starts when only one server reports a large offset", async () => {
        const query = answers({ [S1]: 3_600_000 })
        const result = await checkClockAtBoot({ production: true, query })
        expect(result.offsetMs).toBeNull()
    })

    it("starts when the servers disagree", async () => {
        const query = answers({ [S1]: 0, [S2]: 3_600_000 })
        const result = await checkClockAtBoot({ production: true, query })
        expect(result.offsetMs).toBeNull()
    })
})

// A local SNTP server: `reply` builds the answer to each request, or null to stay silent.
async function ntpServer(
    reply: () => Buffer | null,
    delayMs = 0,
): Promise<{ port: number; close: () => void }> {
    const socket = dgram.createSocket("udp4")
    socket.on("message", (_request, from) => {
        const answer = reply()
        if (!answer) return
        setTimeout(() => socket.send(answer, from.port, from.address), delayMs)
    })
    await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve))
    return { port: socket.address().port, close: () => socket.close() }
}

// A server-mode reply whose transmit timestamp is `unixMs`.
function serverReply(unixMs: number): Buffer {
    const reply = Buffer.alloc(48)
    reply[0] = 0x1c // LI 0, version 3, mode 4 (server)
    reply[1] = 2 // stratum
    const seconds = Math.floor(unixMs / 1000) + 2_208_988_800
    reply.writeUInt32BE(seconds >>> 0, 40)
    reply.writeUInt32BE(Math.floor(((unixMs % 1000) / 1000) * 2 ** 32), 44)
    return reply
}

describe("queryNtpOffset", () => {
    let server: { port: number; close: () => void } | null = null
    afterEach(() => {
        server?.close()
        server = null
    })

    it("reports a host clock ahead of the server as positive", async () => {
        server = await ntpServer(() => serverReply(Date.now() - 10_000))
        const offset = await queryNtpOffset("127.0.0.1", server.port, 1000)
        expect(offset).toBeGreaterThan(9_000)
        expect(offset).toBeLessThan(11_000)
    })

    it("rejects the zero timestamp of an unsynchronised server", async () => {
        server = await ntpServer(() => {
            const reply = Buffer.alloc(48)
            reply[0] = 0x1c
            reply[1] = 2
            return reply
        })
        await expect(queryNtpOffset("127.0.0.1", server.port, 1000)).rejects.toThrow(/implausible time/)
    })

    it("rejects a kiss-of-death reply and an unsynchronised leap indicator", async () => {
        server = await ntpServer(() => {
            const reply = serverReply(Date.now())
            reply[1] = 0
            return reply
        })
        await expect(queryNtpOffset("127.0.0.1", server.port, 1000)).rejects.toThrow(/implausible time/)
        server.close()
        server = await ntpServer(() => {
            const reply = serverReply(Date.now())
            reply[0] = 0xdc // LI 3, version 3, mode 4
            return reply
        })
        await expect(queryNtpOffset("127.0.0.1", server.port, 1000)).rejects.toThrow(/implausible time/)
    })

    it("rejects a reply too short to hold a timestamp", async () => {
        server = await ntpServer(() => Buffer.alloc(12, 0x1c))
        await expect(queryNtpOffset("127.0.0.1", server.port, 1000)).rejects.toThrow(/implausible time/)
    })

    it("gives up on a silent server", async () => {
        server = await ntpServer(() => null)
        await expect(queryNtpOffset("127.0.0.1", server.port, 100)).rejects.toThrow(/did not answer within 100 ms/)
    })

    it("lets a lookup that fails after the timeout pass without an uncaught error", async () => {
        // The crash seen on validators: the old client closed its socket on
        // timeout, then closed it again when the late DNS failure reached send.
        const uncaught: unknown[] = []
        const onUncaught = (error: unknown) => uncaught.push(error)
        process.on("uncaughtException", onUncaught)
        try {
            await expect(queryNtpOffset("no-such-host.invalid", 123, 1)).rejects.toThrow(/did not answer/)
            await new Promise(resolve => setTimeout(resolve, 1500))
            expect(uncaught).toEqual([])
        } finally {
            process.off("uncaughtException", onUncaught)
        }
    })

    it("lets a reply that comes after the timeout pass without an uncaught error", async () => {
        const uncaught: unknown[] = []
        const onUncaught = (error: unknown) => uncaught.push(error)
        process.on("uncaughtException", onUncaught)
        try {
            server = await ntpServer(() => serverReply(Date.now()), 250)
            await expect(queryNtpOffset("127.0.0.1", server.port, 50)).rejects.toThrow(/did not answer/)
            await new Promise(resolve => setTimeout(resolve, 400))
            expect(uncaught).toEqual([])
        } finally {
            process.off("uncaughtException", onUncaught)
        }
    })
})

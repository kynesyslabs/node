import dgram from "node:dgram"
import log from "src/utilities/logger"
import { getMetricsService } from "src/features/metrics/MetricsService"
import { COSIGN_TIMESTAMP_MAX_LEAD_SECONDS } from "src/libs/consensus/v2/routines/cosignTimestamp"

/**
 * Measures how far the host clock is from public NTP and reports it. It never
 * changes the node's clock (see getNetworkTimestamp): a time source the node
 * corrected itself from could move every validator that trusted it at once.
 */

export const NTP_PROBE_SERVERS = [
    "pool.ntp.org",
    "time.google.com",
    "time.windows.com",
    "time.apple.com",
]
// One unauthenticated answer proves nothing, so a reading needs at least two
// servers whose answers all lie within this span of each other.
export const MAX_SERVER_SPREAD_MS = 2000
export const MIN_AGREEING_SERVERS = 2
// Members refuse to sign a block stamped more than
// COSIGN_TIMESTAMP_MAX_LEAD_SECONDS ahead of their own clock, so an offset
// past 1 s is worth fixing before it costs blocks.
export const CLOCK_OFFSET_WARN_MS = 1000
// Servers are asked in parallel, so this is also the most a probe delays boot.
const QUERY_TIMEOUT_MS = 3000
const PROBE_INTERVAL_MS = 10 * 60 * 1000
// A server that is not synchronised answers with a zero timestamp, which
// reads as 1900. No real reading is older than 2024-01-01.
const MIN_PLAUSIBLE_TIME_MS = 1_704_067_200_000

/** Resolves to how far the host clock is ahead of `server`, in ms. */
export type NtpOffsetQuery = (server: string) => Promise<number>

export interface ClockProbeResult {
    /** Host clock minus the agreeing servers' median, in ms; null without agreement. */
    offsetMs: number | null
    agreeing: number
    answered: number
}

// Seconds between the NTP epoch (1900) and the Unix epoch (1970).
const NTP_UNIX_EPOCH_DELTA_S = 2_208_988_800
const NTP_PACKET_BYTES = 48
// LI 0, version 3, mode 3 (client).
const NTP_CLIENT_HEADER = 0x1b
const NTP_MODE_SERVER = 4

/** The server's transmit time from an SNTP reply, in Unix ms; null if the reply is malformed. */
export function readNtpTransmitTime(reply: Buffer): number | null {
    if (reply.length < NTP_PACKET_BYTES || (reply[0] & 0x07) !== NTP_MODE_SERVER) {
        return null
    }
    // Leap indicator 3 is an unsynchronised server; stratum 0 is a
    // kiss-of-death refusal. Neither carries a time to compare against.
    if (reply[0] >> 6 === 3 || reply[1] === 0) {
        return null
    }
    const seconds = reply.readUInt32BE(40)
    const fraction = reply.readUInt32BE(44)
    return (seconds - NTP_UNIX_EPOCH_DELTA_S) * 1000 + (fraction * 1000) / 2 ** 32
}

/**
 * One SNTP request on a socket this function owns end to end. The ntp-client
 * package closed its socket from both its own timeout and the reply handler,
 * so a reply arriving after the timeout threw "Not running" from a socket
 * callback, and under Bun that took the whole node down.
 */
export function queryNtpOffset(
    server: string,
    port = 123,
    timeoutMs = QUERY_TIMEOUT_MS,
): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4")
        let sentAt = Date.now()
        let settled = false
        const settle = (error: Error | null, offsetMs = 0) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            socket.removeAllListeners("message")
            try {
                socket.close()
            } catch {
                // already closed: nothing left to release
            }
            if (error) reject(error)
            else resolve(offsetMs)
        }
        const timer = setTimeout(
            () => settle(new Error(`${server} did not answer within ${timeoutMs} ms`)),
            timeoutMs,
        )
        // Stays attached after settle so a late socket error is never unhandled.
        socket.on("error", error => settle(error))
        socket.once("message", reply => {
            const receivedAt = Date.now()
            const serverMs = readNtpTransmitTime(reply)
            if (serverMs === null || !Number.isFinite(serverMs) || serverMs < MIN_PLAUSIBLE_TIME_MS) {
                settle(new Error(`${server} answered an implausible time`))
                return
            }
            settle(null, (sentAt + receivedAt) / 2 - serverMs)
        })
        const request = Buffer.alloc(NTP_PACKET_BYTES)
        request[0] = NTP_CLIENT_HEADER
        try {
            socket.send(request, 0, request.length, port, server, error => {
                if (error) settle(error)
                else sentAt = Date.now()
            })
        } catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)))
        }
    })
}

function median(values: number[]): number {
    if (values.length === 0) return NaN
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The most answers that fit in one MAX_SERVER_SPREAD_MS window. Measuring
 * each answer against the overall median would let two answers almost twice
 * the span apart both pass. Two different windows of the same size leave no
 * group the servers agree on.
 */
function largestAgreeingGroup(offsets: number[]): number[] {
    const sorted = [...offsets].sort((a, b) => a - b)
    let best: number[] = []
    let tied = false
    let low = 0
    for (let high = 0; high < sorted.length; high++) {
        while (sorted[high] - sorted[low] > MAX_SERVER_SPREAD_MS) low++
        const size = high - low + 1
        if (size > best.length) {
            best = sorted.slice(low, high + 1)
            tied = false
        } else if (size === best.length) {
            tied = true
        }
    }
    return tied ? [] : best
}

export async function probeClockOffset(
    query: NtpOffsetQuery = queryNtpOffset,
    servers: string[] = NTP_PROBE_SERVERS,
): Promise<ClockProbeResult> {
    const settled = await Promise.allSettled(servers.map(async server => query(server)))
    const offsets: number[] = []
    settled.forEach((answer, i) => {
        if (answer.status === "fulfilled" && Number.isFinite(answer.value)) {
            offsets.push(answer.value)
        } else {
            const why = answer.status === "rejected" ? answer.reason : answer.value
            log.debug(`[CLOCK] No offset from ${servers[i]}: ${why instanceof Error ? why.message : String(why)}`)
        }
    })
    const agreeing = largestAgreeingGroup(offsets)
    return {
        offsetMs: agreeing.length >= MIN_AGREEING_SERVERS ? median(agreeing) : null,
        agreeing: agreeing.length,
        answered: offsets.length,
    }
}

function describeOffset(offsetMs: number): string {
    const seconds = (Math.abs(offsetMs) / 1000).toFixed(1)
    return `${seconds}s ${offsetMs > 0 ? "ahead of" : "behind"} NTP`
}

function reportProbe(result: ClockProbeResult): void {
    if (result.offsetMs === null) {
        log.warning(
            `[CLOCK] Host clock offset not measured: ${result.answered} of ${NTP_PROBE_SERVERS.length} NTP servers answered, ` +
                `fewer than ${MIN_AGREEING_SERVERS} agree within ${MAX_SERVER_SPREAD_MS} ms. The node keeps using the host clock.`,
        )
    } else if (Math.abs(result.offsetMs) > CLOCK_OFFSET_WARN_MS) {
        log.warning(
            `[CLOCK] The host clock is ${describeOffset(result.offsetMs)} (${result.agreeing} servers agree): ` +
                `check the host's NTP service; members refuse blocks stamped more than ${COSIGN_TIMESTAMP_MAX_LEAD_SECONDS}s ahead of their clock`,
        )
    } else {
        log.info(
            `[CLOCK] Host clock offset ${Math.round(result.offsetMs)} ms (${result.agreeing} NTP servers agree)`,
        )
    }
    try {
        const m = getMetricsService()
        m.createGauge(
            "clock_offset_seconds",
            "Host clock minus the median of agreeing NTP servers, in seconds; positive means the host is ahead",
            [],
        )
        m.createGauge(
            "clock_probe_agreeing_servers",
            "NTP servers that agreed in the last clock probe; below 2 the offset was not updated",
            [],
        )
        m.setGauge("clock_probe_agreeing_servers", result.agreeing)
        if (result.offsetMs !== null) {
            m.setGauge("clock_offset_seconds", result.offsetMs / 1000)
        }
    } catch {
        // metrics must never stop the node
    }
}

export async function runClockProbe(
    query: NtpOffsetQuery = queryNtpOffset,
): Promise<ClockProbeResult> {
    const result = await probeClockOffset(query)
    reportProbe(result)
    return result
}

/**
 * A production node whose host clock is further off than members accept a
 * block timestamp refuses to start instead of joining with it. Ahead, every
 * block it stamps as secretary is refused and the round stalls; behind, it
 * refuses every honest block as too far ahead, or stamps one no later than
 * its parent. No answer, or servers that disagree, never stop the node: the
 * host clock stays the authority.
 */
export async function checkClockAtBoot(options: {
    production: boolean
    query?: NtpOffsetQuery
}): Promise<ClockProbeResult> {
    const result = await runClockProbe(options.query)
    const limitSeconds = COSIGN_TIMESTAMP_MAX_LEAD_SECONDS
    if (
        result.offsetMs !== null &&
        Math.abs(result.offsetMs) > limitSeconds * 1000
    ) {
        const message =
            `[CLOCK] The host clock is ${describeOffset(result.offsetMs)} (${result.agreeing} servers agree), ` +
            `more than the ${limitSeconds}s members accept between a block timestamp and their clock, so this node would stall rounds. ` +
            "Fix the host's NTP (chrony or systemd-timesyncd) and start again."
        if (options.production) {
            throw new Error(message)
        }
        log.error(`${message} Starting anyway because PROD is not set.`)
    }
    return result
}

let probeTimer: NodeJS.Timeout | null = null

export function startClockProbe(query: NtpOffsetQuery = queryNtpOffset): void {
    if (probeTimer) {
        return
    }
    probeTimer = setInterval(() => {
        runClockProbe(query).catch(error =>
            log.warning(
                `[CLOCK] Clock probe failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
        )
    }, PROBE_INTERVAL_MS)
    probeTimer.unref()
}

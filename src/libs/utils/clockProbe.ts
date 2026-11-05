import * as ntpClient from "ntp-client"
import log from "src/utilities/logger"
import { getMetricsService } from "src/features/metrics/MetricsService"

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
// servers within this distance of the median of every answer.
export const MAX_SERVER_SPREAD_MS = 2000
export const MIN_AGREEING_SERVERS = 2
// Members refuse to sign a block stamped more than 5 s ahead of their own
// clock, so an offset past 1 s is worth fixing before it costs blocks.
export const CLOCK_OFFSET_WARN_MS = 1000
// Servers are asked in parallel, so this is also the most a probe delays boot.
const QUERY_TIMEOUT_MS = 3000
const PROBE_INTERVAL_MS = 10 * 60 * 1000
// A server that is not synchronised answers with a zero timestamp, which
// ntp-client turns into 1900. No real reading is older than 2024-01-01.
const MIN_PLAUSIBLE_TIME_MS = 1_704_067_200_000

/** Resolves to how far the host clock is ahead of `server`, in ms. */
export type NtpOffsetQuery = (server: string) => Promise<number>

export interface ClockProbeResult {
    /** Host clock minus the agreeing servers' median, in ms; null without agreement. */
    offsetMs: number | null
    agreeing: number
    answered: number
}

export function queryNtpOffset(server: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const sentAt = Date.now()
        const timer = setTimeout(
            () => reject(new Error(`${server} did not answer within ${QUERY_TIMEOUT_MS} ms`)),
            QUERY_TIMEOUT_MS,
        )
        ntpClient.getNetworkTime(server, 123, (err, date) => {
            clearTimeout(timer)
            const receivedAt = Date.now()
            if (err) {
                reject(err instanceof Error ? err : new Error(String(err)))
                return
            }
            const serverMs = date?.getTime()
            if (!Number.isFinite(serverMs) || serverMs < MIN_PLAUSIBLE_TIME_MS) {
                reject(new Error(`${server} answered an implausible time (${String(date)})`))
                return
            }
            resolve((sentAt + receivedAt) / 2 - serverMs)
        })
    })
}

function median(values: number[]): number {
    if (values.length === 0) return NaN
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
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
    const centre = median(offsets)
    const agreeing = offsets.filter(o => Math.abs(o - centre) <= MAX_SERVER_SPREAD_MS)
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
                "check the host's NTP service; members refuse blocks stamped more than 5s ahead of their clock",
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
 * A host this far off has its blocks rejected by every peer, so a production
 * node refuses to start instead of joining with it. No answer, or servers
 * that disagree, never stop the node: the host clock stays the authority.
 */
export async function checkClockAtBoot(options: {
    production: boolean
    toleranceSeconds: number
    query?: NtpOffsetQuery
}): Promise<ClockProbeResult> {
    const result = await runClockProbe(options.query)
    if (
        result.offsetMs !== null &&
        Math.abs(result.offsetMs) > options.toleranceSeconds * 1000
    ) {
        const message =
            `[CLOCK] The host clock is ${describeOffset(result.offsetMs)} (${result.agreeing} servers agree), ` +
            `more than the ${options.toleranceSeconds}s block timestamp tolerance, so peers would reject this node's blocks. ` +
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

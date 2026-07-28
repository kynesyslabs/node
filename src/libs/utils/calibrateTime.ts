import * as ntpClient from "ntp-client"
import sharedState, { getSharedState } from "src/utilities/sharedState"
import log from "@/utilities/logger"

const primaryNtpServer = "pool.ntp.org"
const fallbackNtpServers = [
    "time.google.com",
    "time.windows.com",
    "time.apple.com",
]

const RECALIBRATION_INTERVAL_MS = 10 * 60 * 1000
const MAX_CORRECTION_STEP_S = 30
const MAX_CONSECUTIVE_REJECTIONS = 3

let recalibrationTimer: NodeJS.Timeout | null = null
let consecutiveRejections = 0
// A measurement walks the primary server plus up to three fallbacks with no
// per-request timeout, so a slow round can outlast the interval. Without this
// guard the next tick starts a second measurement and whichever resolves LAST
// wins — an older reading can clobber a newer correction.
let recalibrationInFlight = false

export default async function getTimestampCorrection(): Promise<number> {
    const timeDelta = await getMeasuredTimeDelta()
    getSharedState.timestampCorrection = timeDelta
    return timeDelta
}

export function startTimestampRecalibration(): void {
    if (recalibrationTimer) {
        return
    }
    recalibrationTimer = setInterval(async () => {
        if (recalibrationInFlight) {
            log.warning(
                "[calibrateTime] Previous NTP recalibration still in flight, skipping this round",
            )
            return
        }
        recalibrationInFlight = true
        try {
            const newDelta = await getMeasuredTimeDelta()
            const currentDelta = getSharedState.timestampCorrection
            const step = Math.abs(newDelta - currentDelta)

            if (
                step > MAX_CORRECTION_STEP_S &&
                consecutiveRejections < MAX_CONSECUTIVE_REJECTIONS
            ) {
                consecutiveRejections += 1
                log.warning(
                    `[calibrateTime] Rejecting implausible NTP correction step of ${step}s ` +
                        `(current: ${currentDelta}s, measured: ${newDelta}s, ` +
                        `rejection ${consecutiveRejections}/${MAX_CONSECUTIVE_REJECTIONS})`,
                )
                return
            }

            if (step > MAX_CORRECTION_STEP_S) {
                log.warning(
                    `[calibrateTime] Accepting large NTP correction step of ${step}s after ` +
                        `${consecutiveRejections} consecutive rejections (local clock likely stepped)`,
                )
            }
            consecutiveRejections = 0
            getSharedState.timestampCorrection = newDelta
        } catch (error) {
            log.warning(
                `[calibrateTime] Periodic NTP recalibration failed, keeping current correction: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
            )
        } finally {
            recalibrationInFlight = false
        }
    }, RECALIBRATION_INTERVAL_MS)
    recalibrationTimer.unref()
}

export function stopTimestampRecalibration(): void {
    if (recalibrationTimer) {
        clearInterval(recalibrationTimer)
        recalibrationTimer = null
    }
    consecutiveRejections = 0
    // Otherwise a stop during an in-flight measurement would leave the guard
    // latched and permanently skip every round after the next start.
    recalibrationInFlight = false
}

export function getNetworkTimestamp(): number {
    const correction = getSharedState.timestampCorrection
    const networkTimestamp = Math.floor(Date.now() / 1000) + correction
    getSharedState.currentUTCTime = networkTimestamp
    getSharedState.currentTimestamp = networkTimestamp
    return networkTimestamp
}

async function getMeasuredTimeDelta(): Promise<number> {
    const startTime = Date.now()
    const ntpTime = await getNtpTime()
    const endTime = Date.now()
    const roundTripTime = endTime - startTime
    log.debug("Round trip time:", roundTripTime)

    const halfTripTime = Math.floor(roundTripTime / 2)
    const halfTripTimeInSeconds = Math.floor(halfTripTime / 1000)
    log.debug(
        "Half trip time (ntp correction in seconds):",
        halfTripTimeInSeconds,
    )

    const ntpTimeConsideringRoundTripTime = ntpTime - halfTripTimeInSeconds
    const localTime = Math.floor(Date.now() / 1000)
    const timeDelta = ntpTimeConsideringRoundTripTime - localTime
    log.debug("NTP time:", ntpTimeConsideringRoundTripTime)
    log.debug("Local time:", localTime)
    log.debug("Time delta:", timeDelta)
    return timeDelta
}

async function getNtpTime(): Promise<number> {
    try {
        const time = await new Promise<Date>((resolve, reject) => {
            ntpClient.getNetworkTime(primaryNtpServer, 123, (err, date) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(date)
                }
            })
        })
        return Math.floor(time.getTime() / 1000)
    } catch (error) {
        log.warning(`Failed to fetch time from ${primaryNtpServer}:`, error)
        return getFallbackNtpTime()
    }
}

async function getFallbackNtpTime(): Promise<number> {
    for (const server of fallbackNtpServers) {
        try {
            const time = await new Promise<Date>((resolve, reject) => {
                ntpClient.getNetworkTime(server, 123, (err, date) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve(date)
                    }
                })
            })
            return Math.floor(time.getTime() / 1000)
        } catch (error) {
            log.warning(`Failed to fetch time from ${server}:`, error)
        }
    }

    throw new Error("Failed to fetch NTP time from all servers")
}

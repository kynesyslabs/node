import * as ntpClient from "ntp-client"
import sharedState, { getSharedState } from "src/utilities/sharedState"
import log from "@/utilities/logger"

const primaryNtpServer = "pool.ntp.org"
const fallbackNtpServers = [
    "time.google.com",
    "time.windows.com",
    "time.apple.com",
]

export default async function getTimestampCorrection(): Promise<number> {
    const timeDelta = await getMeasuredTimeDelta()
    getSharedState.timestampCorrection = timeDelta
    return timeDelta
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

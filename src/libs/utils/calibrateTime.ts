import { getSharedState } from "src/utilities/sharedState"

/**
 * The node's clock for consensus timestamps, block checks and round timing,
 * in whole seconds. It is the host clock as is: validators keep it right with
 * host NTP, and the node never corrects it itself, so these checks and the
 * peer auth windows (which read Date.now()) always share one clock, and no
 * time server can move it. clockProbe.ts only measures and reports the host's
 * offset.
 */
export function getNetworkTimestamp(): number {
    const now = Math.floor(Date.now() / 1000)
    getSharedState.currentUTCTime = now
    getSharedState.currentTimestamp = now
    return now
}

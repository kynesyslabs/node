/**
 * Re-checks the fork schedule against the connected peers while the node runs.
 *
 * A comparison at bootstrap only covers what the peers had loaded at that
 * moment, and a genesis edit that rolls out over hours changes the answer
 * afterwards. So it is repeated every SLOW_EVERY blocks, and every WINDOW_EVERY
 * blocks once the tip is within WINDOW_BLOCKS of the nearest scheduled height,
 * where a mismatch is about to become a split and is logged as an error.
 *
 * It only reports. Whether a persistent mismatch should stop the node is left
 * to the operator: stopping would also stop a node during a rolling genesis
 * edit, while not stopping lets a minority node split silently.
 */

import type { ForkConfigLike } from "./forkScheduleAgreement"

export const WINDOW_BLOCKS = 50
export const SLOW_EVERY = 100
export const WINDOW_EVERY = 10

export interface CheckPlan {
    due: boolean
    inWindow: boolean
    nearest: number | null
}

/** Whether to compare at this tip, and whether a mismatch is urgent. */
export function planScheduleCheck(
    tip: number,
    forkConfig: Record<string, { activationHeight: number | null } | undefined>,
): CheckPlan {
    let nearest: number | null = null
    for (const name of Object.keys(forkConfig)) {
        const h = forkConfig[name]?.activationHeight
        if (typeof h === "number" && h > tip && (nearest === null || h < nearest)) {
            nearest = h
        }
    }
    const inWindow = nearest !== null && nearest - tip <= WINDOW_BLOCKS
    const due = tip % SLOW_EVERY === 0 || (inWindow && tip % WINDOW_EVERY === 0)
    return { due, inWindow, nearest }
}

let running = false

/** Called after a block is inserted; never throws and never blocks the caller. */
export async function onBlockInserted(tip: number): Promise<void> {
    if (running) return
    running = true
    try {
        const { getSharedState } = await import("@/utilities/sharedState")
        const forkConfig = getSharedState.forkConfig as unknown as ForkConfigLike
        const plan = planScheduleCheck(tip, forkConfig)
        if (!plan.due) return
        const [{ default: PeerManager }, { default: log }, agreement] = await Promise.all([
            import("../PeerManager"),
            import("@/utilities/logger"),
            import("./forkScheduleAgreement"),
        ])
        const ours = agreement.localScheduleView(forkConfig, getSharedState.chainId)
        for (const peer of PeerManager.getInstance().getPeers()) {
            if (peer.identity === getSharedState.publicKeyHex) continue
            const result = await agreement.checkPeerSchedule(peer, ours, {
                attempts: 1,
            })
            if (result.status !== "mismatch") continue
            const text =
                "[FORK SCHEDULE] MISMATCH with " +
                peer.connection.string +
                " at block " +
                tip +
                (plan.nearest !== null
                    ? " (nearest scheduled height " + plan.nearest + ")"
                    : "") +
                ": " +
                result.lines.join("; ")
            if (plan.inWindow) log.error(text)
            else log.warn(text)
        }
    } catch {
        // A failed comparison must not affect block processing.
    } finally {
        running = false
    }
}

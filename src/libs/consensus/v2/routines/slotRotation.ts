import { getSharedState } from "src/utilities/sharedState"
import { getNetworkTimestamp } from "src/libs/utils/calibrateTime"

/**
 * Slot-based leader rotation. The previous block's timestamp (plus the
 * consensus interval) is the slot origin; every SLOT_DURATION seconds
 * the expected leader advances by one committee position. Purely a
 * function of on-chain data and the calibrated clock, so all synced
 * nodes converge on the same leader without negotiation.
 */
export function computeCurrentSlot(prevBlockTimestamp: number): number {
    const slotDuration = getSharedState.getSlotDuration()
    const origin = prevBlockTimestamp + getSharedState.getConsensusTime()
    const elapsed = getNetworkTimestamp() - origin

    if (elapsed <= 0 || slotDuration <= 0) {
        return 0
    }

    return Math.floor(elapsed / slotDuration)
}

export function pickSlotLeader<T>(committee: T[], slot: number): T | null {
    if (committee.length === 0) {
        return null
    }

    return committee[slot % committee.length]
}

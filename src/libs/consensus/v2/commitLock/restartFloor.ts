import {
    loadSigningRecord,
    setRestartSigningFloor,
} from "src/libs/identity/signingRecord"
import log from "src/utilities/logger"
import { COSIGN_TIMESTAMP_MAX_LEAD_SECONDS } from "../routines/cosignTimestamp"
import { loadCommitLock } from "./lockStore"
import { loadPrevoteRecord } from "./prevoteRecord"

/**
 * The highest round in the signing state files that can be read. A file that
 * cannot be read is skipped: the gates refuse to sign while it stays so.
 */
function highestRecordedRound(identityFile: string): number | null {
    const rounds: number[] = []
    const read = (what: string, round: () => number | undefined) => {
        try {
            const value = round()
            if (value !== undefined) rounds.push(value)
        } catch (e) {
            log.warning(
                `[SIGNING] ${what} not counted in the restart signing floor: ${(e as Error).message}`,
            )
        }
    }
    read("signing record", () => loadSigningRecord(identityFile)?.timestamp)
    read("commit lock", () => loadCommitLock(identityFile)?.round)
    read("prevote record", () => loadPrevoteRecord(identityFile)?.round)
    return rounds.length > 0 ? Math.max(...rounds) : null
}

/**
 * Called once at boot with the calibrated network time, before any round
 * may be signed. An earlier run signed rounds no later than its clock plus
 * the lead, so every round up to `now` plus the lead stays refused. The
 * files lift the floor further when they hold a later round: the clock may
 * have stepped back since they were written.
 */
export function armRestartSigningFloor(
    identityFile: string,
    now: number,
): number {
    const byClock = now + COSIGN_TIMESTAMP_MAX_LEAD_SECONDS
    const recorded = highestRecordedRound(identityFile)
    const floor = recorded !== null && recorded > byClock ? recorded : byClock
    if (floor > byClock) {
        log.warning(
            `[SIGNING] The signing state files hold round ${floor}, ${floor - now}s ahead of the network clock; ` +
                "no round up to it is signed",
        )
    }
    setRestartSigningFloor(floor)
    log.info(
        `[SIGNING] Restart signing floor: only rounds after ${floor} are signed`,
    )
    return floor
}

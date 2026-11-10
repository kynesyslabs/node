import {
    loadSigningRecord,
    restartSigningFloor,
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
 * Called once at boot with the host clock, before any round may be signed.
 * An earlier run signed rounds no later than its clock plus the lead, so
 * every round up to `now` plus the lead stays refused. The files lift the
 * floor further when they hold a later round: the clock may have stepped
 * back since they were written.
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

/**
 * Waits until the network clock is past the restart signing floor, so the
 * first round this node joins is one it signs. Gives up after the lead plus
 * a margin when the floor comes from the state files and is further ahead.
 */
export async function waitForRestartSigningFloor(
    now: () => number,
    sleep: (ms: number) => Promise<void> = ms =>
        new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
    const floor = restartSigningFloor()
    if (floor === null) return true
    const maxWaitSeconds = COSIGN_TIMESTAMP_MAX_LEAD_SECONDS + 2
    const start = now()
    if (start > floor) return true
    log.info(
        `[SIGNING] Waiting for the network clock to pass the restart signing floor ${floor} before joining the network`,
    )
    while (now() <= floor) {
        if (now() - start >= maxWaitSeconds) {
            log.warning(
                `[SIGNING] Restart signing floor ${floor} is still ${floor - now()}s ahead; joining the network, rounds up to it stay refused`,
            )
            return false
        }
        await sleep(200)
    }
    return true
}

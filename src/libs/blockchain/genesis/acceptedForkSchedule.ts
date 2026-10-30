/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * The fork schedule a node last ran with, and which edits of it a restart may
 * load. The schedule is read from the genesis file at every boot, so without
 * this a typo, or an edit at a height the chain has already passed, would be
 * loaded silently and split this node from its peers at that height.
 *
 * Pure: persistence lives in acceptedForkScheduleStore.ts.
 */

import { stableStringify } from "./normalizeGenesisForHash"
import {
    forkScheduleDigest,
    type ForkConfigLike,
} from "@/libs/peer/routines/forkScheduleAgreement"

/** Same shape the schedule digest covers: scheduled forks only, without descriptions. */
export interface ForkSchedule {
    chainId: number | null
    forks: Record<string, Record<string, unknown> & { activationHeight: number }>
}

export function scheduleFromForkConfig(
    forkConfig: ForkConfigLike,
    chainId: number | null,
): ForkSchedule {
    const forks: ForkSchedule["forks"] = {}
    for (const name of Object.keys(forkConfig)) {
        const entry = forkConfig[name]
        if (!entry || entry.activationHeight === null) continue
        const { description: _description, ...consensus } = entry
        forks[name] = consensus as ForkSchedule["forks"][string]
    }
    return { chainId, forks }
}

export function scheduleDigest(schedule: ForkSchedule): string {
    return forkScheduleDigest(schedule.forks, schedule.chainId)
}

export type ScheduleAcceptance =
    | { status: "unchanged" }
    | { status: "accepted"; changes: string[] }
    | { status: "refused"; problems: string[]; digest: string }

/**
 * Whether `current` may replace `accepted` at a node whose chain tip is `tip`.
 *
 * An edit is safe only while the network cannot have acted on either version:
 * both the old and the new activation height must lie beyond `tip + lead`.
 * `lead` is the window in which the schedule watch already compares schedules
 * with peers before a fork activates, so an allowed edit still gets that check.
 * `overrideDigest` accepts one exact schedule regardless, for an edit inside
 * the window that the operators agreed on.
 */
export function acceptSchedule(
    accepted: ForkSchedule,
    current: ForkSchedule,
    tip: number,
    lead: number,
    overrideDigest: string | null,
): ScheduleAcceptance {
    const digest = scheduleDigest(current)
    if (digest === scheduleDigest(accepted)) return { status: "unchanged" }

    const line = tip + lead
    const problems: string[] = []
    const changes: string[] = []

    if (accepted.chainId !== current.chainId) {
        // The chain id only enters consensus through the signature domain, so it
        // may change while that fork lies beyond the line in both versions; a
        // chain that started without one adds it together with the fork.
        const describe = `chain id: ${String(accepted.chainId)} -> ${String(current.chainId)}`
        changes.push(describe)
        const bound = [
            accepted.forks.signatureDomain?.activationHeight,
            current.forks.signatureDomain?.activationHeight,
        ].filter((h): h is number => typeof h === "number" && h <= line)
        if (bound.length > 0) {
            problems.push(
                `${describe} while signatureDomain, which signs over it, is at height ${Math.min(...bound)}, ` +
                    `at or below tip ${tip} + ${lead}`,
            )
        }
    }

    const names = [...new Set([...Object.keys(accepted.forks), ...Object.keys(current.forks)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of names) {
        const before = accepted.forks[name]
        const after = current.forks[name]
        if (stableStringify(before ?? null) === stableStringify(after ?? null)) continue

        const oldHeight = before?.activationHeight ?? null
        const newHeight = after?.activationHeight ?? null
        const describe = `${name}: ${oldHeight ?? "unscheduled"} -> ${newHeight ?? "unscheduled"}` +
            (oldHeight !== null && oldHeight === newHeight ? " (payload changed)" : "")
        changes.push(describe)

        const tooClose = [oldHeight, newHeight].filter(
            (h): h is number => h !== null && h <= line,
        )
        if (tooClose.length > 0) {
            problems.push(
                `${describe} touches height ${Math.min(...tooClose)}, at or below tip ${tip} + ${lead}`,
            )
        }
    }

    if (problems.length === 0) return { status: "accepted", changes }
    if (overrideDigest !== null && overrideDigest === digest) {
        return { status: "accepted", changes: [...changes, `accepted by DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST=${digest}`] }
    }
    return { status: "refused", problems, digest }
}

/** Normalized override digest, or null when unset. */
export function parseOverrideDigest(raw: string | undefined): string | null {
    const value = (raw ?? "").trim().replace(/^0x/i, "").toLowerCase()
    return value === "" ? null : value
}

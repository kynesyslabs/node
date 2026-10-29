import fs from "node:fs"
import { writeFileDurably } from "src/libs/identity/signingRecord"
import { CommitLockError, commitLockPath } from "./lockStore"

/**
 * The latest prevote this validator signed. A member never acts in a round
 * lower than one it already acted in: otherwise a secretary could gather
 * its prevotes for Y in a round, hide them, then drive a lower round to a
 * certificate for X, and the hidden prevotes would later outrank the lock
 * on X and certify Y at the same height. Keeping only the latest prevote is
 * enough, because rounds only rise within a height and heights only rise.
 * Written durably before the prevote is signed, so a restart cannot reopen
 * a lower round.
 */
export interface PrevoteRecord {
    /** Block 0 hash of the chain the record belongs to. */
    genesisHash: string
    height: number
    round: number
    hash: string
    prevotedAt: number
}

export interface PrevoteRequest {
    genesisHash: string
    height: number
    round: number
    hash: string
}

export function prevoteRecordPath(identityFile: string): string {
    return commitLockPath(identityFile).replace(
        /\.commitlock\.json$/,
        ".prevote.json",
    )
}

function isValidRecord(value: unknown): value is PrevoteRecord {
    const r = value as Partial<PrevoteRecord> | null
    return (
        typeof r === "object" &&
        r !== null &&
        typeof r.genesisHash === "string" &&
        r.genesisHash.length > 0 &&
        Number.isSafeInteger(r.height) &&
        (r.height as number) > 0 &&
        Number.isSafeInteger(r.round) &&
        (r.round as number) > 0 &&
        typeof r.hash === "string" &&
        r.hash.length > 0 &&
        Number.isFinite(r.prevotedAt)
    )
}

/**
 * Null only when no prevote was recorded yet. A record that cannot be read
 * or parsed is an error: reading it as absent would reopen the rounds it
 * closed.
 */
export function loadPrevoteRecord(identityFile: string): PrevoteRecord | null {
    const file = prevoteRecordPath(identityFile)
    let raw: string
    try {
        raw = fs.readFileSync(file, "utf8")
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw new CommitLockError(
            `cannot read prevote record ${file}: ${(e as Error).message}`,
        )
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new CommitLockError(
            `prevote record ${file} is not valid JSON; refusing to vote`,
        )
    }
    if (!isValidRecord(parsed)) {
        throw new CommitLockError(
            `prevote record ${file} has an unexpected shape; refusing to vote`,
        )
    }
    return parsed
}

/**
 * Why `request` must not be prevoted after `last`, or null. The same block
 * in the same round may be signed again; another block in that round, or
 * any lower round or height, may not. A record of another chain says
 * nothing about this one.
 */
export function prevoteRefusal(
    last: PrevoteRecord | null,
    request: PrevoteRequest,
): string | null {
    if (!last || last.genesisHash !== request.genesisHash) return null
    if (last.height > request.height) {
        return `already prevoted at height ${last.height}, above ${request.height}`
    }
    if (last.height < request.height) return null
    if (request.round < last.round) {
        return `already prevoted in round ${last.round} at height ${request.height}; round ${request.round} is lower`
    }
    if (request.round === last.round && request.hash !== last.hash) {
        return `already prevoted ${last.hash} in round ${last.round} at height ${request.height}`
    }
    return null
}

/**
 * Durably record that we are about to prevote `request`, or throw when an
 * earlier prevote forbids it. Called before the signature exists.
 */
export function recordPrevoteRound(
    identityFile: string,
    request: PrevoteRequest,
): void {
    const last = loadPrevoteRecord(identityFile)
    const refusal = prevoteRefusal(last, request)
    if (refusal) throw new CommitLockError(`refusing to prevote: ${refusal}`)
    if (
        last &&
        last.genesisHash === request.genesisHash &&
        last.height === request.height &&
        last.round === request.round
    ) {
        return
    }
    writeFileDurably(
        prevoteRecordPath(identityFile),
        JSON.stringify({ ...request, prevotedAt: Date.now() }),
        "prevote record",
    )
}

/**
 * Why a precommit in `round` at `height` must not be signed after the
 * prevotes recorded so far, or null: we prevoted in a later round or a
 * higher height, and a precommit must never follow a later prevote.
 */
export function precommitAfterPrevoteRefusal(
    identityFile: string,
    genesisHash: string,
    height: number,
    round: number,
): string | null {
    const last = loadPrevoteRecord(identityFile)
    if (!last || last.genesisHash !== genesisHash) return null
    if (last.height > height) {
        return `already prevoted at height ${last.height}, above ${height}`
    }
    if (last.height === height && last.round > round) {
        return `already prevoted in round ${last.round} at height ${height}, after round ${round}`
    }
    return null
}

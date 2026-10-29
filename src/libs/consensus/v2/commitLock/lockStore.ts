import fs from "node:fs"
import {
    resolveWriteTarget,
    signingRecordPath,
    writeFileDurably,
} from "src/libs/identity/signingRecord"

/**
 * The commit lock of this validator: the block it last precommitted, with
 * the proof of lock that allowed it and what is needed to rebuild the
 * block. It lives next to the signing record and is written with the same
 * durability, before the precommit leaves the process: a validator that
 * restarts after precommitting must still be bound by the lock.
 */

/** What rebuilds the locked block: every other content field is derived. */
export interface LockInputs {
    previousHash: string
    orderedTransactions: string[]
    peerlist: string[]
    timestamp: number
}

export interface CommitLock {
    /** Block 0 hash of the chain the lock belongs to. */
    genesisHash: string
    height: number
    hash: string
    /** The round of the proof of lock. */
    round: number
    /** The prevotes of the proof of lock, by signer. */
    pol: Record<string, string>
    inputs: LockInputs
    lockedAt: number
}

export class CommitLockError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "CommitLockError"
    }
}

const RECORD_SUFFIX = ".signed.json"

/**
 * Next to the real signing record, so it lands on the same persistent
 * volume when the record is a symlink into one.
 */
export function commitLockPath(identityFile: string): string {
    const record = resolveWriteTarget(signingRecordPath(identityFile))
    const base = record.endsWith(RECORD_SUFFIX)
        ? record.slice(0, -RECORD_SUFFIX.length)
        : record
    return `${base}.commitlock.json`
}

function isStringMap(value: unknown): value is Record<string, string> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every(v => typeof v === "string")
    )
}

export function isLockInputs(value: unknown): value is LockInputs {
    const v = value as Partial<LockInputs> | null
    return (
        typeof v === "object" &&
        v !== null &&
        typeof v.previousHash === "string" &&
        v.previousHash.length > 0 &&
        Array.isArray(v.orderedTransactions) &&
        v.orderedTransactions.every(h => typeof h === "string") &&
        Array.isArray(v.peerlist) &&
        v.peerlist.every(p => typeof p === "string") &&
        typeof v.timestamp === "number" &&
        Number.isSafeInteger(v.timestamp)
    )
}

function isValidLock(value: unknown): value is CommitLock {
    const l = value as Partial<CommitLock> | null
    return (
        typeof l === "object" &&
        l !== null &&
        typeof l.genesisHash === "string" &&
        l.genesisHash.length > 0 &&
        Number.isSafeInteger(l.height) &&
        (l.height as number) > 0 &&
        typeof l.hash === "string" &&
        l.hash.length > 0 &&
        Number.isSafeInteger(l.round) &&
        (l.round as number) > 0 &&
        isStringMap(l.pol) &&
        isLockInputs(l.inputs) &&
        Number.isFinite(l.lockedAt)
    )
}

/**
 * Null only when no lock exists yet. A lock that cannot be read or parsed
 * is an error: treating it as absent would let a damaged file release a
 * lock the validator still holds.
 */
export function loadCommitLock(identityFile: string): CommitLock | null {
    const file = commitLockPath(identityFile)
    let raw: string
    try {
        raw = fs.readFileSync(file, "utf8")
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw new CommitLockError(
            `cannot read commit lock ${file}: ${(e as Error).message}`,
        )
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new CommitLockError(
            `commit lock ${file} is not valid JSON; refusing to precommit`,
        )
    }
    if (!isValidLock(parsed)) {
        throw new CommitLockError(
            `commit lock ${file} has an unexpected shape; refusing to precommit`,
        )
    }
    return parsed
}

/**
 * The lock that binds this validator at `height` of the chain with
 * `genesisHash`, or null. A lock of another chain or another height says
 * nothing about this one.
 */
export function lockAt(
    identityFile: string,
    genesisHash: string,
    height: number,
): CommitLock | null {
    const lock = loadCommitLock(identityFile)
    if (!lock || lock.genesisHash !== genesisHash || lock.height !== height) {
        return null
    }
    return lock
}

export function writeCommitLock(identityFile: string, lock: CommitLock): void {
    if (!isValidLock(lock)) {
        throw new CommitLockError(
            `refusing to write a malformed commit lock at height ${(lock as { height?: unknown } | null)?.height}`,
        )
    }
    writeFileDurably(
        commitLockPath(identityFile),
        JSON.stringify(lock),
        "commit lock",
    )
}

export interface LockRequest {
    genesisHash: string
    height: number
    hash: string
    round: number
}

export type LockDecision =
    /** No lock binds this height: take one. */
    | { action: "lock" }
    /** Locked on the same block: precommit, the lock already says so. */
    | { action: "keep" }
    /** Locked on the same block in an earlier round: advance the round. */
    | { action: "relock"; from: CommitLock }
    /** Locked on another block, with a proof of lock from a later round. */
    | { action: "move"; from: CommitLock }
    | { action: "refuse"; reason: string }

/**
 * The lock rule: a member locked on X with proof-of-lock round p precommits
 * only X, and moves its lock to X' only on a proof of lock for X' from a
 * round above p. It never precommits in a round below its lock, so a
 * precommit can never be for a round the member has already moved past.
 */
export function judgeLock(
    current: CommitLock | null,
    request: LockRequest,
): LockDecision {
    if (
        !current ||
        current.genesisHash !== request.genesisHash ||
        current.height < request.height
    ) {
        return { action: "lock" }
    }
    if (current.height > request.height) {
        return {
            action: "refuse",
            reason: `locked at height ${current.height}, above the requested ${request.height}`,
        }
    }
    if (current.hash === request.hash) {
        if (request.round === current.round) return { action: "keep" }
        if (request.round > current.round) {
            return { action: "relock", from: current }
        }
        return {
            action: "refuse",
            reason: `round ${request.round} is below the lock's round ${current.round}`,
        }
    }
    if (request.round > current.round) return { action: "move", from: current }
    return {
        action: "refuse",
        reason:
            `locked on ${current.hash} with a proof of lock from round ${current.round}; ` +
            `${request.hash} has one only from round ${request.round}`,
    }
}

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import log from "src/utilities/logger"
import { EnvKey } from "src/config/envKeys"
import { parseBoolFlag } from "src/config/envFlags"

export interface SigningRecord {
    /** Block 0 hash of the chain the record belongs to. */
    genesisHash: string
    height: number
    timestamp: number
    hash: string
    signedAt: number
}

export interface BlockSigningRequest {
    genesisHash: string
    height: number
    timestamp: number
    hash: string
}

export interface SigningPolicy {
    /**
     * In production a record of another genesis is refused unless
     * DEMOS_SIGNING_RECORD_REBIND=true: a validator handed the wrong chain
     * must not quietly lose its history.
     */
    production?: boolean
}

export class DoubleSignError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "DoubleSignError"
    }
}

export class SigningRecordError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "SigningRecordError"
    }
}

// Set once evidence shows another process signing with this key: whichever
// copy signs next could be the one that double-signs.
let haltReason: string | null = null

/**
 * Next to the real signing record, so it survives a restart: a crash loop
 * must not clear the stop while the second copy of the key may still run.
 */
export function signingHaltMarkerPath(identityFile: string): string {
    return `${resolveWriteTarget(signingRecordPath(identityFile))}.halted`
}

/**
 * Refuse every further signature in this process, and with an identity file
 * also after restarts until an operator removes the marker. True on the
 * first call.
 */
export function haltSigning(reason: string, identityFile?: string): boolean {
    if (identityFile) {
        const marker = signingHaltMarkerPath(identityFile)
        try {
            if (!fs.existsSync(marker)) {
                fs.writeFileSync(
                    marker,
                    JSON.stringify({ reason, at: Date.now() }),
                    { mode: 0o600 },
                )
            }
        } catch (e) {
            log.error(
                `[SIGNING] cannot write signing stop marker ${marker}: ${(e as Error).message}; signing stays stopped until restart only`,
            )
        }
    }
    if (haltReason !== null) return false
    haltReason = reason
    return true
}

export function signingHaltReason(): string | null {
    return haltReason
}

function markerRefusal(identityFile: string): string | null {
    const marker = signingHaltMarkerPath(identityFile)
    if (!fs.existsSync(marker)) return null
    let reason = "reason unknown"
    try {
        reason = JSON.parse(fs.readFileSync(marker, "utf8"))?.reason ?? reason
    } catch {
        /* the marker's presence is what counts */
    }
    return (
        `signing is stopped by ${marker} (${reason}). ` +
        "Delete it only after confirming that a single copy of this key runs"
    )
}

/** Log at boot when an earlier run stopped signing for good. */
export function reportSigningHaltMarker(identityFile: string): boolean {
    const refusal = markerRefusal(identityFile)
    if (refusal) log.error(`[SIGNING] ${refusal}`)
    return refusal !== null
}

// The identity lease, checked when a signature is about to be released.
let leaseCheck: (() => string | null) | null = null

export function setSigningLeaseCheck(check: (() => string | null) | null): void {
    leaseCheck = check
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetSigningHalt(): void {
    haltReason = null
    signedHere.clear()
    cached = null
    leaseCheck = null
}

// Block hashes this process recorded, newest last. A retried round replaces
// the record, but the earlier block can still be finalised by the shard;
// seeing it later must not look like another signer.
const SIGNED_HERE_LIMIT = 64
const signedHere = new Set<string>()

function rememberSigned(hash: string): void {
    signedHere.delete(hash)
    signedHere.add(hash)
    if (signedHere.size > SIGNED_HERE_LIMIT) {
        signedHere.delete(signedHere.values().next().value as string)
    }
}

export function signedByThisProcess(hash: string): boolean {
    return signedHere.has(hash)
}

export function signingRecordPath(identityFile: string): string {
    return `${identityFile}.signed.json`
}

// The record changes once per signed block but is read for every verified
// peer block that carries our signature, so readers outside the signing path
// use a copy refreshed only when the file's mtime moves.
let cached: {
    identityFile: string
    record: SigningRecord | null
    mtimeMs: number | null
} | null = null

function recordMtime(identityFile: string): number | null {
    try {
        return fs.statSync(signingRecordPath(identityFile)).mtimeMs
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw new SigningRecordError(
            `cannot stat signing record ${signingRecordPath(identityFile)}: ${(e as Error).message}`,
        )
    }
}

/** The last record this process loaded or wrote, without touching the disk. */
export function cachedSigningRecord(identityFile: string): SigningRecord | null {
    return cached?.identityFile === identityFile ? cached.record : null
}

/** loadSigningRecord, re-read only when the file changed since last time. */
export function currentSigningRecord(
    identityFile: string,
): SigningRecord | null {
    const mtimeMs = recordMtime(identityFile)
    if (cached?.identityFile === identityFile && cached.mtimeMs === mtimeMs) {
        return cached.record
    }
    const record = loadSigningRecord(identityFile)
    cached = { identityFile, record, mtimeMs }
    return record
}

function isValidRecord(value: unknown): value is SigningRecord {
    const r = value as Partial<SigningRecord> | null
    return (
        typeof r === "object" &&
        r !== null &&
        typeof r.genesisHash === "string" &&
        r.genesisHash.length > 0 &&
        Number.isSafeInteger(r.height) &&
        (r.height as number) >= 0 &&
        Number.isFinite(r.timestamp) &&
        typeof r.hash === "string" &&
        r.hash.length > 0 &&
        Number.isFinite(r.signedAt)
    )
}

/**
 * Returns null only when no record exists yet. A record that cannot be read
 * or parsed is an error: guessing would let a damaged file reopen the
 * double-sign window.
 */
export function loadSigningRecord(identityFile: string): SigningRecord | null {
    const file = signingRecordPath(identityFile)
    let raw: string
    try {
        raw = fs.readFileSync(file, "utf8")
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw new SigningRecordError(
            `cannot read signing record ${file}: ${(e as Error).message}`,
        )
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new SigningRecordError(
            `signing record ${file} is not valid JSON; refusing to sign`,
        )
    }
    if (!isValidRecord(parsed)) {
        throw new SigningRecordError(
            `signing record ${file} has an unexpected shape; refusing to sign`,
        )
    }
    return parsed
}

// Container entrypoints bridge this file into a persistent volume with a
// symlink; renaming over the link would replace it with a plain file that
// disappears with the container, so the write goes to the link's target.
export function resolveWriteTarget(file: string): string {
    let current = file
    for (let hops = 0; hops < 8; hops++) {
        let target: string
        try {
            target = fs.readlinkSync(current)
        } catch {
            return current
        }
        current = path.resolve(path.dirname(current), target)
    }
    throw new SigningRecordError(`too many symlinks resolving ${file}`)
}

// The record must survive a crash that happens right after we sign, so the
// bytes are fsynced before the rename and the directory entry afterwards.
function writeRecordAtomically(file: string, record: SigningRecord): void {
    const tmp = `${file}.${process.pid}.tmp`
    let fd: number | null = null
    try {
        fd = fs.openSync(tmp, "w", 0o600)
        fs.writeSync(fd, JSON.stringify(record))
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = null
        fs.renameSync(tmp, file)
    } catch (e) {
        if (fd !== null) {
            try {
                fs.closeSync(fd)
            } catch {
                /* already failing */
            }
        }
        fs.rmSync(tmp, { force: true })
        throw new SigningRecordError(
            `cannot persist signing record ${file}: ${(e as Error).message}`,
        )
    }
    syncDirectory(path.dirname(file), file)
}

// Only errors that mean "this filesystem cannot sync a directory" are
// tolerated; any other failure leaves the rename's durability unknown, so
// the block must not be signed.
const DIR_OPEN_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EPERM", "EISDIR"])
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EPERM", "EBADF"])

function errorCode(e: unknown): string | undefined {
    return (e as NodeJS.ErrnoException).code
}

function syncDirectory(dir: string, file: string): void {
    let dirFd: number
    try {
        dirFd = fs.openSync(dir, "r")
    } catch (e) {
        if (DIR_OPEN_UNSUPPORTED.has(errorCode(e) ?? "")) return
        throw new SigningRecordError(
            `cannot sync directory of signing record ${file}: ${(e as Error).message}`,
        )
    }
    try {
        fs.fsyncSync(dirFd)
    } catch (e) {
        if (DIR_FSYNC_UNSUPPORTED.has(errorCode(e) ?? "")) return
        throw new SigningRecordError(
            `cannot sync directory of signing record ${file}: ${(e as Error).message}`,
        )
    } finally {
        fs.closeSync(dirFd)
    }
}

// Two nodes can share one state directory (separate identity locks), so the
// check-and-write must be exclusive across processes. A record write takes
// milliseconds: a lock older than the window belongs to a crashed writer.
const RECORD_LOCK_STALE_MS = 30_000

interface RecordLockHolder {
    pid: number
    hostname: string
    at: number
}

function recordLockIsStale(lockPath: string): boolean {
    let holder: RecordLockHolder | null = null
    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"))
        if (
            typeof parsed?.pid === "number" &&
            typeof parsed?.hostname === "string" &&
            typeof parsed?.at === "number"
        ) {
            holder = parsed
        }
    } catch {
        /* unreadable or malformed: judged by file age below */
    }
    if (!holder) {
        try {
            return (
                Date.now() - fs.statSync(lockPath).mtimeMs >
                RECORD_LOCK_STALE_MS
            )
        } catch {
            return true
        }
    }
    if (Date.now() - holder.at > RECORD_LOCK_STALE_MS) return true
    if (holder.hostname !== os.hostname()) return false
    // Our own pid is a leftover of an earlier attempt in this process (or of
    // a restarted container that got the same pid again).
    if (holder.pid === process.pid) return true
    try {
        process.kill(holder.pid, 0)
        return false
    } catch (e) {
        return errorCode(e) !== "EPERM"
    }
}

function acquireRecordLock(file: string): () => void {
    const lockPath = `${file}.lock`
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = fs.openSync(lockPath, "wx", 0o600)
            try {
                fs.writeSync(
                    fd,
                    JSON.stringify({
                        pid: process.pid,
                        hostname: os.hostname(),
                        at: Date.now(),
                    }),
                )
            } finally {
                fs.closeSync(fd)
            }
            return () => fs.rmSync(lockPath, { force: true })
        } catch (e) {
            if (errorCode(e) !== "EEXIST") {
                throw new SigningRecordError(
                    `cannot lock signing record ${file}: ${(e as Error).message}`,
                )
            }
            if (!recordLockIsStale(lockPath)) {
                throw new SigningRecordError(
                    `another process is writing the signing record ${file} (lock: ${lockPath})`,
                )
            }
            fs.rmSync(lockPath, { force: true })
        }
    }
    throw new SigningRecordError(`could not lock signing record ${file}`)
}

type Verdict =
    | { action: "write"; last: SigningRecord | null }
    | { action: "rebind"; last: SigningRecord }
    | { action: "unchanged" }

function evaluate(
    identityFile: string,
    request: BlockSigningRequest,
    policy: SigningPolicy,
): Verdict {
    if (haltReason !== null) {
        throw new DoubleSignError(`refusing to sign: ${haltReason}`)
    }
    const stopped = markerRefusal(identityFile)
    if (stopped) throw new DoubleSignError(`refusing to sign: ${stopped}`)
    if (
        !request.genesisHash ||
        !Number.isSafeInteger(request.height) ||
        !Number.isFinite(request.timestamp) ||
        !request.hash
    ) {
        throw new DoubleSignError(
            `refusing to sign: invalid round ${JSON.stringify(request)}`,
        )
    }
    const last = loadSigningRecord(identityFile)
    if (!last) return { action: "write", last }
    // A record from another chain says nothing about this one: after a
    // network reset the old heights would otherwise block signing forever.
    if (last.genesisHash !== request.genesisHash) {
        if (
            policy.production &&
            !parseBoolFlag(process.env[EnvKey.DEMOS_SIGNING_RECORD_REBIND])
        ) {
            throw new DoubleSignError(
                `refusing to sign: signing record ${signingRecordPath(identityFile)} belongs to another chain ` +
                    `(genesis ${last.genesisHash}, last signed height ${last.height}; current genesis ${request.genesisHash}). ` +
                    `If this network was reset on purpose, start once with ${EnvKey.DEMOS_SIGNING_RECORD_REBIND}=true; ` +
                    "otherwise this node is on the wrong chain",
            )
        }
        return { action: "rebind", last }
    }

    const refuse = (why: string): never => {
        throw new DoubleSignError(
            `refusing to sign (${why}): last signed height ${last.height}, timestamp ${last.timestamp}, hash ${last.hash}; ` +
                `requested height ${request.height}, timestamp ${request.timestamp}, hash ${request.hash}. ` +
                `Signing record: ${signingRecordPath(identityFile)}. ` +
                "Deleting it is only safe when the chain itself was reset.",
        )
    }
    if (request.height < last.height) {
        refuse("height is below the last signed block")
    }
    if (request.height === last.height) {
        if (request.timestamp < last.timestamp) {
            refuse("timestamp is earlier than the last signed round")
        }
        if (request.timestamp === last.timestamp) {
            if (request.hash !== last.hash) {
                refuse("a different block was already signed for this round")
            }
            return { action: "unchanged" }
        }
    }
    return { action: "write", last }
}

/**
 * Throws when signing this block would conflict with the last block this key
 * signed. A round is identified by (height, timestamp): a failed round is
 * retried at the same height with a later timestamp, which stays allowed.
 * Does not write; call it before signing and `recordBlockSignature` after.
 */
export function checkBlockSignature(
    identityFile: string,
    request: BlockSigningRequest,
    policy: SigningPolicy = {},
): void {
    evaluate(identityFile, request, policy)
}

/**
 * Persist the round after the signature exists and before it can leave the
 * process. The check runs again here, under a cross-process lock, so two
 * signatures produced concurrently for conflicting blocks cannot both be
 * released. A failure to persist is an
 * error: a signed block without a durable record must not be returned.
 */
export function recordBlockSignature(
    identityFile: string,
    request: BlockSigningRequest,
    policy: SigningPolicy = {},
): void {
    const file = resolveWriteTarget(signingRecordPath(identityFile))
    const release = acquireRecordLock(file)
    try {
        const lease = leaseCheck?.()
        if (lease) throw new DoubleSignError(`refusing to sign: ${lease}`)
        const verdict = evaluate(identityFile, request, policy)
        rememberSigned(request.hash)
        if (verdict.action === "unchanged") return
        if (verdict.action === "rebind") {
            log.warning(
                `[SIGNING] signing record ${signingRecordPath(identityFile)} belongs to another chain (genesis ${verdict.last.genesisHash}, current ${request.genesisHash}); overwriting it`,
            )
        }
        const record = {
            genesisHash: request.genesisHash,
            height: request.height,
            timestamp: request.timestamp,
            hash: request.hash,
            signedAt: Date.now(),
        }
        writeRecordAtomically(file, record)
        cached = { identityFile, record, mtimeMs: recordMtime(identityFile) }
    } finally {
        release()
    }
}

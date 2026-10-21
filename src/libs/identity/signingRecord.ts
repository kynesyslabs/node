import fs from "node:fs"
import path from "node:path"
import log from "src/utilities/logger"

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

export function signingRecordPath(identityFile: string): string {
    return `${identityFile}.signed.json`
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
function resolveWriteTarget(file: string): string {
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
    try {
        const dirFd = fs.openSync(path.dirname(file), "r")
        try {
            fs.fsyncSync(dirFd)
        } finally {
            fs.closeSync(dirFd)
        }
    } catch {
        /* directory fsync is unsupported on some platforms */
    }
}

type Verdict =
    | { action: "write"; last: SigningRecord | null }
    | { action: "rebind"; last: SigningRecord }
    | { action: "unchanged" }

function evaluate(identityFile: string, request: BlockSigningRequest): Verdict {
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
): void {
    evaluate(identityFile, request)
}

/**
 * Persist the round after the signature exists and before it can leave the
 * process. The check runs again here so two signatures produced concurrently
 * for conflicting blocks cannot both be released. A failure to persist is an
 * error: a signed block without a durable record must not be returned.
 */
export function recordBlockSignature(
    identityFile: string,
    request: BlockSigningRequest,
): void {
    const verdict = evaluate(identityFile, request)
    if (verdict.action === "unchanged") return
    const file = signingRecordPath(identityFile)
    if (verdict.action === "rebind") {
        log.warning(
            `[SIGNING] signing record ${file} belongs to another chain (genesis ${verdict.last.genesisHash}, current ${request.genesisHash}); overwriting it`,
        )
    }
    writeRecordAtomically(resolveWriteTarget(file), {
        genesisHash: request.genesisHash,
        height: request.height,
        timestamp: request.timestamp,
        hash: request.hash,
        signedAt: Date.now(),
    })
}

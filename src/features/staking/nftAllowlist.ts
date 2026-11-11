import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import log from "src/utilities/logger"

/**
 * The node NFT mints that may back a validator seat, read once from the
 * allowlist file and pinned by the sha256 of its sorted mints.
 */

interface AllowlistFile {
    sha256?: unknown
    mints?: unknown
}

let loaded: Set<string> | null = null

/** sha256 of the sorted mints joined by newlines, the hash the file is pinned by. */
export function allowlistDigest(mints: readonly string[]): string {
    return createHash("sha256")
        .update([...mints].sort().join("\n"))
        .digest("hex")
}

/** Parse an allowlist document and check it against the expected digest. */
export function parseAllowlist(
    raw: string,
    expectedSha256: string,
): Set<string> {
    const doc = JSON.parse(raw) as AllowlistFile
    if (!Array.isArray(doc.mints) || doc.mints.length === 0) {
        throw new Error("allowlist has no mints")
    }
    const mints = doc.mints.map((m, i) => {
        if (typeof m !== "string" || m.length === 0) {
            throw new Error(`allowlist mint[${i}] is not a string`)
        }
        return m
    })
    if (new Set(mints).size !== mints.length) {
        throw new Error("allowlist has duplicate mints")
    }
    const digest = allowlistDigest(mints)
    if (expectedSha256 !== "" && digest !== expectedSha256) {
        throw new Error(
            `allowlist sha256 ${digest} does not match the configured ${expectedSha256}`,
        )
    }
    if (typeof doc.sha256 === "string" && doc.sha256 !== digest) {
        throw new Error(
            `allowlist sha256 ${digest} does not match the file's own ${doc.sha256}`,
        )
    }
    return new Set(mints)
}

/** The allowlist shipped with the node and the digest its sorted mints must hash to. */
export const NFT_ALLOWLIST_PATH = "data/nft-allowlist.json"
export const NFT_ALLOWLIST_SHA256 =
    "3da7c881016692f1724c34c4d68ce6233e6f34eb3a5cf34323022c8930bab116"

/**
 * Read the allowlist from disk. Throws when gating is on and the file is
 * missing or fails its digest, so a node with a wrong list refuses to boot.
 */
export function loadNftAllowlist(): Set<string> {
    const file = path.resolve(NFT_ALLOWLIST_PATH)
    let raw: string
    try {
        raw = fs.readFileSync(file, "utf8")
    } catch (e) {
        throw new Error(
            `[NFT ALLOWLIST] cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`,
        )
    }
    const mints = parseAllowlist(raw, NFT_ALLOWLIST_SHA256)
    loaded = mints
    log.info(`[NFT ALLOWLIST] loaded ${mints.size} eligible mints from ${file}`)
    return mints
}

/** The loaded allowlist, reading it on first use. */
export function getNftAllowlist(): Set<string> {
    if (loaded === null) loaded = loadNftAllowlist()
    return loaded
}

/** Whether `mint` may back a validator seat. */
export function isAllowlistedMint(mint: string): boolean {
    return getNftAllowlist().has(mint)
}

/** Replace the loaded allowlist, for tests and tooling. */
export function setNftAllowlistForTesting(mints: Iterable<string> | null): void {
    loaded = mints === null ? null : new Set(mints)
}

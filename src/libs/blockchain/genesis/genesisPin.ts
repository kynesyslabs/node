/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

/**
 * Boot-time checks of the genesis this node is about to use, against the hash
 * the operator pinned. Pure: the caller reads the files and the database and
 * acts on the problems returned. See docs/design/genesis-enforcement.md.
 */

import { hashGenesisCore, hashGenesisData } from "./normalizeGenesisForHash"

const SHA256_HEX = /^[0-9a-f]{64}$/

export class GenesisRefusal extends Error {
    constructor(message: string) {
        super(message)
        this.name = "GenesisRefusal"
    }
}

/**
 * The pinned hash as a node compares it, or "" when none is set. Throws on a
 * value that is set but cannot be a sha256: a pin that never matches would
 * only refuse later, with a less useful message.
 */
export function parseGenesisPin(raw: string | undefined | null): string {
    const value = (raw ?? "").trim().replace(/^0x/i, "").toLowerCase()
    if (value === "") return ""
    if (!SHA256_HEX.test(value)) {
        throw new GenesisRefusal(
            `EXPECTED_GENESIS_HASH must be 64 hex characters (sha256), got ${JSON.stringify(
                (raw ?? "").slice(0, 80),
            )}`,
        )
    }
    return value
}

function isTrue(raw: string | undefined): boolean {
    const v = (raw ?? "").trim().toLowerCase()
    return v === "true" || v === "1" || v === "yes"
}

/** A production node runs with a pinned genesis unless the operator opted out by name. */
export function pinRequirementProblem(
    pin: string,
    env: Record<string, string | undefined>,
): string | null {
    if (pin !== "") return null
    if (env.NODE_ENV !== "production") return null
    if (isTrue(env.DEMOS_ALLOW_UNPINNED_GENESIS)) return null
    return (
        "EXPECTED_GENESIS_HASH is not set. A production node must pin the genesis it joins: " +
        "set it to the published genesis hash, or set DEMOS_ALLOW_UNPINNED_GENESIS=true " +
        "on a network that has none"
    )
}

/** The manifest hash a genesis declares, or null when it declares no snapshot. */
export function declaredManifestHash(genesisData: unknown): string | null {
    if (genesisData === null || typeof genesisData !== "object") return null
    const snapshot = (genesisData as Record<string, unknown>).snapshot
    if (snapshot === undefined) return null
    const value =
        snapshot !== null && typeof snapshot === "object"
            ? (snapshot as Record<string, unknown>).manifestSha256
            : undefined
    if (typeof value !== "string" || !SHA256_HEX.test(value)) {
        throw new GenesisRefusal(
            "genesis snapshot.manifestSha256 must be a lowercase sha256 hex string",
        )
    }
    return value
}

export interface FreshGenesisInput {
    /** The genesis file as read. */
    genesisData: unknown
    /** Normalized pin, "" when none. */
    pin: string
    /** RESTORE is on: a recovery export would be overlaid on the file. */
    restore: boolean
    /** sha256 of the raw manifest.json bytes, or null when no snapshot is present. */
    snapshotManifestHash: string | null
}

/**
 * Problems with creating block 0 from this file. Run before anything is
 * written: a refused node must leave the database as it found it, or the next
 * boot finds a block 0 and trusts it.
 */
export function freshGenesisProblems(input: FreshGenesisInput): string[] {
    const problems: string[] = []
    const declared = declaredManifestHash(input.genesisData)

    if (declared !== null) {
        if (input.snapshotManifestHash === null) {
            problems.push(
                "genesis declares a snapshot but no snapshot manifest was found " +
                    "(data/snapshot, or DEMOS_SNAPSHOT_DIR)",
            )
        } else if (input.snapshotManifestHash !== declared) {
            problems.push(
                `snapshot manifest hashes to ${input.snapshotManifestHash}, genesis declares ${declared}`,
            )
        }
    }

    if (input.pin === "") return problems

    const fileHash = hashGenesisData(input.genesisData)
    if (fileHash !== input.pin) {
        problems.push(
            `data/genesis.json hashes to ${fileHash}, EXPECTED_GENESIS_HASH is ${input.pin}`,
        )
    }
    if (input.restore) {
        problems.push("RESTORE is on: a recovery overlay would change the pinned genesis")
    }
    const timestamp = (input.genesisData as Record<string, unknown> | null)?.timestamp
    // generateGenesisBlock takes the host clock for any falsy value (0 included)
    // and parseInt for the rest, so only a positive integer gives every node
    // the same block 0
    if (timestamp === undefined || timestamp === null || timestamp === "") {
        problems.push(
            "genesis has no timestamp: block 0 would take this host's clock and differ from every other node's",
        )
    } else if (!/^[1-9][0-9]*$/.test(String(timestamp)) || !Number.isSafeInteger(Number(timestamp))) {
        problems.push(
            `genesis timestamp ${JSON.stringify(timestamp)} is not a positive integer: ` +
                "block 0 would take this host's clock or an invalid time",
        )
    }
    if (declared === null && input.snapshotManifestHash !== null) {
        problems.push(
            "a snapshot is present but the pinned genesis does not declare snapshot.manifestSha256, " +
                "so nothing binds it",
        )
    }
    return problems
}

export interface RestartGenesisInput {
    /** The genesis data stored in block 0. */
    storedGenesisData: unknown
    /** The genesis file as read. */
    fileGenesisData: unknown
    pin: string
}

function chainIdOf(genesisData: unknown): unknown {
    if (genesisData === null || typeof genesisData !== "object") return undefined
    const props = (genesisData as Record<string, unknown>).properties
    if (props === null || typeof props !== "object") return undefined
    return (props as Record<string, unknown>).id
}

/**
 * Problems with continuing an existing chain. The schedule may differ between
 * the file and block 0 (it is checked against the accepted schedule instead);
 * nothing else may.
 */
export function restartGenesisProblems(input: RestartGenesisInput): string[] {
    const problems: string[] = []
    const storedChainId = chainIdOf(input.storedGenesisData)
    const fileChainId = chainIdOf(input.fileGenesisData)
    if (
        storedChainId !== undefined &&
        fileChainId !== undefined &&
        storedChainId !== fileChainId
    ) {
        problems.push(
            `data/genesis.json has chain id ${String(fileChainId)}, block 0 has ${String(storedChainId)}`,
        )
    }

    if (input.pin === "") return problems

    const storedHash = hashGenesisData(input.storedGenesisData)
    if (storedHash !== input.pin) {
        problems.push(
            `the genesis in this database hashes to ${storedHash}, EXPECTED_GENESIS_HASH is ${input.pin}; ` +
                "this database belongs to another chain",
        )
    }
    const fileCore = hashGenesisCore(input.fileGenesisData)
    const storedCore = hashGenesisCore(input.storedGenesisData)
    if (fileCore !== storedCore) {
        problems.push(
            "data/genesis.json differs from block 0 in more than the fork schedule " +
                `(core hash ${fileCore}, block 0 ${storedCore})`,
        )
    }
    return problems
}

/** Genesis data as block 0 stores it: a JSON string, sometimes encoded twice. */
export function parseStoredGenesisData(raw: unknown): unknown {
    let value = raw
    for (let i = 0; i < 2 && typeof value === "string"; i++) {
        value = JSON.parse(value)
    }
    return value
}

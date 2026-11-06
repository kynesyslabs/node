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

import { DEFAULT_FORK_CONFIG, NON_MAINNET_CHAIN_IDS } from "@/forks/forkConfig"
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
export function parseGenesisPin(
    raw: string | undefined | null,
    name = "EXPECTED_GENESIS_HASH",
): string {
    const value = (raw ?? "").trim().replace(/^0x/i, "").toLowerCase()
    if (value === "") return ""
    if (!SHA256_HEX.test(value)) {
        throw new GenesisRefusal(
            `${name} must be 64 hex characters (sha256), got ${JSON.stringify(
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

/**
 * True for a chain id that is neither the testnet's nor a devnet's: mainnet,
 * or a network run like it. A genesis without an id is not one, since
 * signatureDomain cannot run without it.
 */
export function isMainnetChainId(chainId: unknown): boolean {
    return (
        typeof chainId === "number" &&
        Number.isInteger(chainId) &&
        !NON_MAINNET_CHAIN_IDS.includes(chainId)
    )
}

/**
 * A production node, and any node on a mainnet chain id, runs with a pinned
 * genesis. Only a production node on a test network may opt out by name: a
 * bare-metal install runs as development, so NODE_ENV alone would let a
 * mainnet validator boot on whatever genesis file it holds.
 */
export function pinRequirementProblem(
    pin: string,
    env: Record<string, string | undefined>,
    chainId?: unknown,
): string | null {
    if (pin !== "") return null
    if (isMainnetChainId(chainId)) {
        return (
            `EXPECTED_GENESIS_HASH is not set and the genesis has chain id ${String(chainId)}, ` +
            "which is not a test network's. A node on it must pin the published genesis hash; " +
            "DEMOS_ALLOW_UNPINNED_GENESIS does not apply"
        )
    }
    if (env.NODE_ENV !== "production") return null
    if (isTrue(env.DEMOS_ALLOW_UNPINNED_GENESIS)) return null
    return (
        "EXPECTED_GENESIS_HASH is not set. A production node must pin the genesis it joins: " +
        "set it to the published genesis hash, or set DEMOS_ALLOW_UNPINNED_GENESIS=true " +
        "on a network that has none"
    )
}

/**
 * The warning for a node that runs without a pin and was not told that is
 * intended. Outside production nothing refuses such a node (a bare-metal
 * install runs as development), so the operator must at least see it.
 */
export function unpinnedWarning(
    pin: string,
    env: Record<string, string | undefined>,
    blockPin = "",
): string | null {
    // A pinned block 0 already refuses any other genesis.
    if (pin !== "" || blockPin !== "") return null
    if (isTrue(env.DEMOS_ALLOW_UNPINNED_GENESIS)) return null
    return (
        "EXPECTED_GENESIS_HASH is not set: this node accepts whatever genesis data/genesis.json " +
        "holds and could start a chain of its own. Set it to the published genesis hash to join " +
        "a network, or set DEMOS_ALLOW_UNPINNED_GENESIS=true to silence this on a local network"
    )
}

/**
 * The problem with a block 0 whose hash is not the pinned one, or null. Run on
 * the block a fresh node is about to write and on the block a restarted node
 * already holds.
 */
export function blockPinProblem(blockHash: string, blockPin: string, fresh: boolean): string | null {
    if (blockPin === "") return null
    const hash = blockHash.trim().replace(/^0x/i, "").toLowerCase()
    if (hash === blockPin) return null
    return fresh
        ? `block 0 built from data/genesis.json hashes to ${hash}, EXPECTED_GENESIS_BLOCK_HASH is ${blockPin}`
        : `block 0 in this database hashes to ${hash}, EXPECTED_GENESIS_BLOCK_HASH is ${blockPin}; ` +
              "this database belongs to another chain"
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

/**
 * Why block 0 built from `genesisData` would not be the same on every node,
 * or null when its timestamp fixes it.
 */
export function genesisTimestampProblem(genesisData: unknown): string | null {
    const timestamp = (genesisData as Record<string, unknown> | null)?.timestamp
    // generateGenesisBlock takes the host clock for any falsy value (0 included)
    // and parseInt for the rest, so only a positive integer gives every node
    // the same block 0
    if (timestamp === undefined || timestamp === null || timestamp === "") {
        return "genesis has no timestamp: block 0 would take this host's clock and differ from every other node's"
    }
    if (!/^[1-9][0-9]*$/.test(String(timestamp)) || !Number.isSafeInteger(Number(timestamp))) {
        return (
            `genesis timestamp ${JSON.stringify(timestamp)} is not a positive integer: ` +
            "block 0 would take this host's clock or an invalid time"
        )
    }
    return null
}

/**
 * One problem per address that `balances` names more than once. Every path
 * that applies the list keeps the last entry, so a repeated allocation would
 * silently replace the one the reviewers read first.
 */
export function duplicateBalanceProblems(balances: unknown): string[] {
    if (!Array.isArray(balances)) return []
    const seen = new Map<string, number[]>()
    balances.forEach((entry, i) => {
        const address = Array.isArray(entry) ? entry[0] : undefined
        if (typeof address !== "string") return
        // Case-folded: the legacy path keys accounts by the exact string, and
        // two spellings of one key would be two credits nobody reviewed as such
        const key = address.trim().toLowerCase()
        seen.set(key, [...(seen.get(key) ?? []), i])
    })
    const problems: string[] = []
    for (const [address, entries] of seen) {
        if (entries.length > 1) {
            problems.push(
                `genesis balances name ${address} ${entries.length} times (entries ${entries.join(", ")}); ` +
                    "each address may appear once",
            )
        }
    }
    return problems
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
    /** identityCarryover is scheduled at height 0. */
    carryoverAtGenesis?: boolean
    /** Normalized EXPECTED_GENESIS_BLOCK_HASH, "" when none. */
    blockPin?: string
}

/**
 * Problems with creating block 0 from this file. Run before anything is
 * written: a refused node must leave the database as it found it, or the next
 * boot finds a block 0 and trusts it.
 */
export function freshGenesisProblems(input: FreshGenesisInput): string[] {
    const problems: string[] = duplicateBalanceProblems(
        (input.genesisData as Record<string, unknown> | null)?.balances,
    )
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
    // Without a declared snapshot the legacy balances path runs and the user
    // data the carryover genesis promises never reaches the chain.
    if (input.carryoverAtGenesis === true && declared === null) {
        problems.push(
            "identityCarryover is active at genesis but the genesis does not declare " +
                "snapshot.manifestSha256",
        )
    }

    // Block 0 commits to the genesis file, and through it to a declared
    // manifest only: a block pin alone does not bind an undeclared snapshot.
    if (
        declared === null &&
        input.snapshotManifestHash !== null &&
        input.pin === "" &&
        (input.blockPin ?? "") !== ""
    ) {
        problems.push(
            "a snapshot is present but the genesis does not declare snapshot.manifestSha256, " +
                "so EXPECTED_GENESIS_BLOCK_HASH does not bind it",
        )
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
    const timestampProblem = genesisTimestampProblem(input.genesisData)
    if (timestampProblem) problems.push(timestampProblem)
    if (declared === null && input.snapshotManifestHash !== null) {
        problems.push(
            "a snapshot is present but the pinned genesis does not declare snapshot.manifestSha256, " +
                "so nothing binds it",
        )
    }
    return problems
}

export interface GenesisScheduleInput {
    /** The genesis file as read, or null when there is none. */
    fileGenesisData: unknown
    /** Block 0's genesis on a restart. */
    storedGenesisData?: unknown
    /** Normalized pins, "" when none. */
    pin: string
    blockPin: string
}

const KNOWN_FORKS = Object.keys(DEFAULT_FORK_CONFIG)

function declaresHeight(forks: Record<string, unknown>, name: string): boolean {
    const entry = forks[name]
    return (
        Object.hasOwn(forks, name) &&
        entry !== null &&
        typeof entry === "object" &&
        Object.hasOwn(entry, "activationHeight")
    )
}

/**
 * Problems with the fork schedule a node is about to run. A missing file or
 * `forks` field, or an undeclared fork, takes this build's defaults, which can
 * change between releases while the network's schedule cannot. On a test
 * network without pins that stays allowed; a pinned node must have a file
 * and a schedule, and a mainnet chain id must declare every fork this build
 * knows.
 */
export function genesisScheduleProblems(input: GenesisScheduleInput): string[] {
    const mainnet =
        isMainnetChainId(chainIdOf(input.fileGenesisData)) ||
        isMainnetChainId(chainIdOf(input.storedGenesisData))
    const pinned = input.pin !== "" || input.blockPin !== ""
    if (!mainnet && !pinned) return []

    const why = mainnet ? "the chain id is not a test network's" : "the genesis is pinned"
    if (input.fileGenesisData === null || input.fileGenesisData === undefined) {
        return [
            `no genesis file, and ${why}: the node would run with this build's default ` +
                "fork schedule instead of the network's. Mount the network's genesis file",
        ]
    }
    const forks = (input.fileGenesisData as Record<string, unknown>).forks
    if (forks === null || typeof forks !== "object" || Array.isArray(forks)) {
        return [
            `the genesis declares no fork schedule (forks), and ${why}: the node would run ` +
                "with this build's defaults",
        ]
    }
    if (!mainnet) return []
    const undeclared = KNOWN_FORKS.filter(
        name => !declaresHeight(forks as Record<string, unknown>, name),
    )
    if (undeclared.length === 0) return []
    return [
        `the genesis does not declare ${undeclared.join(", ")}: on a mainnet chain id every ` +
            "fork this build knows needs an activationHeight (a height or null), or it takes " +
            "this build's default" +
            (undeclared.includes("gasFeeSeparation")
                ? "; gasFeeSeparation would pay the treasury share to the built-in address"
                : ""),
    ]
}

/**
 * The warning for a genesis that leaves gasFeeSeparation to the default, which
 * is scheduled with a treasury address the code names, not the network.
 */
export function defaultTreasuryWarning(genesisData: unknown): string | null {
    const forks = (genesisData as Record<string, unknown> | null)?.forks
    if (
        forks !== null &&
        typeof forks === "object" &&
        declaresHeight(forks as Record<string, unknown>, "gasFeeSeparation")
    ) {
        return null
    }
    const fallback = DEFAULT_FORK_CONFIG.gasFeeSeparation
    if (fallback.activationHeight === null) return null
    return (
        "the genesis does not declare gasFeeSeparation: it runs from height " +
        `${fallback.activationHeight} with the built-in treasury ${fallback.treasuryAddress}. ` +
        "Declare it with the network's treasuryAddress"
    )
}

export interface RestartGenesisInput {
    /** The genesis data stored in block 0. */
    storedGenesisData: unknown
    /** The genesis file as read. */
    fileGenesisData: unknown
    pin: string
}

/** `properties.id` of a genesis, or undefined. */
export function chainIdOf(genesisData: unknown): unknown {
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

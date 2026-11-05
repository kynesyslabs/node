/**
 * Genesis import under `identityCarryover`: user data comes over from the
 * source network, money and validators do not.
 *
 * Pure apart from reading the snapshot through the loader; the restore and
 * the routines that pay first-link awards share the identity keys built
 * here, so an imported identity and a later link of it always meet on the
 * same key. See docs/mainnet/genesis-import.md.
 */

import { createHash } from "node:crypto"

import { web2UserIdLookupKey } from "@/libs/identity/web2UserId"
import { GenesisRefusal } from "./genesisPin"
import type {
    SnapshotLoaderAvailable,
    ValidatorSeed,
} from "./loadSnapshot"
import type { SnapshotManifest } from "./verifySnapshot"

export type FirstConnectionType =
    | "twitter"
    | "github"
    | "web3"
    | "telegram"
    | "discord"
    | "ud"
    | "nomis"
    | "humanpassport"
    | "ethos"

export type FirstConnectionData = {
    userId?: string
    chain?: string
    subchain?: string
    address?: string
    domain?: string
}

const WEB2_TYPES = new Set(["twitter", "github", "telegram", "discord"])

function present(value: unknown): boolean {
    return value !== undefined && value !== null && value !== ""
}

/**
 * Wallet keys ignore case. Link time lowercases by rules the client can
 * steer (the isEVM flag for wallets, chain === "evm" for Nomis and Ethos),
 * so a case-sensitive key would let the same wallet, linked again under the
 * other rule, miss its imported key and earn the award twice. Folding case
 * can only make two different wallets share a key, which withholds an
 * award and never pays one.
 */
function walletKeyPart(value: string): string {
    return value.trim().toLowerCase()
}

/**
 * The key one identity is known by across accounts, or null when the data
 * does not name one (a web2 link stored without a userId).
 */
export function firstConnectionKey(
    type: FirstConnectionType,
    data: FirstConnectionData,
): string | null {
    if (WEB2_TYPES.has(type)) {
        return present(data.userId)
            ? `web2:${type}:${web2UserIdLookupKey(data.userId)}`
            : null
    }
    if (type === "ud") {
        return typeof data.domain === "string" && data.domain !== ""
            ? `ud:${data.domain.toLowerCase()}`
            : null
    }
    if (type === "humanpassport") {
        return typeof data.address === "string" && data.address !== ""
            ? `humanpassport:${data.address.trim().toLowerCase()}`
            : null
    }
    const { chain, subchain, address } = data
    if (
        typeof chain !== "string" ||
        typeof subchain !== "string" ||
        typeof address !== "string" ||
        address === ""
    ) {
        return null
    }
    const root = type === "web3" ? "xm" : type
    return `${root}:${walletKeyPart(chain)}:${walletKeyPart(subchain)}:${walletKeyPart(address)}`
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null && !Array.isArray(x)
}

function entries(x: unknown): Record<string, unknown>[] {
    return Array.isArray(x) ? x.filter(isRecord) : []
}

/** Every chain/subchain wallet list of a `{ chain: { subchain: [...] } }` tree. */
function walletLists(
    tree: unknown,
): Array<{ chain: string; subchain: string; list: Record<string, unknown>[] }> {
    const out: Array<{ chain: string; subchain: string; list: Record<string, unknown>[] }> = []
    if (!isRecord(tree)) return out
    for (const [chain, subs] of Object.entries(tree)) {
        if (!isRecord(subs)) continue
        for (const [subchain, list] of Object.entries(subs)) {
            out.push({ chain, subchain, list: entries(list) })
        }
    }
    return out
}

/**
 * The keys of every identity an account row carries, for the identities that
 * can earn a first-link award. Sorted and without duplicates.
 */
export function importedIdentityKeys(identities: unknown): string[] {
    const keys = new Set<string>()
    const add = (key: string | null) => {
        if (key !== null) keys.add(key)
    }
    if (!isRecord(identities)) return []

    const web2 = identities.web2
    if (isRecord(web2)) {
        for (const [context, list] of Object.entries(web2)) {
            if (!WEB2_TYPES.has(context)) continue
            for (const id of entries(list)) {
                add(
                    firstConnectionKey(context as FirstConnectionType, {
                        userId: id.userId as string,
                    }),
                )
            }
        }
    }
    for (const [root, type] of [
        ["xm", "web3"],
        ["nomis", "nomis"],
        ["ethos", "ethos"],
    ] as const) {
        for (const { chain, subchain, list } of walletLists(identities[root])) {
            for (const id of list) {
                if (typeof id.address !== "string") continue
                add(firstConnectionKey(type, { chain, subchain, address: id.address }))
            }
        }
    }
    for (const id of entries(identities.ud)) {
        if (typeof id.domain === "string") add(firstConnectionKey("ud", { domain: id.domain }))
    }
    for (const id of entries(identities.humanpassport)) {
        if (typeof id.address === "string") {
            add(firstConnectionKey("humanpassport", { address: id.address }))
        }
    }
    return [...keys].sort()
}

/** Refuses an account row that would bring a balance over. */
export function assertCarryoverRow(
    row: { pubkey: string; balance: bigint },
    rowNo: number,
): void {
    if (row.balance !== 0n) {
        throw new GenesisRefusal(
            `snapshot gcr_main row ${rowNo} (${row.pubkey}) holds balance ${row.balance}; ` +
                "identityCarryover imports no balances. Build the snapshot with " +
                "scripts/state-snapshot/carryover.ts",
        )
    }
}

/** What the manifest alone shows is wrong for a carry-over import. */
export function carryoverManifestProblems(manifest: SnapshotManifest): string[] {
    const problems: string[] = []
    const sum = manifest.files["gcr_main.jsonl"]?.balance_sum
    if (sum !== "0") {
        problems.push(
            `snapshot manifest gcr_main.jsonl balance_sum is ${JSON.stringify(sum)}, identityCarryover requires "0"`,
        )
    }
    if (manifest.files["validators.jsonl"] === undefined) {
        problems.push(
            "snapshot carries no validators.jsonl; identityCarryover takes the validator set from the launch list written into it",
        )
    }
    // Launch stakes are written in OS units; on a snapshot that does not
    // record osDenomination as applied, block 0 would multiply them by 10^9.
    if (!osDenominationApplied(manifest)) {
        problems.push(
            "snapshot manifest fork_state does not record osDenomination as applied; " +
                "identityCarryover needs a snapshot already in OS units",
        )
    }
    return problems
}

export function osDenominationApplied(manifest: Pick<SnapshotManifest, "fork_state">): boolean {
    return (manifest.fork_state ?? []).some(
        f => f.fork_name === "osDenomination" && f.applied === true,
    )
}

type ComparableValidator = {
    status: string | null
    connection_url: string | null
    staked_amount: string
    first_seen: number | null
    valid_at: number | null
    unstake_requested_at: number | null
    unstake_available_at: number | null
}

function comparable(v: Record<string, unknown>): ComparableValidator {
    const num = (x: unknown) => (x === null || x === undefined ? null : Number(x))
    return {
        status: v.status === null || v.status === undefined ? null : String(v.status),
        connection_url:
            typeof v.connection_url === "string" && v.connection_url !== ""
                ? v.connection_url
                : null,
        staked_amount: String(v.staked_amount),
        first_seen: num(v.first_seen),
        valid_at: num(v.valid_at),
        unstake_requested_at: num(v.unstake_requested_at),
        unstake_available_at: num(v.unstake_available_at),
    }
}

/**
 * Differences between the snapshot's validator rows and the genesis list,
 * and rows that are already unstaking. The node seeds the snapshot's rows
 * and ignores the genesis list, so a genesis that also lists validators must
 * list exactly those; an empty or absent genesis list leaves the snapshot as
 * the only source.
 */
export function launchValidatorProblems(
    snapshotRows: ValidatorSeed[],
    genesisValidators: unknown,
): string[] {
    const problems: string[] = []
    const fromSnapshot = new Map(snapshotRows.map(r => [r.address, comparable(r)]))
    // A launch validator that is already unstaking would leave the set
    // within its first blocks.
    for (const [address, v] of fromSnapshot) {
        if (v.unstake_requested_at !== null || v.unstake_available_at !== null) {
            problems.push(`validators.jsonl row ${address} has an unstake under way`)
        }
    }
    if (!Array.isArray(genesisValidators) || genesisValidators.length === 0) return problems
    const fromGenesis = new Map<string, ComparableValidator>()
    for (const v of genesisValidators) {
        if (!isRecord(v) || typeof v.address !== "string") {
            problems.push("genesis validators holds an entry without an address")
            continue
        }
        if (fromGenesis.has(v.address)) {
            problems.push(`genesis validators lists ${v.address} twice`)
        }
        fromGenesis.set(v.address, comparable(v))
    }
    for (const [address, g] of fromGenesis) {
        const s = fromSnapshot.get(address)
        if (!s) {
            problems.push(`genesis validator ${address} is not in the snapshot's validators.jsonl`)
        } else if (JSON.stringify(s) !== JSON.stringify(g)) {
            problems.push(
                `validator ${address} differs between genesis ${JSON.stringify(g)} and validators.jsonl ${JSON.stringify(s)}`,
            )
        }
    }
    for (const address of fromSnapshot.keys()) {
        if (!fromGenesis.has(address)) {
            problems.push(`validators.jsonl row ${address} is not in the genesis validators`)
        }
    }
    return problems
}

/**
 * Everything wrong with a snapshot for a carry-over import, read in one pass
 * over the rows. The launch checks report these; the node refuses on them.
 */
export async function carryoverSnapshotProblems(
    loader: SnapshotLoaderAvailable,
    genesisValidators: unknown,
): Promise<string[]> {
    const problems = carryoverManifestProblems(loader.manifest)
    let rowNo = 0
    for await (const row of loader.streamGcrMain()) {
        rowNo++
        try {
            assertCarryoverRow(row, rowNo)
        } catch (e) {
            problems.push((e as Error).message)
            break
        }
    }
    const validators: ValidatorSeed[] = []
    for await (const v of loader.streamValidators()) validators.push(v)
    problems.push(...launchValidatorProblems(validators, genesisValidators))
    return problems
}

/**
 * Reads the snapshot once before anything is written, so a refused import
 * leaves the database empty. The restore checks every row again as it
 * inserts it.
 */
export async function assertCarryoverSnapshot(
    loader: SnapshotLoaderAvailable,
    genesisValidators: unknown,
): Promise<void> {
    const problems = await carryoverSnapshotProblems(loader, genesisValidators)
    if (problems.length > 0) {
        throw new GenesisRefusal(
            `identityCarryover genesis import refused: ${problems.join("; ")}`,
        )
    }
}

export type ImportedIdentitySummary = { count: number; digest: string }

/** Count and sha256 of the sorted keys, one per line. */
export function importedIdentityDigest(keys: Iterable<string>): ImportedIdentitySummary {
    const sorted = [...new Set(keys)].sort()
    return {
        count: sorted.length,
        digest: createHash("sha256").update(sorted.join("\n")).digest("hex"),
    }
}

/** The identity keys block 0 must have recorded for this snapshot. */
export async function expectedImportedIdentities(
    loader: Pick<SnapshotLoaderAvailable, "streamGcrMain">,
): Promise<ImportedIdentitySummary> {
    const keys = new Set<string>()
    for await (const row of loader.streamGcrMain()) {
        for (const key of importedIdentityKeys(row.identities)) keys.add(key)
    }
    return importedIdentityDigest(keys)
}

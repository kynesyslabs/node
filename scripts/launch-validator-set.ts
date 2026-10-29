/**
 * Block 0's validator set as a booting node seeds it, for the launch tools.
 *
 * chainGenesis.generateGenesisBlock decides it from the snapshot directory:
 * a snapshot whose manifest lists validators.jsonl owns the set and
 * genesis.validators is ignored; a snapshot without that file seeds
 * genesis.validators; no snapshot at all seeds no validators.
 */

import * as fs from "fs"
import * as path from "path"
import type { EntityManager } from "typeorm"
import { loadSnapshot } from "src/libs/blockchain/genesis/loadSnapshot"
import { type GenesisValidatorSeed, seedValidators } from "src/libs/blockchain/genesis/seedValidators"

export interface ValidatorRow {
    address?: unknown
    status?: unknown
    valid_at?: unknown
    connection_url?: unknown
}

export interface BlockZeroValidators {
    /** Rows of the validators table at block 0, before any status filter. */
    rows: ValidatorRow[]
    source: "genesis" | "snapshot" | "none"
    reasons: string[]
    warnings: string[]
}

const norm = (id: string) => id.trim().toLowerCase()

export const NO_SNAPSHOT_REASON =
    "block 0's validator set depends on the snapshot the node boots from (its validators.jsonl, else " +
    "genesis.validators, and none without a snapshot); pass --snapshot DIR"

/**
 * Rows staked at block 0: the pool block 1 is drawn from. Mirrors the
 * node's query (status = '2' AND valid_at <= 0 on an integer column), where
 * a NULL valid_at never matches.
 */
export function activeAtBlockZero<T extends ValidatorRow>(rows: T[]): T[] {
    return rows.filter(
        v => v.status === "2" && typeof v.valid_at === "number" && Number.isInteger(v.valid_at) && v.valid_at <= 0,
    )
}

/**
 * Runs the genesis list through the node's own seeding, against a stand-in
 * for the empty validators table, so a row the node would refuse at boot
 * is reported rather than counted.
 */
async function genesisSeedReasons(rows: ValidatorRow[]): Promise<string[]> {
    const em = {
        query: async () => [{ count: "0" }],
        insert: async () => undefined,
    } as unknown as EntityManager
    try {
        await seedValidators(em, rows as GenesisValidatorSeed[])
        return []
    } catch (e) {
        return [`genesis.validators would stop the node at boot: ${(e as Error).message}`]
    }
}

/** Distinct identities of the rows active at block 0, lowercased. */
export function launchIdentities(rows: ValidatorRow[]): string[] {
    return [...new Set(activeAtBlockZero(rows).map(v => norm(String(v.address))))]
}

/**
 * Reads the set with the node's own snapshot loader (integrity checks
 * included, so a tampered snapshot throws here as it would at boot).
 * Without a snapshot directory the set is unknown, which is NO-GO; the
 * genesis rows are still returned so their endpoints can be probed.
 */
export async function readBlockZeroValidators(
    genesis: { validators?: unknown } | null,
    snapshotDir: string | null,
): Promise<BlockZeroValidators> {
    const genesisRows: ValidatorRow[] = Array.isArray(genesis?.validators)
        ? (genesis.validators as ValidatorRow[])
        : []
    if (snapshotDir === null) {
        return {
            rows: genesisRows,
            source: "none",
            reasons: [NO_SNAPSHOT_REASON],
            warnings: [],
        }
    }

    const dir = path.resolve(snapshotDir)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`snapshot directory ${dir} does not exist`)
    }
    const previous = process.env.DEMOS_SNAPSHOT_DIR
    process.env.DEMOS_SNAPSHOT_DIR = dir
    let snapshot: Awaited<ReturnType<typeof loadSnapshot>>
    try {
        snapshot = await loadSnapshot()
    } finally {
        if (previous === undefined) delete process.env.DEMOS_SNAPSHOT_DIR
        else process.env.DEMOS_SNAPSHOT_DIR = previous
    }

    if (!snapshot.available) {
        return {
            rows: [],
            source: "none",
            reasons: [
                `${dir} has no manifest.json: a node booting with it takes the no-snapshot path and seeds ` +
                    "no validators at block 0",
            ],
            warnings: [],
        }
    }
    if (snapshot.manifest.files["validators.jsonl"] === undefined) {
        return { rows: genesisRows, source: "genesis", reasons: await genesisSeedReasons(genesisRows), warnings: [] }
    }

    const rows: ValidatorRow[] = []
    for await (const row of snapshot.streamValidators()) rows.push(row)
    const warnings: string[] = []
    if (genesisRows.length > 0) {
        const fromSnapshot = new Set(launchIdentities(rows))
        const fromGenesis = new Set(launchIdentities(genesisRows))
        const onlySnapshot = [...fromSnapshot].filter(id => !fromGenesis.has(id))
        const onlyGenesis = [...fromGenesis].filter(id => !fromSnapshot.has(id))
        if (onlySnapshot.length > 0 || onlyGenesis.length > 0) {
            warnings.push(
                "the snapshot's validators.jsonl differs from genesis.validators, and the node takes block 0's " +
                    "validators from the snapshot only; " +
                    `only in the snapshot: ${onlySnapshot.join(", ") || "none"}; ` +
                    `only in genesis.validators (ignored): ${onlyGenesis.join(", ") || "none"}`,
            )
        }
    }
    return { rows, source: "snapshot", reasons: [], warnings }
}

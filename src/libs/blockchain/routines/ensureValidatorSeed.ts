/**
 * Boot-time validator seed reconciliation (DEM-771).
 *
 * `seedValidators` (src/libs/blockchain/genesis/seedValidators.ts) only
 * runs inside `generateGenesisBlock`, which `findGenesisBlock`
 * short-circuits past once block 0 is in the database. If the
 * `validators` table is ever emptied while block 0 is present (manual
 * DB intervention, restore from a partial dump, etc.) the chain
 * silently stalls: `getShard` returns 0 peers, no quorum is reached,
 * `/health` still reports OK. The operator only finds out by manually
 * calling `getValidators` and seeing zero.
 *
 * This routine runs once during boot, AFTER `findGenesisBlock`. It is
 * conservative — `count > 0` short-circuits to a no-op so dynamically
 * staked rows are never overwritten and legitimately unstaked rows are
 * never resurrected. When the table is empty the recovery order is:
 *
 *   1. `data/snapshot/validators.jsonl` (preferred). Snapshots are the
 *      authoritative state-at-snapshot-time and include every dynamic
 *      stake event that landed before the snapshot was taken. Re-seeding
 *      from snapshot keeps mainnet operators from losing post-genesis
 *      stakers when the table gets wiped out-of-band.
 *   2. `data/genesis.json::validators[]` (fallback) BUT ONLY when the
 *      chain is still at block 0. Past block 0, genesis-baked addresses
 *      may have legitimately unstaked and newer staked addresses are
 *      not represented; auto-seeding from genesis after the chain has
 *      moved would silently revert the validator set. We refuse to boot
 *      in that situation and ask the operator to restore a snapshot.
 *   3. If neither source is usable we throw with a remediation message.
 */

import type { EntityManager } from "typeorm"

import Chain from "src/libs/blockchain/chain"
import {
    loadSnapshot,
    type ValidatorSeed as SnapshotValidatorSeed,
} from "src/libs/blockchain/genesis/loadSnapshot"
import Datasource from "src/model/datasource"
import { Validators } from "src/model/entities/Validators"
import log from "src/utilities/logger"

export interface GenesisValidatorSeed {
    address: string
    status: string
    connection_url: string | null
    staked_amount: string
    first_seen: number
    valid_at: number
}

/**
 * Internal upsert shape used for both genesis and snapshot rows. The
 * snapshot type allows nulls on `status`, `first_seen`, `valid_at`; the
 * Validators entity columns are nullable so we pass them through as-is.
 */
interface ValidatorUpsertRow {
    address: string
    status: string | null
    connection_url: string | null
    staked_amount: string
    first_seen: number | null
    valid_at: number | null
    unstake_requested_at: number | null
    unstake_available_at: number | null
}

/** Matches `0x` followed by exactly 64 hex characters. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/

export class ConsensusInvariantError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ConsensusInvariantError"
    }
}

export interface EnsureValidatorSeedResult {
    /** true when this call wrote rows; false when the table was already populated. */
    reseeded: boolean
    /** Row count in `validators` after the routine returns. */
    count: number
    /** Which source supplied the rows; `null` when we did not reseed. */
    source: "snapshot" | "genesis" | null
}

/**
 * Reconcile the validators table at boot. See file header for the
 * full motivation.
 *
 * @param genesisData Parsed contents of `data/genesis.json`. May be any
 *                    shape — the routine extracts `validators` defensively
 *                    and treats anything malformed as "no genesis seed
 *                    available".
 */
export async function ensureValidatorSeed(
    genesisData: unknown,
): Promise<EnsureValidatorSeedResult> {
    const existing = await countValidators()
    if (existing > 0) {
        return { reseeded: false, count: existing, source: null }
    }

    const db = (await Datasource.getInstance()).getDataSource()
    const lastBlock = await Chain.getLastBlockNumber()

    // Primary recovery — snapshot, when it carries validators.jsonl.
    // Snapshots are the safe source on a chain that has advanced past
    // genesis because they capture post-genesis staking events.
    const snapshotRows = await loadSnapshotValidators()
    if (snapshotRows.length > 0) {
        log.warning(
            `[BOOT] validators table empty; re-seeding ${snapshotRows.length} entries from data/snapshot/validators.jsonl`,
        )
        await db.transaction(em => upsertValidators(em, snapshotRows))
        return await assertSeededAndReturn("snapshot")
    }

    // Fallback — genesis-baked validators, but ONLY at block 0. On an
    // advanced chain we refuse to boot: a genesis seed would resurrect
    // historically unstaked addresses and silently lose any validator
    // that staked after genesis.
    if (lastBlock > 0) {
        throw new ConsensusInvariantError(
            `[BOOT] validators table empty at block ${lastBlock} and no ` +
                `usable snapshot at data/snapshot/. Auto-seeding from ` +
                `data/genesis.json after the chain has advanced is unsafe ` +
                `(it would revert the validator set to the founders and ` +
                `lose every staked validator). Restore data/snapshot/ from ` +
                `a healthy peer and re-run, or accept a full wipe via ` +
                `\`./run --docker --reset\`.`,
        )
    }

    const seed = extractGenesisSeed(genesisData)
    if (seed.length === 0) {
        throw new ConsensusInvariantError(
            "[BOOT] validators table empty and neither data/snapshot/ nor " +
                "data/genesis.json carries a validator set; chain cannot " +
                "reach consensus. Restore data/snapshot/ from a healthy " +
                "peer and re-run with `./run --docker --reset`, or fix " +
                "data/genesis.json.",
        )
    }

    seed.forEach(validateSeedEntry)
    log.warning(
        `[BOOT] validators table empty at block 0; re-seeding ${seed.length} entries from data/genesis.json`,
    )
    await db.transaction(em => upsertValidators(em, seed.map(genesisToRow)))
    return await assertSeededAndReturn("genesis")
}

async function assertSeededAndReturn(
    source: "snapshot" | "genesis",
): Promise<EnsureValidatorSeedResult> {
    const after = await countValidators()
    if (after === 0) {
        throw new ConsensusInvariantError(
            `[BOOT] validator re-seed from ${source} produced 0 rows; ` +
                `aborting boot. Check DB connectivity and the source file.`,
        )
    }
    log.info(`[BOOT] validators re-seeded from ${source}; ${after} rows`)
    return { reseeded: true, count: after, source }
}

async function countValidators(): Promise<number> {
    const db = (await Datasource.getInstance()).getDataSource()
    return db.getRepository(Validators).count()
}

/**
 * Returns the snapshot's validator rows as upsert-ready objects, or an
 * empty array when no snapshot is present / the snapshot is schemaVersion
 * 1 (no validators.jsonl). Tolerant of stream-read failures — they are
 * logged and treated as "no snapshot source".
 */
async function loadSnapshotValidators(): Promise<ValidatorUpsertRow[]> {
    let snapshot: Awaited<ReturnType<typeof loadSnapshot>>
    try {
        snapshot = await loadSnapshot()
    } catch (e) {
        log.warning(
            `[BOOT] failed to load data/snapshot/ for validator recovery: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return []
    }
    if (!snapshot.available) return []
    if (!snapshot.manifest.files["validators.jsonl"]) return []

    const rows: ValidatorUpsertRow[] = []
    try {
        for await (const v of snapshot.streamValidators()) {
            rows.push(snapshotToRow(v))
        }
    } catch (e) {
        log.warning(
            `[BOOT] failed to stream validators.jsonl from snapshot: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        return []
    }
    return rows
}

function snapshotToRow(v: SnapshotValidatorSeed): ValidatorUpsertRow {
    return {
        address: v.address,
        status: v.status,
        connection_url: v.connection_url,
        staked_amount: v.staked_amount,
        first_seen: v.first_seen,
        valid_at: v.valid_at,
        unstake_requested_at: v.unstake_requested_at,
        unstake_available_at: v.unstake_available_at,
    }
}

function genesisToRow(v: GenesisValidatorSeed): ValidatorUpsertRow {
    return {
        address: v.address,
        status: v.status,
        connection_url: v.connection_url,
        staked_amount: v.staked_amount,
        first_seen: v.first_seen,
        valid_at: v.valid_at,
        unstake_requested_at: null,
        unstake_available_at: null,
    }
}

function extractGenesisSeed(genesisData: unknown): GenesisValidatorSeed[] {
    if (!genesisData || typeof genesisData !== "object") return []
    const raw = (genesisData as { validators?: unknown }).validators
    if (!Array.isArray(raw)) return []
    return raw as GenesisValidatorSeed[]
}

/**
 * Mirror of the validator-row shape enforced by
 * `src/libs/blockchain/genesis/seedValidators.ts::validateSeed`.
 * Duplicated rather than imported to avoid touching the genesis-init
 * path; both must stay in sync if the schema evolves.
 *
 * Only applied to genesis-sourced rows. Snapshot rows go through the
 * loader's own typed stream and bypass this — the loader already
 * enforces the wider schema (status / first_seen / valid_at may be
 * null) so re-validating here would reject legitimate snapshot input.
 */
function validateSeedEntry(seed: GenesisValidatorSeed, index: number): void {
    // Guard the whole row first so a `null` / non-object element in
    // genesis.json (e.g. an editor accidentally writes `[null, {...}]`)
    // surfaces as a ConsensusInvariantError with the offending index,
    // not a native `Cannot read properties of null` TypeError.
    if (seed === null || typeof seed !== "object") {
        throw new ConsensusInvariantError(
            `[BOOT] genesis.validators[${index}] must be an object, got ${JSON.stringify(
                seed,
            )}`,
        )
    }
    if (!ADDRESS_RE.test(seed.address)) {
        throw new ConsensusInvariantError(
            `[BOOT] genesis.validators[${index}].address invalid: expected 0x + 64 hex chars, got "${seed.address}"`,
        )
    }
    if (typeof seed.status !== "string" || seed.status.length === 0) {
        throw new ConsensusInvariantError(
            `[BOOT] genesis.validators[${index}].status must be a non-empty string`,
        )
    }
    // Split the BigInt() parse from the positivity check so the
    // operator sees a distinct, actionable message for each failure
    // mode — matches `seedValidators.ts::validateSeed` exactly.
    let stake: bigint
    try {
        stake = BigInt(seed.staked_amount)
    } catch {
        throw new ConsensusInvariantError(
            `[BOOT] genesis.validators[${index}].staked_amount is not a valid bigint: "${seed.staked_amount}"`,
        )
    }
    if (stake <= 0n) {
        throw new ConsensusInvariantError(
            `[BOOT] genesis.validators[${index}].staked_amount must be > 0, got "${seed.staked_amount}"`,
        )
    }
    if (seed.connection_url !== null) {
        if (
            typeof seed.connection_url !== "string" ||
            seed.connection_url.length === 0
        ) {
            throw new ConsensusInvariantError(
                `[BOOT] genesis.validators[${index}].connection_url must be null or a non-empty string`,
            )
        }
    }
    if (!Number.isInteger(seed.first_seen) || seed.first_seen < 0) {
        throw new ConsensusInvariantError(
            `[BOOT] genesis.validators[${index}].first_seen must be a non-negative integer`,
        )
    }
    if (!Number.isInteger(seed.valid_at) || seed.valid_at < 0) {
        throw new ConsensusInvariantError(
            `[BOOT] genesis.validators[${index}].valid_at must be a non-negative integer`,
        )
    }
}

async function upsertValidators(
    em: EntityManager,
    rows: ValidatorUpsertRow[],
): Promise<void> {
    const BATCH = 100
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)

        // ON CONFLICT (address) DO NOTHING. Defence in depth: even if the
        // `count > 0` early-return ever stops gating correctly, this
        // never overwrites a dynamically-staked row.
        await em
            .createQueryBuilder()
            .insert()
            .into(Validators)
            .values(batch)
            .orIgnore()
            .execute()
    }
}

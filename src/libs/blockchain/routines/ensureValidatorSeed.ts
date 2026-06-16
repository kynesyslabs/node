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
 * conservative: if the validators table has any rows it does nothing
 * (so dynamically-staked validators are never overwritten and
 * legitimately-unstaked addresses are never resurrected). It only
 * touches the table when it is completely empty AND `data/genesis.json`
 * carries a non-empty validators[] block.
 *
 * If the table is empty and there is nothing to seed from genesis, we
 * throw — the chain cannot reach consensus from local data alone and
 * the operator needs to either restore `data/snapshot/` or fix
 * `data/genesis.json`.
 */

import type { EntityManager } from "typeorm"

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
}

/**
 * Reconcile the validators table at boot. See file header for the
 * full motivation.
 *
 * @param genesisData Parsed contents of `data/genesis.json`. May be any
 *                    shape — the routine extracts `validators` defensively
 *                    and treats anything malformed as "no seed available".
 */
export async function ensureValidatorSeed(
    genesisData: unknown,
): Promise<EnsureValidatorSeedResult> {
    const existing = await countValidators()
    if (existing > 0) {
        return { reseeded: false, count: existing }
    }

    const seed = extractSeed(genesisData)
    if (seed.length === 0) {
        throw new ConsensusInvariantError(
            "[BOOT] validators table empty and data/genesis.json carries no " +
                "validator set; chain cannot reach consensus. Restore " +
                "data/snapshot/ from a healthy peer and re-run with " +
                "`./run --reset`, or fix data/genesis.json.",
        )
    }

    seed.forEach(validateSeedEntry)

    log.warning(
        `[BOOT] validators table empty; re-seeding ${seed.length} entries from data/genesis.json`,
    )

    const db = (await Datasource.getInstance()).getDataSource()
    await db.transaction(async em => {
        await upsertValidators(em, seed)
    })

    const after = await countValidators()
    if (after === 0) {
        throw new ConsensusInvariantError(
            "[BOOT] validator re-seed produced 0 rows; aborting boot. " +
                "Check DB connectivity and data/genesis.json.validators[] " +
                "shape.",
        )
    }

    log.info(`[BOOT] validators re-seeded; table now has ${after} rows`)
    return { reseeded: true, count: after }
}

async function countValidators(): Promise<number> {
    const db = (await Datasource.getInstance()).getDataSource()
    return db.getRepository(Validators).count()
}

function extractSeed(genesisData: unknown): GenesisValidatorSeed[] {
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
    seeds: GenesisValidatorSeed[],
): Promise<void> {
    const BATCH = 100
    for (let i = 0; i < seeds.length; i += BATCH) {
        const batch = seeds.slice(i, i + BATCH).map(v => ({
            address: v.address,
            status: v.status,
            connection_url: v.connection_url,
            staked_amount: v.staked_amount,
            first_seen: v.first_seen,
            valid_at: v.valid_at,
            unstake_requested_at: null,
            unstake_available_at: null,
        }))

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

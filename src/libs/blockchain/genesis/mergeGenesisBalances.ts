/**
 * Genesis balance overlay (post-snapshot).
 *
 * Bug history: when `data/snapshot/` is present, `restoreSnapshot` owns
 * every gcr_main row and the legacy `genesisData.balances` array was
 * silently ignored (see chainGenesis.ts:131-138 historical comment). An
 * operator who edited `data/genesis.json` to top up an address would
 * see block-0 hash change (because `extra.genesisData` carries the raw
 * JSON) but the address balance would remain at whatever the snapshot
 * row said — or, for an address absent from the snapshot, at 0 once
 * `ensureGCRForUser` later created the row.
 *
 * Fix (this module): after `restoreSnapshot`, UPSERT every entry in
 * `genesisData.balances` over the snapshot rows. `genesis.balances`
 * wins on conflict — that matches operator intent: the snapshot is the
 * historical state, `genesis.balances` is the deliberate top-up shipped
 * with the new genesis. Runs inside the caller-owned transaction so a
 * mid-overlay crash rolls back the whole genesis bootstrap.
 *
 * Consensus impact: NONE. Block-0 hash is computed from
 * `serializeBlockContent` whose `extra.genesisData` already includes the
 * `balances` array. Every honest node parsing the same genesis.json
 * derives the same gcr_main state after this overlay, so two nodes
 * disagreeing on post-genesis balances were already in the broken
 * pre-fix state — this just makes the disk reflect what the hash already
 * commits to.
 *
 * Row shape: new rows (pubkey absent from snapshot) get the same
 * defaults `HandleGCR.createAccount` would assign — empty identities,
 * generated referral code, zero points — so they look identical to
 * organically-created accounts the first time `ensureGCRForUser`
 * touches them. Existing rows have ONLY their `balance` column
 * overwritten; identities/points/referralInfo/flags are preserved from
 * the snapshot (operator intent is "fix the balance", not "wipe the
 * account").
 */

import type { EntityManager } from "typeorm"

import log from "src/utilities/logger"
import { GCRMain } from "src/model/entities/GCRv2/GCR_Main"
import type { SavedUdIdentity } from "src/model/entities/types/IdentityTypes"
import { Referrals } from "@/features/incentive/referrals"

/**
 * Parse a `genesisData.balances` entry into `[pubkey, bigint]`.
 *
 * `data/genesis.json` historically allows the balance side to be a
 * decimal string, a number, or a bigint-string. We coerce to bigint
 * (OS denomination) here and fail loudly on anything malformed — a
 * silent BigInt(0) on a typo would re-introduce the same class of
 * "operator wrote it but the chain doesn't know" bug we're fixing.
 */
function parseGenesisBalanceEntry(
    entry: unknown,
    idx: number,
): [string, bigint] {
    if (!Array.isArray(entry) || entry.length < 2) {
        throw new Error(
            `[GENESIS][BALANCES] entry ${idx} is not a [pubkey, balance] tuple`,
        )
    }
    const [pubkey, rawBalance] = entry as [unknown, unknown]
    if (typeof pubkey !== "string" || pubkey.trim().length === 0) {
        throw new Error(
            `[GENESIS][BALANCES] entry ${idx} pubkey is not a non-empty string`,
        )
    }
    let balance: bigint
    try {
        if (typeof rawBalance === "bigint") {
            balance = rawBalance
        } else if (typeof rawBalance === "number") {
            if (!Number.isFinite(rawBalance) || !Number.isInteger(rawBalance)) {
                throw new Error(
                    `numeric balance must be a finite integer, got ${rawBalance}`,
                )
            }
            balance = BigInt(rawBalance)
        } else if (typeof rawBalance === "string") {
            balance = BigInt(rawBalance.trim())
        } else {
            throw new Error(
                `unsupported balance type ${typeof rawBalance}`,
            )
        }
    } catch (e) {
        throw new Error(
            `[GENESIS][BALANCES] entry ${idx} (${pubkey}) has invalid balance: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
    }
    if (balance < 0n) {
        throw new Error(
            `[GENESIS][BALANCES] entry ${idx} (${pubkey}) has negative balance ${balance.toString()}`,
        )
    }
    return [pubkey, balance]
}

/**
 * Default JSON columns used for freshly-inserted gcr_main rows. Mirrors
 * the shape `HandleGCR.createAccount` writes so the row is
 * indistinguishable from one created via the normal account flow.
 */
function defaultEmptyAccountFields(pubkey: string) {
    const now = new Date()
    // NOTE: no `assignedTxs` — that array was moved off gcr_main into the
    // dedicated gcr_assigned_txs relation (MoveAssignedTxsToOwnTable). A
    // freshly-merged genesis account simply has no assignments yet.
    return {
        identities: {
            xm: {},
            web2: {},
            pqc: {},
            ud: [] as SavedUdIdentity[],
        },
        nonce: 0,
        points: {
            totalPoints: 0,
            breakdown: {
                web3Wallets: {} as Record<string, number>,
                socialAccounts: {
                    twitter: 0,
                    github: 0,
                    discord: 0,
                },
                referrals: 0,
                demosFollow: 0,
            },
            lastUpdated: now,
        },
        referralInfo: {
            totalReferrals: 0,
            referralCode: Referrals.generateReferralCode(pubkey),
            referrals: [] as Array<{
                referredUserId: string
                referredAt: string
                pointsAwarded: number
            }>,
            referredBy: null as string | null,
        },
        flagged: false,
        flaggedReason: "" as const,
        reviewed: false,
        createdAt: now,
        updatedAt: now,
    }
}

export interface MergeGenesisBalancesResult {
    /** Total entries processed from genesisData.balances */
    total: number
    /** Rows whose balance was overwritten over an existing snapshot row */
    updated: number
    /** Rows freshly inserted because the pubkey was absent from snapshot */
    inserted: number
}

/**
 * Apply `genesisData.balances` over the gcr_main rows restored by
 * `restoreSnapshot`. Must run inside the same transaction so rollback
 * stays atomic with the snapshot restore.
 *
 * @param em       EntityManager bound to the genesis transaction
 * @param balances Raw `genesisData.balances` array (tuples of
 *                 `[pubkey, balance]`). May be undefined/empty — no-op
 *                 in that case.
 */
export async function mergeGenesisBalances(
    em: EntityManager,
    balances: unknown,
): Promise<MergeGenesisBalancesResult> {
    const result: MergeGenesisBalancesResult = {
        total: 0,
        updated: 0,
        inserted: 0,
    }

    if (balances === undefined || balances === null) {
        return result
    }
    if (!Array.isArray(balances)) {
        throw new Error(
            "[GENESIS][BALANCES] genesisData.balances is present but not an array",
        )
    }
    if (balances.length === 0) {
        return result
    }

    log.info(
        `[GENESIS][BALANCES] overlaying ${balances.length} entries from genesisData.balances`,
    )

    // Parse + dedupe upfront so we fail before any DB write if the
    // operator shipped a malformed entry. Last-wins on duplicate pubkey
    // — same rule createAccount would apply if called twice.
    const parsed = new Map<string, bigint>()
    for (let i = 0; i < balances.length; i++) {
        const [pubkey, balance] = parseGenesisBalanceEntry(balances[i], i)
        parsed.set(pubkey, balance)
    }
    result.total = parsed.size

    const repo = em.getRepository(GCRMain)

    for (const [pubkey, balance] of parsed) {
        const existing = await repo.findOne({ where: { pubkey } })
        if (existing) {
            // Only the balance column is overwritten; everything else
            // (identities, points, referralInfo, flagged, …) belongs to
            // the snapshot row and we have no business stomping it.
            existing.balance = balance
            existing.updatedAt = new Date()
            await repo.save(existing)
            result.updated++
        } else {
            const fresh = repo.create({
                pubkey,
                balance,
                ...defaultEmptyAccountFields(pubkey),
            })
            await repo.save(fresh)
            result.inserted++
        }
    }

    log.info(
        `[GENESIS][BALANCES] overlay done — total=${result.total} updated=${result.updated} inserted=${result.inserted}`,
    )

    return result
}

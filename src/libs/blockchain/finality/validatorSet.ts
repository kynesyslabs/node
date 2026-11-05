/**
 * Validator set snapshots (`finalityProofs` fork).
 *
 * The validators table only holds the present: a validator that unstaked
 * since height k is gone from what the table says about k. Committee
 * selection must give every node, live or syncing years later, the same
 * answer for a height, so it reads the set as it stood after each block from
 * `validator_set_snapshots`, written in the block's own insert transaction.
 *
 * Block N is forged before its own transactions apply, so the newest set it
 * can commit to is the one after block N - 1. That set, H(V(N - 1)), is what
 * the committee for block N + 1 is drawn from.
 */

import { LessThanOrEqual, MoreThan, MoreThanOrEqual } from "typeorm"
import type { EntityManager } from "typeorm"
import Hashing from "@/libs/crypto/hashing"
import { isForkActive } from "@/forks/forkGates"
import { jcsCanonicalize } from "src/libs/crypto/jcs"
import { compareCodeUnits } from "src/libs/crypto/canonicalJson"
import { VALIDATOR_STATUS_ACTIVE } from "@/features/staking/constants"
import { Validators } from "src/model/entities/Validators"
import {
    ValidatorSetSnapshots,
    type ValidatorSetEntry,
} from "src/model/entities/ValidatorSetSnapshots"
import log from "src/utilities/logger"

/** The database lacks the snapshot history committee selection needs. */
export class ValidatorSetHistoryError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ValidatorSetHistoryError"
    }
}

export interface ValidatorSetSnapshot {
    block: number
    setHash: string
    validators: ValidatorSetEntry[]
}

type ValidatorRow = Pick<
    Validators,
    "address" | "staked_amount" | "status" | "valid_at"
>

/**
 * The set record of validators rows: every row, whatever its status, as
 * `{identity, stake, status, validAt}` sorted by identity. Only fields that
 * decide who may sit on a committee are in it, so a changed connection URL
 * is not a new set.
 */
export function validatorSetRecord(rows: ValidatorRow[]): ValidatorSetEntry[] {
    return rows
        .filter(row => typeof row.address === "string" && row.address.length > 0)
        .map(row => ({
            identity: row.address.toLowerCase(),
            stake: row.staked_amount ?? "0",
            status: row.status ?? null,
            validAt: row.valid_at ?? null,
        }))
        .map(entry => ({ entry, key: jcsCanonicalize(entry) }))
        .sort(
            (a, b) =>
                compareCodeUnits(a.entry.identity, b.entry.identity) ||
                compareCodeUnits(a.key, b.key),
        )
        .map(({ entry }) => entry)
}

/** sha256 of the record's JCS encoding, lowercase hex. */
export function validatorSetHash(record: ValidatorSetEntry[]): string {
    return Hashing.sha256(jcsCanonicalize(record))
}

/**
 * Identities that may be drawn at `height` from a set: active, and valid
 * from that height on. The same filter the live table read applies.
 */
export function activeIdentities(
    record: ValidatorSetEntry[],
    height: number,
): Set<string> {
    return new Set(
        record
            .filter(
                entry =>
                    entry.status === VALIDATOR_STATUS_ACTIVE &&
                    entry.validAt !== null &&
                    entry.validAt <= height,
            )
            .map(entry => entry.identity),
    )
}

async function latestAtOrBelow(
    em: EntityManager,
    height: number,
): Promise<ValidatorSetSnapshot | null> {
    return await em.getRepository(ValidatorSetSnapshots).findOne({
        where: { block: LessThanOrEqual(height) },
        order: { block: "DESC" },
    })
}

async function liveRecord(em: EntityManager): Promise<ValidatorSetEntry[]> {
    return validatorSetRecord(await em.getRepository(Validators).find())
}

/**
 * Records the set after `block` when it differs from the set before it, or
 * when there is no set before it. Runs inside the block's insert transaction,
 * after every hook that can touch the validators table, so the row commits or
 * rolls back with the block.
 *
 * Rows at or above `block` are left over from a chain this node no longer
 * follows: the block is being inserted now, so they are dropped first.
 *
 * @returns Whether a row was written
 */
export async function recordValidatorSetSnapshot(
    em: EntityManager,
    block: number,
): Promise<boolean> {
    const repo = em.getRepository(ValidatorSetSnapshots)
    await repo.delete({ block: MoreThanOrEqual(block) })

    const validators = await liveRecord(em)
    const setHash = validatorSetHash(validators)
    const previous = block > 0 ? await latestAtOrBelow(em, block - 1) : null
    if (previous?.setHash === setHash) {
        return false
    }
    await repo.insert({ block, setHash, validators })
    log.info(
        `[finality] validator set after block ${block}: ${validators.length} rows, ${setHash}`,
    )
    return true
}

async function dataSource() {
    const { default: datasource } = await import("src/model/datasource")
    return (await datasource.getInstance()).getDataSource()
}

/**
 * The set after block `height`: the newest snapshot at or below it, or null
 * when this node holds none that old.
 */
export async function validatorSetAt(
    height: number,
): Promise<ValidatorSetSnapshot | null> {
    return await latestAtOrBelow((await dataSource()).manager, height)
}

/**
 * Boot step after the validator seed: makes sure the set at the current tip
 * is recorded. A fresh chain gets its block 0 snapshot here. A node that ran
 * without snapshot writes (an older binary) has a live table that moved past
 * its newest snapshot; the tip's set is recorded so later heights resolve,
 * while heights in the gap stay unknown rather than guessed.
 *
 * @returns The height a snapshot was written at, or null when none was needed
 * @throws ValidatorSetHistoryError when the fork applies to the next block
 *   and the set it is drawn from was never recorded here
 */
export async function ensureValidatorSetSnapshot(
    tip: number,
): Promise<number | null> {
    const ds = await dataSource()
    return await ds.transaction(async em => {
        const repo = em.getRepository(ValidatorSetSnapshots)
        await repo.delete({ block: MoreThan(tip) })

        // The pool for tip + 1 is drawn from the set after tip - 1, which the
        // live table can no longer tell: without it this node could never
        // verify the next block, so it stops here instead of stalling.
        if (
            tip >= 2 &&
            isForkActive("finalityProofs", tip + 1) &&
            !(await latestAtOrBelow(em, tip - 1))
        ) {
            throw new ValidatorSetHistoryError(
                `[BOOT] finalityProofs is active at block ${tip + 1}, but this database holds no ` +
                    `validator set snapshot at or below block ${tip - 1}, which the committee for block ` +
                    `${tip + 1} is drawn from. The validators table only holds the present, so the history ` +
                    "cannot be rebuilt in place. Resync this node from genesis (empty chain database), or " +
                    "restore a database backup that includes the validator_set_snapshots table.",
            )
        }

        const validators = await liveRecord(em)
        const setHash = validatorSetHash(validators)
        const latest = await latestAtOrBelow(em, tip)
        if (latest?.setHash === setHash) {
            return null
        }
        // A snapshot at the tip was committed with the tip block: the next
        // block commits to its hash, so the drifted table must not replace it.
        if (latest?.block === tip && tip > 0) {
            log.error(
                `[finality] validators table differs from the set committed with block ${tip} ` +
                    `(${latest.setHash}, table gives ${setHash}); keeping the committed set. ` +
                    "The table has drifted from the chain.",
            )
            return null
        }
        if (latest && tip > 0) {
            log.warning(
                `[finality] validator set at tip ${tip} differs from the snapshot at ${latest.block}; ` +
                    `recording it at ${tip}, heights ${latest.block + 1}..${tip - 1} keep the older set`,
            )
        }
        await repo.upsert({ block: tip, setHash, validators }, ["block"])
        log.info(
            `[finality] validator set recorded at block ${tip}: ${validators.length} rows, ${setHash}`,
        )
        return tip
    })
}

/** Drops every snapshot above `height`, with the blocks they followed. */
export async function pruneValidatorSetSnapshots(height: number): Promise<void> {
    await (await dataSource())
        .getRepository(ValidatorSetSnapshots)
        .delete({ block: MoreThan(height) })
}

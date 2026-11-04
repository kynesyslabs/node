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
import { isForkActive } from "@/forks/forkGates"
import { Validators } from "src/model/entities/Validators"
import {
    ValidatorSetSnapshots,
    type ValidatorSetEntry,
} from "src/model/entities/ValidatorSetSnapshots"
import log from "src/utilities/logger"
import { validatorSetHash, validatorSetRecord } from "./validatorSetRecord"

export {
    activeIdentities,
    validatorSetHash,
    validatorSetRecord,
} from "./validatorSetRecord"

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
    if (previous && previous.setHash === setHash) {
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
        if (latest && latest.setHash === setHash) {
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

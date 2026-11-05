/**
 * The validator set record a block's `validator_set_hash` commits to, and the
 * identities it admits to a committee. Pure functions of the record, shared
 * by the snapshot writer and by any client that checks a committed set
 * without a database.
 */

import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "src/libs/crypto/jcs"
import { compareCodeUnits } from "src/libs/crypto/canonicalJson"
import { VALIDATOR_STATUS_ACTIVE } from "@/features/staking/constants"
import type { Validators } from "src/model/entities/Validators"
import type { ValidatorSetEntry } from "src/model/entities/ValidatorSetSnapshots"

export type ValidatorRow = Pick<
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

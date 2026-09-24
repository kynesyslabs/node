import Hashing from "@/libs/crypto/hashing"
import { domainDigest } from "@/libs/atomic-work/digest"

/**
 * Writing to storage from inside an atomic Work.
 *
 * Two rules separate this from an ordinary put.
 *
 * The address is derived, never accepted. A caller that names its own address
 * can write over an entry belonging to someone else, or claim an address a
 * later Work was going to derive for itself. Here the address is a function of
 * authenticated inputs — who is writing, under what name, and a discriminator
 * they cannot reuse — so two different writers cannot land on one address and
 * one writer cannot pretend to be another.
 *
 * A write declares whether it may replace what is there. `create-only` fails
 * if anything exists, and `compare-and-set` fails unless what is there is
 * exactly what the writer believed. There is no third mode: a blind overwrite
 * inside a Work that may roll back is how one attempt quietly destroys the
 * state another attempt is about to be judged against.
 *
 * Nothing here touches storage. It decides whether a write is allowed and what
 * the write commits to, so the overlay can stage it and the receipt can bind
 * it.
 */

export const STORAGE_ADDRESS_PREFIX = "stor-"

export type StorageWriteMode = "create-only" | "compare-and-set"

export interface StorageWriteIntent {
    address: string
    /** Digest of the value being written; the value itself is not needed here. */
    valueDigest: string
    mode: StorageWriteMode
    /** Required by `compare-and-set`: the digest the writer believes is there. */
    expectedPriorDigest?: string | null
}

/** What storage currently holds at an address, or undefined when vacant. */
export interface StorageEntryView {
    valueDigest: string
}

export class StorageWriteError extends Error {
    constructor(
        message: string,
        readonly reason:
            | "address-not-derived"
            | "exists"
            | "missing-expectation"
            | "stale-expectation"
            | "vacant",
        readonly address: string,
    ) {
        super(message)
        this.name = "StorageWriteError"
    }
}

/**
 * The address a writer gets, given what they are authenticated as.
 *
 * `discriminator` is whatever the profile uses to keep one writer's entries
 * apart — a nonce, a sequence, an operation id. It is part of the derivation,
 * not a suffix, so changing it cannot produce a collision with a different
 * writer's address.
 */
export function deriveStorageAddress(
    domain: string,
    writer: string,
    name: string,
    discriminator: string,
): string {
    const digest = domainDigest(domain, { writer, name, discriminator })
    return `${STORAGE_ADDRESS_PREFIX}${digest.slice(0, 40)}`
}

/** Does this address belong to this writer, under this name and discriminator? */
export function isDerivedStorageAddress(
    address: string,
    domain: string,
    writer: string,
    name: string,
    discriminator: string,
): boolean {
    return address === deriveStorageAddress(domain, writer, name, discriminator)
}

/**
 * Refuse a write whose address the writer could not have derived.
 *
 * Checked before the mode is even considered: an address that is not this
 * writer's is not theirs to create *or* to replace.
 */
export function assertDerivedAddress(
    intent: StorageWriteIntent,
    domain: string,
    writer: string,
    name: string,
    discriminator: string,
): void {
    if (!isDerivedStorageAddress(intent.address, domain, writer, name, discriminator)) {
        throw new StorageWriteError(
            `storage address '${intent.address}' is not the address this writer derives ` +
                "from its authenticated inputs",
            "address-not-derived",
            intent.address,
        )
    }
}

/** Decide whether this write may proceed against what is currently stored. */
export function assertStorageWriteAllowed(
    current: StorageEntryView | undefined,
    intent: StorageWriteIntent,
): void {
    if (intent.mode === "create-only") {
        if (current) {
            throw new StorageWriteError(
                `storage address '${intent.address}' already holds a value and this write is create-only`,
                "exists",
                intent.address,
            )
        }
        return
    }

    if (typeof intent.expectedPriorDigest !== "string" || intent.expectedPriorDigest.length === 0) {
        throw new StorageWriteError(
            `a compare-and-set write to '${intent.address}' must say what it expects to replace`,
            "missing-expectation",
            intent.address,
        )
    }
    if (!current) {
        throw new StorageWriteError(
            `storage address '${intent.address}' holds nothing to compare against`,
            "vacant",
            intent.address,
        )
    }
    if (current.valueDigest !== intent.expectedPriorDigest) {
        throw new StorageWriteError(
            `storage address '${intent.address}' changed since this write was prepared`,
            "stale-expectation",
            intent.address,
        )
    }
}

/**
 * What the receipt binds for this write.
 *
 * The prior digest is part of it on purpose: a proof that only names the new
 * value says nothing about what was replaced, and "created" and "overwrote
 * something" are different claims.
 */
export function storageWriteOutput(
    intent: StorageWriteIntent,
    current: StorageEntryView | undefined,
    domain: string,
): { address: string; mode: StorageWriteMode; priorDigest: string | null; valueDigest: string; outputHash: string } {
    const priorDigest = current?.valueDigest ?? null
    return {
        address: intent.address,
        mode: intent.mode,
        priorDigest,
        valueDigest: intent.valueDigest,
        outputHash: domainDigest(domain, {
            address: intent.address,
            mode: intent.mode,
            priorDigest,
            valueDigest: intent.valueDigest,
        }),
    }
}

/** Digest of a stored value, for callers that hold the value itself. */
export function storageValueDigest(value: unknown): string {
    return Hashing.sha256(JSON.stringify(value ?? null))
}

/**
 * The block insert writes a `transactions` row for every transaction a block
 * lists, inside the block's database transaction. A value that makes
 * toRawTransaction throw, or that Postgres refuses, fails that transaction
 * on every node and stops the chain, so block verification and the mempool
 * merge refuse exactly those values, and nothing a committed block can hold.
 *
 * The Postgres rules below were confirmed on the image the compose files
 * pin (postgres:16-alpine@sha256:0cefaabd…, PostgreSQL 16.15). With
 * STORABLE_PG_URL set to an empty database, the last block replays every
 * case through the real insert.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

import { DataSource } from "typeorm"
import { Transactions } from "@/model/entities/Transactions"
import {
    entityBigint,
    isInt8Text,
    ROW_VALUE_MAX_DEPTH,
    transactionRowRefusal,
} from "./postgresStorable"

const { default: Transaction, toTransactionsEntity } = await import("src/libs/blockchain/transaction")

const ACCOUNT = "0x" + "ab".repeat(32)
let serial = 0

/** A transaction as an SDK client signs it and a node stores it. */
function honest(edit: (tx: any) => void = () => {}): any {
    const tx: any = {
        hash: (++serial).toString(16).padStart(64, "0"),
        signature: { type: "ed25519", data: "ef".repeat(64) },
        ed25519_signature: null,
        status: "confirmed",
        blockNumber: 7,
        content: {
            type: "native",
            from: ACCOUNT,
            from_ed25519_address: ACCOUNT,
            to: ACCOUNT,
            amount: 0,
            data: ["native", {}],
            gcr_edits: [],
            nonce: 1,
            timestamp: 1_760_000_000_000,
            transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
        },
    }
    edit(tx)
    return tx
}

/**
 * The row chainBlocks.insertBlock builds, from the plain object it spreads.
 * toRawTransaction rewrites content.to and content.from, so content is
 * copied.
 */
const insertRow = (tx: any) => toTransactionsEntity(Transaction.toRawTransaction({ ...tx, content: tx.content && { ...tx.content } }))

const nested = (depth: number, leaf: unknown = 1): unknown => {
    let value = leaf
    for (let i = 0; i < depth; i++) value = [value]
    return value
}

const set = (path: string, value: unknown) => (tx: any) => {
    const keys = path.split(".")
    const last = keys.pop()!
    const parent = keys.reduce((node, key) => node[key], tx)
    if (value === undefined) delete parent[last]
    else parent[last] = value
}

/** Refused, with the column the refusal names and where the insert fails. */
const REFUSED: Array<[string, (tx: any) => void, string, "throws" | "postgres"]> = [
    ["no recipient", set("content.to", undefined), "to", "throws"],
    ["a null recipient", set("content.to", null), "to", "throws"],
    ["a null sender", set("content.from", null), "from", "throws"],
    ["a recipient whose data is a number", set("content.to", { data: 5 }), "to", "throws"],
    ["a sender whose data is a number", set("content.from", { type: "Buffer", data: 0 }), "from", "throws"],
    ["a recipient whose data has its own toString", set("content.to", { data: { toString: 1 } }), "to", "throws"],
    ["a Buffer JSON whose byte has its own toString", set("content.to", { type: "Buffer", data: [{ toString: "x" }] }), "to", "throws"],
    ["no transaction_fee", set("content.transaction_fee", undefined), "transaction_fee", "throws"],
    ["a null transaction_fee", set("content.transaction_fee", null), "transaction_fee", "throws"],
    ["no type", set("content.type", undefined), "type", "postgres"],
    ["a null type", set("content.type", null), "type", "postgres"],
    ["a null hash", set("hash", null), "hash", "postgres"],
    ["no signature", set("signature", undefined), "signature", "postgres"],
    ["no timestamp", set("content.timestamp", undefined), "timestamp", "postgres"],
    ["a null timestamp", set("content.timestamp", null), "timestamp", "postgres"],
    ["a fractional timestamp", set("content.timestamp", 1.5), "timestamp", "postgres"],
    ["a timestamp the driver sends as 1e+21", set("content.timestamp", 1e21), "timestamp", "postgres"],
    ["a timestamp past int8", set("content.timestamp", "9223372036854775808"), "timestamp", "postgres"],
    ["a hex timestamp past int8", set("content.timestamp", "0x8000000000000000"), "timestamp", "postgres"],
    ["a text timestamp", set("content.timestamp", "abc"), "timestamp", "postgres"],
    ["a timestamp with a decimal point", set("content.timestamp", "1.0"), "timestamp", "postgres"],
    ["a boolean timestamp", set("content.timestamp", true), "timestamp", "postgres"],
    ["an object timestamp", set("content.timestamp", { t: 1 }), "timestamp", "postgres"],
    ["an array timestamp", set("content.timestamp", [1]), "timestamp", "postgres"],
    ["a fractional nonce", set("content.nonce", 1.5), "nonce", "postgres"],
    ["an exponent nonce", set("content.nonce", "1e3"), "nonce", "postgres"],
    ["a boolean nonce", set("content.nonce", false), "nonce", "postgres"],
    ["an empty array nonce", set("content.nonce", []), "nonce", "postgres"],
    ["a fractional amount", set("content.amount", 1.5), "amount", "throws"],
    ["a text amount", set("content.amount", "abc"), "amount", "throws"],
    ["an amount with a decimal point", set("content.amount", "1.0"), "amount", "throws"],
    ["an object amount", set("content.amount", {}), "amount", "throws"],
    ["an amount whose element has its own toString", set("content.amount", [{ toString: 1 }]), "amount", "throws"],
    ["an amount of 10^38", set("content.amount", "1" + "0".repeat(38)), "amount", "postgres"],
    ["an amount of -10^38", set("content.amount", "-1" + "0".repeat(38)), "amount", "postgres"],
    ["an amount of 1e39", set("content.amount", 1e39), "amount", "postgres"],
    ["a hex amount past 10^38", set("content.amount", "0x" + "f".repeat(32)), "amount", "postgres"],
    ["an amount of a million digits", set("content.amount", "9".repeat(1_000_000)), "amount", "postgres"],
    ["a text network fee", set("content.transaction_fee.network_fee", "abc"), "network_fee", "throws"],
    ["a fractional rpc fee", set("content.transaction_fee.rpc_fee", 1.5), "rpc_fee", "throws"],
    ["an object additional fee", set("content.transaction_fee.additional_fee", { a: 1 }), "additional_fee", "throws"],
    ["an rpc fee past 10^38", set("content.transaction_fee.rpc_fee", "9".repeat(39)), "rpc_fee", "postgres"],
]

/** History a block may hold: every one of these inserts. */
const ACCEPTED: Array<[string, (tx: any) => void]> = [
    ["an honest transfer", () => {}],
    ["a bare hex recipient", set("content.to", "ab".repeat(32))],
    ["a Buffer JSON recipient", set("content.to", { type: "Buffer", data: Array(32).fill(171) })],
    ["a Buffer JSON sender", set("content.from", { type: "Buffer", data: Array(32).fill(171) })],
    ["a served genesis recipient", set("content.to", { type: "ed25519", data: {} })],
    ["a recipient with empty data", set("content.to", { data: "" })],
    ["a recipient with null data", set("content.to", { data: null })],
    ["an empty recipient", set("content.to", "")],
    ["a numeric recipient", set("content.to", 5)],
    ["a timestamp as text", set("content.timestamp", "1760000000000")],
    ["a timestamp with whitespace", set("content.timestamp", " 1760000000000\n")],
    ["a signed timestamp", set("content.timestamp", "+5")],
    ["a hex timestamp", set("content.timestamp", "0x10")],
    ["a timestamp with underscores", set("content.timestamp", "1_000")],
    ["a negative timestamp", set("content.timestamp", -1)],
    ["int8's largest timestamp", set("content.timestamp", "9223372036854775807")],
    ["no nonce", set("content.nonce", undefined)],
    ["a null nonce", set("content.nonce", null)],
    ["a nonce as text", set("content.nonce", "7")],
    ["a binary nonce", set("content.nonce", "0b101")],
    ["an OS string amount", set("content.amount", "1000000000")],
    ["an amount with whitespace", set("content.amount", " 12 ")],
    ["a hex amount", set("content.amount", "0x1f")],
    ["an empty amount", set("content.amount", "")],
    ["an amount padded with zeros", set("content.amount", "0".repeat(100_000) + "5")],
    ["a boolean amount", set("content.amount", true)],
    ["an array amount", set("content.amount", ["5"])],
    ["a negative amount", set("content.amount", -5)],
    ["no amount", set("content.amount", undefined)],
    ["an amount of 38 nines", set("content.amount", "9".repeat(38))],
    ["an amount of 1e38", set("content.amount", 1e38)],
    ["fees as null, as on rows before the fee fork", set("content.transaction_fee", { network_fee: null, rpc_fee: null, additional_fee: null })],
    ["fees as OS strings", set("content.transaction_fee", { network_fee: "1000", rpc_fee: "0", additional_fee: "0", rpc_address: ACCOUNT })],
    ["a null signature", set("signature", null)],
    ["a transaction_fee that is not an object", set("content.transaction_fee", "x")],
]

describe("the transactions row the block insert writes", () => {
    for (const [name, edit, column, where] of REFUSED) {
        it(`refuses ${name}`, () => {
            const tx = honest(edit)
            expect(transactionRowRefusal(tx)).toContain(column)
            if (where === "throws") expect(() => insertRow(tx)).toThrow()
        })
    }

    for (const [name, edit] of ACCEPTED) {
        it(`accepts ${name}`, () => {
            const tx = honest(edit)
            expect(transactionRowRefusal(tx)).toBeNull()
            expect(() => insertRow(tx)).not.toThrow()
        })
    }
})

describe("nesting in the row's own values", () => {
    it("is capped where the insert's recursion is still far from the stack", () => {
        const at = (depth: number) => honest(set("content.to", { data: nested(depth - 1) }))
        expect(transactionRowRefusal(at(ROW_VALUE_MAX_DEPTH))).toBeNull()
        expect(transactionRowRefusal(at(ROW_VALUE_MAX_DEPTH + 1))).toContain("to nests")
        expect(transactionRowRefusal(honest(set("content.amount", nested(ROW_VALUE_MAX_DEPTH + 1))))).toContain("amount nests")
        expect(transactionRowRefusal(honest(set("content.type", nested(ROW_VALUE_MAX_DEPTH + 1))))).toContain("type nests")
    })

    it("refuses what the insert's recursion runs out of stack on", () => {
        // join() of the Buffer data recurses once per level.
        const deepTo = honest(set("content.to", { data: nested(10_000) }))
        expect(() => insertRow(deepTo)).toThrow(RangeError)
        expect(transactionRowRefusal(deepTo)).toContain("to nests")
        // The signature is not hashed and goes through JSON.stringify.
        const deepSignature = honest(set("signature", { type: "ed25519", data: "ef".repeat(64), x: nested(50_000) }))
        expect(() => insertRow(deepSignature)).toThrow(RangeError)
        expect(transactionRowRefusal(deepSignature)).toContain("signature nests")
    })
})

/**
 * Text sent to an int8 column and whether PostgreSQL 16.15 took it, as
 * observed on the pinned image.
 */
const PG16_INT8: Array<[string, boolean]> = [
    ["0", true], ["-0", true], ["+0", true], ["-1", true], ["+1", true], ["007", true], ["  12  ", true],
    ["9223372036854775807", true], ["-9223372036854775808", true], ["0".repeat(500) + "1", true],
    ["0x10", true], ["0X10", true], ["-0x10", true], ["+0x10", true], ["0x_1", true], ["0x1_0", true],
    ["0x7fffffffffffffff", true], ["-0x8000000000000000", true], ["0o17", true], ["0O17", true], ["0o_7", true],
    ["0b101", true], ["0B1", true], ["0b_1", true], ["0b" + "1".repeat(63), true],
    ["1_000", true], ["+1_0", true], ["1_0_0", true], ["00_1", true],
    [" 5", true], ["\t5", true], ["\n5", true], ["\v5", true], ["\f5", true], ["\r5", true], ["5\r", true], ["5\v", true],
    ["", false], [" ", false], ["+", false], ["-", false], ["--1", false], ["+-1", false], ["1 2", false],
    ["1.0", false], ["1.", false], [".1", false], ["0.0", false], ["1e3", false], ["1E3", false], ["1e+21", false],
    ["9223372036854775808", false], ["-9223372036854775809", false], ["0x8000000000000000", false],
    ["-0x8000000000000001", false], ["0x" + "f".repeat(70), false], ["9".repeat(80), false], ["0b" + "1".repeat(64), false],
    ["0x", false], ["0o", false], ["0b", false], ["0x1__0", false], ["0x1_", false], ["0xg", false], ["0o8", false], ["0b2", false],
    ["1__000", false], ["_1", false], ["1_", false], ["-_1", false], ["0_x10", false],
    ["- 5", false], ["-\t5", false], [" 5", false], ["5 ", false], ["﻿5", false], [" 5", false],
    ["١٢", false], ["１２", false], ["abc", false], ["true", false], ["NaN", false], ["Infinity", false],
]

describe("int8 input as Postgres 16 reads it", () => {
    it("agrees with every value confirmed on the pinned image", () => {
        for (const [text, accepted] of PG16_INT8) {
            expect([text, isInt8Text(text)]).toEqual([text, accepted])
        }
    })
})

describe("the amount and fee columns", () => {
    it("read a value the way the insert's BigInt() does", () => {
        expect(entityBigint(null)).toBe(0n)
        expect(entityBigint(undefined)).toBe(0n)
        expect(entityBigint("  ﻿12 ")).toBe(12n)
        expect(entityBigint([[" 0x1f "]])).toBe(31n)
        expect(entityBigint([])).toBe(0n)
        expect(entityBigint(false)).toBe(0n)
        expect(entityBigint("0x" + "f".repeat(200))).toBeUndefined()
        expect(entityBigint("-0x1")).toBeUndefined()
        expect(entityBigint(Number.NaN)).toBeUndefined()
        expect(entityBigint(Infinity)).toBeUndefined()
    })
})

const PG_URL = process.env.STORABLE_PG_URL

describe.skipIf(!PG_URL)("the real insert", () => {
    let db: DataSource

    beforeAll(async () => {
        db = new DataSource({
            type: "postgres",
            url: PG_URL,
            entities: [Transactions],
            synchronize: true,
            dropSchema: true,
        })
        await db.initialize()
    })

    afterAll(async () => {
        await db?.destroy()
    })

    // As chainDb.chunkedInsert writes a block's rows.
    const insert = async (tx: any) => {
        await db.transaction(async em => {
            await em.createQueryBuilder().insert().into(Transactions).values([insertRow(tx)]).orIgnore().execute()
        })
    }

    for (const [name, edit, column] of REFUSED) {
        it(`fails on ${name}, which is refused`, async () => {
            const tx = honest(edit)
            expect(transactionRowRefusal(tx)).toContain(column)
            await expect(insert(tx)).rejects.toThrow()
        })
    }

    for (const [name, edit] of ACCEPTED) {
        it(`stores ${name}, which is accepted`, async () => {
            const tx = honest(edit)
            expect(transactionRowRefusal(tx)).toBeNull()
            await insert(tx)
        })
    }
})

/**
 * A batch of transactions is judged one by one. What a batch holds is typed
 * as transactions without being checked to be any, so an entry may lack a
 * signature object or a readable signer address: it is refused or left
 * undecided on its own, and the others keep their verdicts.
 *
 * The identity lookup runs over a stubbed repository; validateTx and the pool
 * are the real ones, the pool both on its inline path and with a started
 * worker.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mockDatasource, mockLogger } from "@/utilities/testSupport/coreMocks"
import Hashing from "../../crypto/hashing"

mockLogger()
mockLogger("src/utilities/logger")

const SIGNER = "0x" + "ab".repeat(32)
const PQC_KEY = "0x" + "cd".repeat(48)
const RECIPIENT = "0x" + "ef".repeat(32)
const RECORD = { address: PQC_KEY, signature: "0x" + "ee".repeat(64), timestamp: 1 }

let rows: Array<{ pubkey: string; identities: unknown }> = []
let lookups: string[][] = []

mockDatasource({
    find: async (query: { where: { pubkey: { value: string[] } } }) => {
        lookups.push(query.where.pubkey.value)
        return rows
    },
})

const { default: prefetchIdentities } = await import("./prefetchIdentities")
const { validateTx } = await import("./txValidator")
const poolClass = (await import("./txValidatorPool")).default
const { getSharedState } = await import("@/utilities/sharedState")

const domain = { active: false, chainId: 0 }

/** Signed by a PQC key alone, so its signer's identity record is looked up. */
const pqcOnly = (hash: string, over: Record<string, unknown> = {}) =>
    ({
        hash,
        content: { from: PQC_KEY, from_ed25519_address: SIGNER },
        signature: { type: "falcon", data: "0x00" },
        ...over,
    }) as never

/**
 * A body the row check passes, under the hash the legacy rule gives it, so
 * that the signature check is reached. Its signature is not a real one.
 */
function coherent(over: Record<string, unknown> = {}, content: Record<string, unknown> = {}) {
    const body = {
        type: "native",
        from: SIGNER,
        from_ed25519_address: SIGNER,
        to: RECIPIENT,
        amount: 0,
        nonce: 1,
        timestamp: 1_760_000_000_000,
        data: ["native", { nativeOperation: "send", args: [RECIPIENT, "1"] }],
        gcr_edits: [],
        transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0 },
        ...content,
    }
    return {
        hash: Hashing.sha256(JSON.stringify(body)),
        content: body,
        signature: { type: "ed25519", data: "0x" + "00".repeat(64) },
        ...over,
    } as never
}

/** Coherent, and its two signer addresses are numbers the ed25519 rule cannot compare. */
const unreadableSigner = () => coherent({}, { from: 5, from_ed25519_address: 5 })

beforeEach(() => {
    rows = [{ pubkey: SIGNER, identities: { pqc: { falcon: [RECORD] } } }]
    lookups = []
})

describe("prefetchIdentities over a batch", () => {
    it("finds the record of a well-formed PQC-only transaction", async () => {
        expect(await prefetchIdentities([pqcOnly("a")])).toEqual({ a: RECORD })
        expect(lookups).toEqual([[SIGNER]])
    })

    it("serves the rest of the batch when one transaction has an unreadable signature", async () => {
        const batch = [
            pqcOnly("bad1", { signature: null }),
            pqcOnly("bad2", { signature: undefined }),
            pqcOnly("a"),
        ]
        expect(await prefetchIdentities(batch)).toEqual({ a: RECORD })
        expect(lookups).toEqual([[SIGNER]])
    })

    it("does not look up a signature type that is not a string", async () => {
        const batch = [
            pqcOnly("bad1", { signature: { type: ["falcon"], data: "00" } }),
            pqcOnly("bad2", { signature: { type: { toString: 0 }, data: "00" } }),
            pqcOnly("bad3", { signature: { data: "00" } }),
            pqcOnly("bad4", { signature: "falcon" }),
            pqcOnly("a"),
        ]
        expect(await prefetchIdentities(batch)).toEqual({ a: RECORD })
        expect(lookups).toEqual([[SIGNER]])
    })

    it("gives no record for a signature type the account holds no list under", async () => {
        // Three names every object answers to and one the account has no keys of.
        for (const type of ["constructor", "__proto__", "toString", "dilithium"]) {
            const other = pqcOnly("other", { signature: { type, data: "00" } })
            expect(await prefetchIdentities([other, pqcOnly("a")])).toEqual({ other: null, a: RECORD })
        }
    })

    it("gives no record when what the account holds under the type is not a list", async () => {
        rows = [{ pubkey: SIGNER, identities: { pqc: { falcon: { address: PQC_KEY } } } }]
        expect(await prefetchIdentities([pqcOnly("a")])).toEqual({ a: null })
    })

    it("does not look up a signer address that is not a string", async () => {
        const batch = [
            pqcOnly("bad1", { content: { from: PQC_KEY } }),
            pqcOnly("bad2", { content: { from: PQC_KEY, from_ed25519_address: 5 } }),
            pqcOnly("bad3", { content: null }),
            pqcOnly("a"),
        ]
        expect(await prefetchIdentities(batch)).toEqual({ a: RECORD })
        expect(lookups).toEqual([[SIGNER]])
    })
})

describe("validateTx on a transaction it cannot read", () => {
    it("refuses a null signature", async () => {
        const verdict = await validateTx(coherent({ signature: null }), null, false, domain)
        expect(verdict).toMatchObject({ valid: false, reason: "Transaction signature is null" })
        expect(verdict.undecided).toBeUndefined()
    })

    it("leaves one a check throws on undecided instead of throwing", async () => {
        // The row check and the hash pass; comparing the two signer addresses
        // of an ed25519 transaction throws when they are not strings.
        const tx = unreadableSigner()
        const verdict = await validateTx(tx, null, false, domain)
        expect(verdict).toMatchObject({ hash: (tx as { hash: string }).hash, valid: false, undecided: true })
        expect(verdict.reason).toContain("could not be judged")
    })

    it("judges a well-formed transaction as before", async () => {
        // A coherent body under a signature that is not its signer's.
        const verdict = await validateTx(coherent(), null, false, domain)
        expect(verdict).toMatchObject({ valid: false, reason: "Transaction signature verification failed" })
        expect(verdict.undecided).toBeUndefined()
    })
})

describe("TxValidatorPool on a batch holding some", () => {
    /** One of each kind above, then a well-formed transaction under a signature that is not its signer's. */
    const batch = () => [
        coherent({ signature: null }),
        { ...(coherent() as any), hash: "00".repeat(32) },
        unreadableSigner(),
        coherent({ signature: { type: "constructor", data: "00" } }),
        coherent({ signature: { type: { toString: 0 }, data: "00" } }),
        coherent(),
    ]

    async function expectOwnVerdicts(pool: any) {
        const txs = batch() as any[]
        const results = await pool.validate(txs, false, domain)
        expect(results.map((r: any) => r.hash)).toEqual(txs.map(tx => tx.hash))
        expect(results.map((r: any) => [r.valid, r.undecided === true])).toEqual([
            [false, false],
            [false, false],
            [false, true],
            [false, false],
            [false, false],
            [false, false],
        ])
        expect(results[0].reason).toBe("Transaction signature is null")
        expect(results[1].reason).toBe("Transaction is not coherent")
        expect(results[2].reason).toContain("could not be judged")
        expect(results[3].reason).toContain("the PQC signer is not added as an identity")
        expect(results[4].reason).toContain("the PQC signer is not added as an identity")
        expect(results[5].reason).toBe("Transaction signature verification failed")
    }

    it("gives each transaction its own verdict when judging inline", async () => {
        await expectOwnVerdicts(new (poolClass as any)())
    })

    it("gives each transaction its own verdict when judging in a worker", async () => {
        getSharedState.identity = { masterSeed: new Uint8Array(128).fill(7) } as never
        const pool = new (poolClass as any)()
        const judgedInline = spyOn(pool, "validateInline")
        await pool.start(1)
        try {
            await expectOwnVerdicts(pool)
            expect(judgedInline).not.toHaveBeenCalled()
        } finally {
            await pool.stop()
        }
    })
})

/**
 * A block's hash commits to transaction hashes only. These checks are what
 * binds the bodies, statuses and native-table state a peer serves to it.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { createHash, sign as edSign } from "node:crypto"
import { EXPIRED_TX_DEEP_WINDOW_MULTIPLIER } from "../referenceBlockWindow"
import {
    makeSignedTx,
    newAccount,
    type TestAccount,
} from "../testSupport/signedTx"

const getExistingTransactionHashes = jest.fn(
    async (_hashes: string[]) => new Set<string>(),
)
const getAccountNonces = jest.fn(
    async (_accounts: string[]) => ({}) as Record<string, number>,
)
const hashGCRTables = jest.fn(async (_height: number) => ({}) as any)

mock.module("../chain", () => ({
    __esModule: true,
    default: { getExistingTransactionHashes },
}))
mock.module("../gcr/gcr", () => ({
    __esModule: true,
    default: { getAccountNonces },
}))
mock.module("../gcr/gcr_routines/hashGCR", () => ({
    __esModule: true,
    default: hashGCRTables,
}))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

// The pool is the node's worker pool; here it runs the same validation the
// workers run, inline and with no identity hints.
const { validateTx } = await import("../validation/txValidator")
const { unifiedCrypto: ucrypto, hexToUint8Array } = await import(
    "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js"
)
mock.module("../validation/txValidatorPool", () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            verify: async (signed: any) => ucrypto.verify(signed),
            validate: async (txs: any[], isPostFork: boolean, domain: any) =>
                Promise.all(txs.map(tx => validateTx(tx, null, isPostFork, domain))),
        }),
    },
}))

const { getSharedState } = await import("@/utilities/sharedState")
const {
    SyncBlockRejectedError,
    localStatuses,
    planBlockOutcome,
    statusDisagreements,
    verifyBlockTransactions,
    verifyNativeTablesHashes,
} = await import("./syncVerification")

const HEIGHT = 12

const alice = newAccount()
const bob = newAccount()
const mallory = newAccount()

interface TxOptions {
    nonce?: number
    status?: string
    attrs?: Record<string, unknown>
    signer?: TestAccount
}

const makeTx = (sender = alice, options: TxOptions = {}) =>
    makeSignedTx(sender, bob, { ...options, height: HEIGHT })

function makeBlock(
    txs: any[],
    nativeTablesHashes: any = { native_subnets_txs: "a" },
    number = HEIGHT,
) {
    return {
        number,
        hash: "block-hash",
        content: {
            ordered_transactions: txs.map(tx => tx.hash),
            native_tables_hashes: nativeTablesHashes,
        },
    } as any
}

const forkConfigAtStart = structuredClone(getSharedState.forkConfig)
const chainIdAtStart = getSharedState.chainId

afterEach(() => {
    getSharedState.forkConfig = structuredClone(forkConfigAtStart)
    getSharedState.chainId = chainIdAtStart
})

beforeEach(() => {
    getExistingTransactionHashes.mockReset()
    getExistingTransactionHashes.mockResolvedValue(new Set())
    getAccountNonces.mockReset()
    getAccountNonces.mockImplementation(async (accounts: string[]) =>
        Object.fromEntries(accounts.map(a => [a, 0])),
    )
    hashGCRTables.mockReset()
    hashGCRTables.mockResolvedValue({ native_subnets_txs: "a" })
    getSharedState.referenceBlockRoom = 1
})

describe("verifyBlockTransactions", () => {
    it("accepts bodies that hash to the committed hashes and carry valid signatures", async () => {
        const txs = [makeTx(alice, { nonce: 1 }), makeTx(bob, { nonce: 1 })]
        await verifyBlockTransactions(makeBlock(txs), txs)
    })

    it("rejects a body altered after the block committed to its hash", async () => {
        const tx = makeTx()
        const block = makeBlock([tx])
        tx.content.amount = "999999"
        tx.content.data[1].args[1] = "999999"

        const rejection = await verifyBlockTransactions(block, [tx]).catch(e => e)

        expect(rejection).toBeInstanceOf(SyncBlockRejectedError)
        expect(rejection.message).toContain(tx.hash)
        expect(rejection.message).toContain("not coherent")
    })

    it("rejects a transaction signed by someone other than its sender", async () => {
        const tx = makeTx(alice, { signer: mallory })
        const rejection = await verifyBlockTransactions(makeBlock([tx]), [tx]).catch(e => e)

        expect(rejection).toBeInstanceOf(SyncBlockRejectedError)
        expect(rejection.message).toContain(tx.hash)
        expect(rejection.message).toMatch(/signature/i)
    })

    it("rejects a served set that omits, adds or repeats a committed transaction", async () => {
        const [a, b] = [makeTx(alice, { nonce: 1 }), makeTx(alice, { nonce: 2 })]
        const extra = makeTx(bob, { nonce: 1 })
        const block = makeBlock([a, b])

        for (const served of [[a], [a, b, extra], [a, a]]) {
            const rejection = await verifyBlockTransactions(block, served).catch(e => e)
            expect(rejection).toBeInstanceOf(SyncBlockRejectedError)
        }
    })

    it("accepts an empty block without calling the validator", async () => {
        await verifyBlockTransactions(makeBlock([]), [])
    })
})

describe("verifyNativeTablesHashes", () => {
    it("accepts hashes equal to the local ones, computed for the block's height", async () => {
        await verifyNativeTablesHashes(makeBlock([]))
        expect(hashGCRTables).toHaveBeenCalledWith(HEIGHT)
    })

    it("rejects a table hash that differs", async () => {
        const rejection = await verifyNativeTablesHashes(
            makeBlock([], { native_subnets_txs: "tampered" }),
        ).catch(e => e)

        expect(rejection).toBeInstanceOf(SyncBlockRejectedError)
        expect(rejection.message).toContain("native_subnets_txs")
    })

    it("rejects a block missing a table the local state hashes, and the reverse", async () => {
        hashGCRTables.mockResolvedValue({ native_subnets_txs: "a", native_atomic_work: "w" })
        await expect(verifyNativeTablesHashes(makeBlock([]))).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )

        hashGCRTables.mockResolvedValue({})
        await expect(verifyNativeTablesHashes(makeBlock([]))).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })

    it("leaves the TLSNotary entry out, whose hash carries a node-local timestamp, and compares the rest strictly", async () => {
        hashGCRTables.mockResolvedValue({
            native_subnets_txs: "a",
            native_tlsnotary: "local-clock",
        })

        await verifyNativeTablesHashes(
            makeBlock([], { native_subnets_txs: "a", native_tlsnotary: "forger-clock" }),
        )
        await verifyNativeTablesHashes(makeBlock([], { native_subnets_txs: "a" }))

        const rejection = await verifyNativeTablesHashes(
            makeBlock([], { native_subnets_txs: "b", native_tlsnotary: "local-clock" }),
        ).catch(e => e)
        expect(rejection).toBeInstanceOf(SyncBlockRejectedError)
        expect(rejection.message).toContain("native_subnets_txs")
        expect(rejection.message).not.toContain("native_tlsnotary")
    })

    it("rejects a block that carries no table hashes", async () => {
        await expect(verifyNativeTablesHashes(makeBlock([], null))).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })
})

describe("planBlockOutcome", () => {
    it("applies every transaction that nothing excludes before apply, whatever status it was served with", async () => {
        const confirmed = makeTx(alice, { nonce: 1 })
        const failed = makeTx(bob, { nonce: 1, status: "failed" })

        const plan = await planBlockOutcome(makeBlock([confirmed, failed]), [confirmed, failed])

        expect(plan.toApply.map(tx => tx.hash).sort()).toEqual(
            [confirmed.hash, failed.hash].sort(),
        )
        expect(plan.failedBeforeApply.size).toBe(0)
    })

    it("rejects a status other than confirmed or failed", async () => {
        const tx = makeTx(alice, { status: "pending" })
        await expect(planBlockOutcome(makeBlock([tx]), [tx])).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })

    it("treats a stale nonce as failed before apply and refuses to see it confirmed", async () => {
        getAccountNonces.mockResolvedValue({ [alice.address]: 5 })
        const stale = makeTx(alice, { nonce: 3, status: "failed" })

        const plan = await planBlockOutcome(makeBlock([stale]), [stale])
        expect(plan.failedBeforeApply.get(stale.hash)).toBe("TX_NONCE_INVALID_LOW")
        expect(plan.toApply).toHaveLength(0)

        const claimedConfirmed = makeTx(alice, { nonce: 3, status: "confirmed" })
        await expect(
            planBlockOutcome(makeBlock([claimedConfirmed]), [claimedConfirmed]),
        ).rejects.toBeInstanceOf(SyncBlockRejectedError)
    })

    it("rejects a nonce ahead of the account, which a block cannot carry", async () => {
        const ahead = makeTx(alice, { nonce: 4 })
        await expect(planBlockOutcome(makeBlock([ahead]), [ahead])).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })

    it("counts consecutive nonces of one sender against the account nonce in order", async () => {
        const first = makeTx(alice, { nonce: 1 })
        const second = makeTx(alice, { nonce: 2 })
        const plan = await planBlockOutcome(makeBlock([first, second]), [second, first])

        expect(plan.toApply.map(tx => tx.content.nonce)).toEqual([1, 2])
    })

    it("treats an expired reference block as failed before apply", async () => {
        const expired = makeTx(alice, {
            status: "failed",
            attrs: { reference_block: HEIGHT - 4, code: "TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE" },
        })
        const plan = await planBlockOutcome(makeBlock([expired]), [expired])
        expect(plan.failedBeforeApply.get(expired.hash)).toBe(
            "TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE",
        )

        const claimedConfirmed = makeTx(alice, {
            attrs: { reference_block: HEIGHT - 4 },
        })
        await expect(
            planBlockOutcome(makeBlock([claimedConfirmed]), [claimedConfirmed]),
        ).rejects.toBeInstanceOf(SyncBlockRejectedError)
    })

    it("rejects a transaction older than any window the forger admits", async () => {
        const ancient = makeTx(alice, {
            status: "failed",
            attrs: { reference_block: 0 },
        })
        await expect(planBlockOutcome(makeBlock([ancient]), [ancient])).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })

    it("rejects a replay of a transaction already on chain served as confirmed", async () => {
        const replay = makeTx(alice)
        getExistingTransactionHashes.mockResolvedValue(new Set([replay.hash]))

        await expect(planBlockOutcome(makeBlock([replay]), [replay])).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })
})

describe("local statuses", () => {
    it("derives confirmed from apply success or a skipped type, failed from the rest", async () => {
        const ok = makeTx(alice, { nonce: 1 })
        const skipped = makeTx(bob, { nonce: 1 })
        const bad = makeTx(mallory, { nonce: 1 })
        const txs = [ok, skipped, bad]
        const plan = await planBlockOutcome(makeBlock(txs), txs)

        const local = localStatuses(plan, {
            successfulTxs: [ok.hash],
            skippedTxs: [skipped.hash],
            failedTxs: [bad.hash],
        })

        expect(local.get(ok.hash)).toBe("confirmed")
        expect(local.get(skipped.hash)).toBe("confirmed")
        expect(local.get(bad.hash)).toBe("failed")
    })

    it("reports a transaction whose served status differs, in both directions", async () => {
        const wrongConfirmed = makeTx(alice, { nonce: 1, status: "confirmed" })
        const wrongFailed = makeTx(bob, { nonce: 1, status: "failed" })
        const right = makeTx(mallory, { nonce: 1, status: "confirmed" })
        const txs = [wrongConfirmed, wrongFailed, right]
        const plan = await planBlockOutcome(makeBlock(txs), txs)

        const local = localStatuses(plan, {
            successfulTxs: [wrongFailed.hash, right.hash],
            skippedTxs: [],
            failedTxs: [wrongConfirmed.hash],
        })

        expect(statusDisagreements(txs, local).sort()).toEqual(
            [wrongConfirmed.hash, wrongFailed.hash].sort(),
        )
    })
})

describe("fork activation blocks", () => {
    const ACTIVATION = HEIGHT
    const RETENTION_WINDOW = EXPIRED_TX_DEEP_WINDOW_MULTIPLIER * 1

    function activate(fork: "osDenomination" | "signatureDomain") {
        const config = getSharedState.forkConfig
        config.osDenomination.activationHeight = null
        config.signatureDomain.activationHeight = null
        config[fork].activationHeight = ACTIVATION
        getSharedState.chainId = 7
    }

    it("accepts a transaction hashed under the pre-denomination rules only while one admitted before the fork can still be in a block", async () => {
        activate("osDenomination")
        const legacy = makeSignedTx(alice, bob, {
            height: ACTIVATION,
            hashHeight: ACTIVATION - 1,
            legacyAmounts: true,
        })

        await verifyBlockTransactions(makeBlock([legacy], undefined, ACTIVATION), [legacy])

        // A kept-back transaction reaches a block until its reference block
        // leaves the deep window
        const lastInWindow = ACTIVATION + RETENTION_WINDOW - 1
        await verifyBlockTransactions(makeBlock([legacy], undefined, lastInWindow), [legacy])

        const later = await verifyBlockTransactions(
            makeBlock([legacy], undefined, lastInWindow + 1),
            [legacy],
        ).catch(e => e)
        expect(later).toBeInstanceOf(SyncBlockRejectedError)
        expect(later.message).toContain("not coherent")
    })

    it("accepts a bare-hash signature only while one admitted before the fork can still be in a block", async () => {
        activate("signatureDomain")
        const bare = makeSignedTx(alice, bob, {
            height: ACTIVATION,
            legacyAmounts: true,
        })
        const bound = makeSignedTx(alice, bob, {
            height: ACTIVATION,
            legacyAmounts: true,
            nonce: 2,
            signatureChainId: 7,
        })

        await verifyBlockTransactions(makeBlock([bare, bound], undefined, ACTIVATION), [
            bare,
            bound,
        ])

        const lastInWindow = ACTIVATION + RETENTION_WINDOW - 1
        await verifyBlockTransactions(makeBlock([bare], undefined, lastInWindow), [bare])

        const later = await verifyBlockTransactions(
            makeBlock([bare], undefined, lastInWindow + 1),
            [bare],
        ).catch(e => e)
        expect(later).toBeInstanceOf(SyncBlockRejectedError)
        expect(later.message).toMatch(/signature/i)
    })

    it("judges each fork against the height before its own activation", async () => {
        const config = getSharedState.forkConfig
        config.osDenomination.activationHeight = ACTIVATION
        config.signatureDomain.activationHeight = ACTIVATION + 2
        getSharedState.chainId = 7
        // Hashed under the old amounts, signed before either fork's domain
        const bare = makeSignedTx(alice, bob, {
            height: ACTIVATION,
            hashHeight: ACTIVATION - 1,
            legacyAmounts: true,
        })

        await verifyBlockTransactions(
            makeBlock([bare], undefined, ACTIVATION + 3),
            [bare],
        )
    })

    it("still rejects a tampered body in the activation block", async () => {
        activate("osDenomination")
        const legacy = makeSignedTx(alice, bob, {
            height: ACTIVATION,
            hashHeight: ACTIVATION - 1,
            legacyAmounts: true,
        })
        const block = makeBlock([legacy], undefined, ACTIVATION)
        legacy.content.amount = 999999

        await expect(verifyBlockTransactions(block, [legacy])).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })
})

describe("L2PS batch transactions", () => {
    /** The shape L2PSBatchAggregator submits to its own mempool. */
    function batchTx(overrides: { signer?: TestAccount; domain?: string } = {}) {
        const content = {
            type: "l2psBatch",
            from: alice.address,
            to: alice.address,
            from_ed25519_address: alice.address,
            amount: 0,
            timestamp: 1_700_000_000_000,
            nonce: 4,
            fee: 0,
            data: ["l2psBatch", { batch_hash: "abc", transaction_count: 1 }],
            transaction_fee: {
                network_fee: 0,
                rpc_fee: 0,
                additional_fee: 0,
                rpc_address: null,
            },
        }
        const contentString = JSON.stringify(content)
        const domain = overrides.domain ?? "L2PS_BATCH_TX_V1"
        return {
            hash: createHash("sha256").update(contentString).digest("hex"),
            content,
            signature: {
                type: "ed25519",
                data: edSign(
                    null,
                    Buffer.from(`${domain}:${contentString}`),
                    (overrides.signer ?? alice).privateKey,
                ).toString("hex"),
                domain,
            },
            reference_block: 0,
            status: "confirmed",
            blockNumber: HEIGHT,
            attrs: { reference_block: 0 },
        } as any
    }

    it("is not a transaction a receiving mempool accepts", async () => {
        getSharedState.forkConfig.osDenomination.activationHeight = null
        expect((await validateTx(batchTx(), null, false)).valid).toBe(false)
    })

    it("accepts a batch hashed and signed as the aggregator does", async () => {
        const tx = batchTx()
        await verifyBlockTransactions(makeBlock([tx]), [tx])
    })

    it("rejects a batch whose content was altered, or signed by another key or domain", async () => {
        const altered = batchTx()
        altered.content.data[1].batch_hash = "forged"
        const foreign = batchTx({ signer: mallory })
        const wrongDomain = batchTx({ domain: "SOMETHING_ELSE" })

        for (const tx of [altered, foreign, wrongDomain]) {
            const rejection = await verifyBlockTransactions(makeBlock([tx]), [tx]).catch(e => e)
            expect(rejection).toBeInstanceOf(SyncBlockRejectedError)
        }
    })

    it("rejects the unsigned consensus summary shape", async () => {
        const tx = batchTx()
        tx.content.from = "l2ps:consensus"
        tx.signature = { type: "ed25519", data: "" }

        await expect(verifyBlockTransactions(makeBlock([tx]), [tx])).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })

    it("gives no other type the batch signature form", async () => {
        const tx = batchTx()
        tx.content.type = "native"
        tx.hash = createHash("sha256").update(JSON.stringify(tx.content)).digest("hex")

        await expect(verifyBlockTransactions(makeBlock([tx]), [tx])).rejects.toBeInstanceOf(
            SyncBlockRejectedError,
        )
    })
})

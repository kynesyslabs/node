/**
 * The finality proof read calls: what each answers for a stored chain, the
 * refusals a client must tell apart (not found, not yet committed, behind,
 * busy, outside the storage history window, a rebuilt root that does not
 * match, bad input), and that the transaction and storage proofs served pass
 * the offline reference verifier unchanged.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { Mutex } from "async-mutex"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

interface StoredBlock {
    number: number
    hash: string
    content: Record<string, any>
    validation_data: { signatures: Record<string, string>; round?: number }
}

let blocks = new Map<number, StoredBlock>()
interface TxRow {
    hash: string
    status: string
    attrs: any
    blockNumber: number
    content: Record<string, any>
    signature: { type: string; data: string; domain?: string }
    ed25519_signature: string | null
}
let txRows = new Map<string, TxRow>()
const getTxByHash = jest.fn(async (hash: string) => txRows.get(hash) ?? null)
const lastNumber = () => Math.max(-1, ...blocks.keys())

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getTxByHash,
        getBlockByNumber: async (n: number) => structuredClone(blocks.get(n) ?? null),
        getLastBlock: async () => structuredClone(blocks.get(lastNumber()) ?? null),
        getLastStoredBlock: async () => structuredClone(blocks.get(lastNumber()) ?? null),
        getLastBlockNumber: async () => lastNumber(),
        getBlockRange: async (from: number, to: number) =>
            [...blocks.values()].filter(b => b.number >= from && b.number <= to).sort((a, b) => a.number - b.number).map(b => structuredClone(b)),
        getTransactionsFromHashes: async (hashes: string[]) =>
            hashes.filter(h => txRows.has(h)).map(h => ({ ...txRows.get(h) })),
    },
}))

const sharedState: Record<string, unknown> = { syncStatus: true }
mock.module("src/utilities/sharedState", () => ({ __esModule: true, getSharedState: sharedState }))
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const syncLock = new Mutex()
mock.module("src/libs/blockchain/routines/Sync", () => ({ __esModule: true, syncLock }))

let snapshots: { block: number; setHash: string; validators: any[] }[] = []
const realValidatorSet = await import("src/libs/blockchain/finality/validatorSet")
mock.module("src/libs/blockchain/finality/validatorSet", () => ({
    ...realValidatorSet,
    validatorSetAt: async (height: number) =>
        structuredClone(snapshots.filter(s => s.block <= height).sort((a, b) => b.block - a.block)[0] ?? null),
}))

const proveStoragePrograms = jest.fn(async (_addresses: string[], _undo?: { fromBlock: number; toBlock: number }, _expectedRoot?: string) => ({
    root: "",
    proofs: [] as any[],
}))
const realStorageRoot = await import("src/libs/blockchain/finality/storageRoot")
mock.module("src/libs/blockchain/finality/storageRoot", () => ({ ...realStorageRoot, proveStoragePrograms }))

let historyStart = 1
const realStorageHistory = await import("src/libs/blockchain/finality/storageHistory")
mock.module("src/libs/blockchain/finality/storageHistory", () => ({
    ...realStorageHistory,
    storageHistoryStart: async () => historyStart,
}))

const countStorageProofRootMismatch = jest.fn()
const realMetrics = await import("@/features/metrics/consensusMetrics")
mock.module("@/features/metrics/consensusMetrics", () => ({ ...realMetrics, countStorageProofRootMismatch }))

const { jcsCanonicalize } = await import("src/libs/crypto/jcs")
const { root: rfcRoot, toHex } = await import("src/libs/crypto/merkle/rfc6962")
const { SparseMerkleTree } = await import("src/libs/crypto/merkle/sparse")
const { precommitMessage } = await import("src/libs/consensus/v2/commitLock/messages")
const { validatorSetHash } = await import("src/libs/blockchain/finality/validatorSetRecord")
const { storageProgramKey, storageProgramLeafHex, storageProgramRecord } = await import(
    "src/libs/blockchain/finality/storageRecord"
)
const { __resetCommitmentCache } = await import("src/libs/blockchain/finality/commitments")
const { verifyStorageProof, verifyTransactionProof } = await import("src/libs/blockchain/finality/verify")
const { default: getTransactionProof } = await import("./getTransactionProof")
const { default: getValidatorSet } = await import("./getValidatorSet")
const { default: getBlockSegment, MAX_SEGMENT_BLOCKS, MAX_SEGMENT_CONTENT_BYTES } = await import("./getBlockSegment")
const { default: getStorageProof } = await import("./getStorageProof")
const { default: getStorageProgramLimits } = await import("./getStorageProgramLimits")
const { STORAGE_PROGRAM_MAX_JSON_DEPTH, STORAGE_PROGRAM_MAX_SIZE_BYTES } = await import(
    "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
)
const { serializeTxContent } = await import("src/libs/crypto/txContentSerializer")
const { STORAGE_HISTORY_BLOCKS } = await import("src/libs/blockchain/finality/storageHistory")

interface Key {
    identity: string
    privateKey: KeyObject
}
const keys: Key[] = Array.from({ length: 4 }, () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    return { identity: `0x${publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`, privateKey }
}).sort((a, b) => (a.identity < b.identity ? -1 : 1))
const validators = keys.map(k => ({ identity: k.identity, stake: "1000", status: "2", validAt: 0 }))
const SET_HASH = validatorSetHash(validators)
const trusted = { validators }
const rules = { shardSize: 4 }

const PAYER = `0x${"a1".repeat(32)}`
const PAYEE = `0x${"b2".repeat(32)}`
/** A native transfer as a row stores it: amounts and fees as OS strings. */
function transfer(nonce: number): Record<string, any> {
    const amount = String(1_000_000_000 * nonce)
    return {
        type: "native",
        from: PAYER,
        to: PAYEE,
        amount,
        data: ["native", { nativeOperation: "send", args: [PAYEE, amount] }],
        gcr_edits: [
            { type: "balance", operation: "remove", isRollback: false, account: PAYER, txhash: "", amount },
            { type: "balance", operation: "add", isRollback: false, account: PAYEE, txhash: "", amount },
        ],
        nonce,
        timestamp: 1_790_000_000_000 + nonce,
        transaction_fee: { network_fee: "1", rpc_fee: "0", additional_fee: "0", rpc_address: null },
        from_ed25519_address: PAYER,
    }
}
const CONTENT = { ok: transfer(1), failed: transfer(2), carried: transfer(3), later: transfer(4) }
const BYTES = Object.fromEntries(
    Object.entries(CONTENT).map(([name, content]) => [name, serializeTxContent(content as never, true)]),
) as Record<keyof typeof CONTENT, string>
const TX = {
    ok: sha256(BYTES.ok),
    failed: sha256(BYTES.failed),
    carried: sha256(BYTES.carried),
    later: sha256(BYTES.later),
}
const txRow = (name: keyof typeof CONTENT, status: string, attrs: any, blockNumber: number): TxRow => ({
    hash: TX[name],
    status,
    attrs,
    blockNumber,
    content: structuredClone(CONTENT[name]),
    signature: { type: "ed25519", data: sha256(`signature of ${name}`).repeat(2) },
    ed25519_signature: null,
})
const leafOf = (hash: string, status: string, code: string | null) =>
    new TextEncoder().encode(jcsCanonicalize({ code, hash, status }))

function store(number: number, content: Record<string, any>, signers = keys.slice(0, 3)): StoredBlock {
    const hash = sha256(JSON.stringify(content))
    const round = 1_800_000_000 + number
    const message = precommitMessage(number, round, hash)
    const signatures: Record<string, string> = {}
    for (const k of signers) signatures[k.identity] = sign(null, Buffer.from(message), k.privateKey).toString("hex")
    const block = { number, hash, content, validation_data: { signatures, round } }
    blocks.set(number, block)
    return block
}

function header(number: number, previousHash: string, extra: Record<string, any> = {}) {
    return {
        previousHash,
        ordered_transactions: [] as string[],
        peerlist: keys.map(k => k.identity),
        native_tables_hashes: { native_storage_programs: "00".repeat(32) },
        number,
        parent_results_root: sha256(""),
        validator_set_hash: SET_HASH,
        ...extra,
    }
}

/** Blocks 0..3: block 2 orders three transactions, block 3 commits their results. */
function buildChain() {
    blocks = new Map()
    txRows = new Map()
    __resetCommitmentCache()
    store(0, { previousHash: "0".repeat(64), ordered_transactions: [], extra: { genesisData: "{}" } })
    store(1, header(1, blocks.get(0)!.hash))
    const ordered = [TX.ok, TX.failed, TX.carried]
    store(2, header(2, blocks.get(1)!.hash, { ordered_transactions: ordered }))
    txRows.set(TX.ok, txRow("ok", "confirmed", null, 2))
    txRows.set(TX.failed, txRow("failed", "failed", { code: "TX_NONCE_INVALID_LOW" }, 2))
    txRows.set(TX.carried, txRow("carried", "confirmed", null, 1))
    const leaves = [leafOf(TX.ok, "confirmed", null), leafOf(TX.failed, "failed", "TX_NONCE_INVALID_LOW"), leafOf(TX.carried, "failed", "TX_EXISTS")]
    store(3, header(3, blocks.get(2)!.hash, { parent_results_root: toHex(rfcRoot(leaves)), ordered_transactions: [TX.later] }))
    txRows.set(TX.later, txRow("later", "confirmed", null, 3))
}

const FORKS = {
    osDenomination: { activationHeight: 0 },
    finalityProofs: { activationHeight: 0 },
    commitLock: { activationHeight: 0 },
    committeeBinding: { activationHeight: 0 },
}

beforeEach(() => {
    buildChain()
    snapshots = [{ block: 0, setHash: SET_HASH, validators }]
    sharedState.syncStatus = true
    sharedState.forkConfig = structuredClone(FORKS)
    proveStoragePrograms.mockReset()
})

describe("getTransactionProof", () => {
    it("serves a proof the offline verifier accepts, for an executed and a failed transaction", async () => {
        const ok = await getTransactionProof({ hash: TX.ok })
        expect(ok.result).toBe(200)
        expect(ok.response).toMatchObject({ hash: TX.ok, blockNumber: 2, leafIndex: 0, treeSize: 3, committedIn: 3 })
        expect(ok.response.leaf).toBe(`{"code":null,"hash":"${TX.ok}","status":"confirmed"}`)
        expect(ok.response.commitBlock.signedMessage).toBe(precommitMessage(3, 1_800_000_003, blocks.get(3)!.hash))
        expect(sha256(ok.response.inclusionBlock.contentBytes)).toBe(blocks.get(2)!.hash)
        expect(verifyTransactionProof(ok.response, trusted, rules)).toMatchObject({ verdict: "final-executed" })

        const failed = await getTransactionProof({ hash: TX.failed.toUpperCase() })
        expect(failed.result).toBe(200)
        expect(JSON.parse(failed.response.leaf)).toEqual({ code: "TX_NONCE_INVALID_LOW", hash: TX.failed, status: "failed" })
        expect(verifyTransactionProof(failed.response, trusted, rules)).toMatchObject({ verdict: "final-failed" })
    })

    it("serves the transaction as hashed, so the verifier checks the expected payment", async () => {
        const ok = await getTransactionProof({ hash: TX.ok })
        expect(ok.response.tx).toEqual({
            hash: TX.ok,
            contentBytes: BYTES.ok,
            signature: txRows.get(TX.ok)!.signature,
            ed25519_signature: null,
        })
        const payment = { from: PAYER, to: PAYEE, amount: 1_000_000_000n, nonce: 1 }
        const verdict = verifyTransactionProof(ok.response, trusted, rules, payment)
        expect(verdict.verdict).toBe("final-executed")
        expect(verdict.content).toMatchObject({ from: PAYER, to: PAYEE, amount: "1000000000", nonce: 1 })
        for (const altered of [{ from: PAYEE }, { to: PAYER }, { amount: 2_000_000_000n }, { nonce: 2 }]) {
            expect(verifyTransactionProof(ok.response, trusted, rules, { ...payment, ...altered }).verdict).toBe("invalid")
        }

        const failed = await getTransactionProof({ hash: TX.failed })
        expect(verifyTransactionProof(failed.response, trusted, rules, { ...payment, amount: 2_000_000_000n, nonce: 2 }).verdict).toBe(
            "final-failed",
        )
        const swapped = { ...ok.response, tx: failed.response.tx }
        expect(verifyTransactionProof(swapped, trusted, rules).verdict).toBe("invalid")
    })

    /** Orders one transaction in block 4 and commits its result in block 5. */
    function includeInBlock4(row: Omit<TxRow, "blockNumber" | "status" | "attrs">) {
        const laterLeaf = [leafOf(TX.later, "confirmed", null)]
        store(4, header(4, blocks.get(3)!.hash, { parent_results_root: toHex(rfcRoot(laterLeaf)), ordered_transactions: [row.hash] }))
        store(5, header(5, blocks.get(4)!.hash, { parent_results_root: toHex(rfcRoot([leafOf(row.hash, "confirmed", null)])) }))
        txRows.set(row.hash, { ...row, status: "confirmed", attrs: null, blockNumber: 4 })
    }

    it("serves a system relay transaction as its producer hashed it, raw JSON", async () => {
        const content = {
            type: "l2psBatch",
            from: PAYER,
            to: PAYER,
            amount: 0,
            data: ["l2psEncryptedTx", { l2ps_uid: "subnet", encrypted_batch: "ab".repeat(16) }],
            gcr_edits: [],
            nonce: 5,
            timestamp: 1_790_000_000_005,
            transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
        }
        const raw = JSON.stringify(content)
        expect(serializeTxContent(content as never, true)).not.toBe(raw)
        const signature = { type: "ed25519", data: sha256("relay signature").repeat(2), domain: "l2ps-batch" }
        includeInBlock4({ hash: sha256(raw), content, signature, ed25519_signature: null })

        const reply = await getTransactionProof({ hash: sha256(raw) })
        expect(reply.result).toBe(200)
        expect(reply.response.tx).toEqual({ hash: sha256(raw), contentBytes: raw, signature, ed25519_signature: null })
        const verdict = verifyTransactionProof(reply.response, trusted, rules, { from: PAYER, nonce: 5 })
        expect(verdict).toMatchObject({ verdict: "final-executed", content: { type: "l2psBatch", amount: 0 } })
    })

    it("serves a transaction admitted before osDenomination that landed just after it", async () => {
        sharedState.forkConfig = { ...structuredClone(FORKS), osDenomination: { activationHeight: 4 } }
        const content = { ...transfer(5), amount: 5, transaction_fee: { network_fee: 1, rpc_fee: 0, additional_fee: 0, rpc_address: null } }
        const legacy = JSON.stringify(content)
        expect(serializeTxContent(content as never, true)).not.toBe(legacy)
        includeInBlock4({ hash: sha256(legacy), content, signature: { type: "ed25519", data: "00".repeat(64) }, ed25519_signature: null })

        const reply = await getTransactionProof({ hash: sha256(legacy) })
        expect(reply.result).toBe(200)
        expect(reply.response.tx.contentBytes).toBe(legacy)

        // Without the earlier rule (referenceBlockWindow.test.ts covers the
        // heights past the deep window) the legacy bytes are not recovered.
        sharedState.forkConfig = { ...structuredClone(FORKS), osDenomination: { activationHeight: 0 } }
        const outside = await getTransactionProof({ hash: sha256(legacy) })
        expect(outside.result).toBe(500)
        expect(outside.extra).toMatchObject({ reason: "content_unrecoverable" })
    })

    it("answers 500 content_unrecoverable when the stored transaction no longer hashes to its hash", async () => {
        txRows.get(TX.ok)!.content.nonce = 9
        const reply = await getTransactionProof({ hash: TX.ok })
        expect(reply.result).toBe(500)
        expect(reply.extra).toMatchObject({ reason: "content_unrecoverable" })
        expect(reply.response).toEqual({ error: "content_unrecoverable", blockNumber: 2, txHash: TX.ok })
    })

    it("answers 409 not_yet_committed until the next block exists", async () => {
        const reply = await getTransactionProof({ hash: TX.later })
        expect(reply.result).toBe(409)
        expect(reply.extra).toEqual({ reason: "not_yet_committed" })
        expect(reply.response).toMatchObject({ blockNumber: 3, committedIn: null })
    })

    it("answers 404 not_found, or 503 node_not_synced while behind", async () => {
        const hash = "ab".repeat(32)
        expect((await getTransactionProof({ hash })).result).toBe(404)
        sharedState.syncStatus = false
        const behind = await getTransactionProof({ hash })
        expect(behind.result).toBe(503)
        expect(behind.extra).toEqual({ reason: "node_not_synced" })
    })

    it("answers 404 no_result_commitment before the fork", async () => {
        sharedState.forkConfig = { ...structuredClone(FORKS), finalityProofs: { activationHeight: 10 } }
        const reply = await getTransactionProof({ hash: TX.ok })
        expect(reply.result).toBe(404)
        expect(reply.extra).toEqual({ reason: "no_result_commitment" })
    })

    it("answers 500 content_unrecoverable when stored content no longer hashes to its hash", async () => {
        blocks.get(2)!.content.peerlist = [keys[0].identity]
        const reply = await getTransactionProof({ hash: TX.ok })
        expect(reply.result).toBe(500)
        expect(reply.extra).toMatchObject({ reason: "content_unrecoverable" })
        expect(reply.response).toEqual({ error: "content_unrecoverable", blockNumber: 2 })
    })

    it("answers 500 lookup_failed rather than a proof that cannot verify", async () => {
        txRows.get(TX.failed)!.attrs = { code: "SOMETHING_ELSE" }
        const reply = await getTransactionProof({ hash: TX.ok })
        expect(reply.result).toBe(500)
        expect(reply.extra.reason).toBe("lookup_failed")
        expect(reply.extra.error).toMatch(/do not rebuild the parent_results_root/)
    })

    it("refuses a malformed hash", async () => {
        expect((await getTransactionProof({ hash: "0x12" })).result).toBe(400)
        expect(getTxByHash).not.toHaveBeenCalledWith("0x12")
    })
})

describe("getValidatorSet", () => {
    it("serves the snapshot effective at a height, hashing to the committed set hash", async () => {
        const reply = await getValidatorSet({ blockNumber: "2" })
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual({ blockNumber: 2, effectiveFrom: 0, setHash: SET_HASH, validators })
        expect(validatorSetHash(reply.response.validators)).toBe(blocks.get(3)!.content.validator_set_hash)
    })

    it("follows a set change", async () => {
        const next = validators.slice(0, 3)
        snapshots.push({ block: 2, setHash: validatorSetHash(next), validators: next })
        expect((await getValidatorSet({ blockNumber: 1 })).response.effectiveFrom).toBe(0)
        expect((await getValidatorSet({ blockNumber: 3 })).response).toMatchObject({ effectiveFrom: 2, validators: next })
    })

    it("answers 410 history_unavailable, 404 above the head and 400 for a bad number", async () => {
        snapshots = []
        expect((await getValidatorSet({ blockNumber: 1 })).result).toBe(410)
        expect((await getValidatorSet({ blockNumber: 99 })).result).toBe(404)
        for (const blockNumber of [-1, 1.5, "x", null]) {
            expect((await getValidatorSet({ blockNumber })).result).toBe(400)
        }
    })

    it("answers 500 when the stored set no longer hashes to its recorded hash", async () => {
        snapshots = [{ block: 0, setHash: SET_HASH, validators: validators.slice(1) }]
        expect((await getValidatorSet({ blockNumber: 1 })).result).toBe(500)
    })
})

describe("getBlockSegment", () => {
    it("serves signed headers whose bytes hash to their hashes and chain together", async () => {
        const reply = await getBlockSegment({ from: 0, to: 3 })
        expect(reply.result).toBe(200)
        expect(reply.response).toMatchObject({ from: 0, to: 3, head: 3 })
        const headers = reply.response.headers
        expect(headers.map((h: any) => h.number)).toEqual([0, 1, 2, 3])
        for (const [i, h] of headers.entries()) {
            expect(sha256(h.contentBytes)).toBe(h.hash)
            if (i > 0) expect(JSON.parse(h.contentBytes).previousHash).toBe(headers[i - 1].hash)
            if (i > 0) expect(h.signedMessage).toBe(precommitMessage(h.number, h.round, h.hash))
        }
    })

    it("cuts the range at the head", async () => {
        const reply = await getBlockSegment({ from: 2, to: 50 })
        expect(reply.response).toMatchObject({ from: 2, to: 3 })
    })

    it("refuses bad ranges", async () => {
        for (const [from, to] of [[3, 2], [-1, 2], [0, MAX_SEGMENT_BLOCKS], ["a", 1], [1, undefined]]) {
            expect((await getBlockSegment({ from, to })).result).toBe(400)
        }
        expect((await getBlockSegment({ from: 0, to: MAX_SEGMENT_BLOCKS - 1 })).result).toBe(200)
    })

    it("answers 404 above the head and 500 for a gap", async () => {
        expect((await getBlockSegment({ from: 9, to: 10 })).result).toBe(404)
        blocks.delete(1)
        expect((await getBlockSegment({ from: 0, to: 3 })).result).toBe(500)
    })

    /** Blocks 4..`head` on top of the built chain, each padded to `pad` content bytes. */
    function extendChain(head: number, pad = 0) {
        for (let n = 4; n <= head; n++) {
            store(n, header(n, blocks.get(n - 1)!.hash, { padding: "x".repeat(pad) }))
        }
    }

    /** Every range Chain.getBlockRange is asked for while `work` runs. */
    async function rangesRead(work: () => Promise<unknown>): Promise<[number, number][]> {
        const chain = (await import("src/libs/blockchain/chain")).default as any
        const real = chain.getBlockRange
        const ranges: [number, number][] = []
        chain.getBlockRange = async (from: number, to: number) => {
            ranges.push([from, to])
            return await real(from, to)
        }
        try {
            await work()
        } finally {
            chain.getBlockRange = real
        }
        return ranges
    }

    it("reads a long range in batches and serves it whole", async () => {
        extendChain(60)
        let reply: any
        const ranges = await rangesRead(async () => (reply = await getBlockSegment({ from: 0, to: 60 })))
        expect(reply.response).toMatchObject({ from: 0, to: 60, head: 60 })
        expect(reply.response.headers.map((h: any) => h.number)).toEqual(Array.from({ length: 61 }, (_, i) => i))
        expect(ranges).toEqual([[0, 24], [25, 49], [50, 60]])
    })

    it("stops reading once the reply reaches its byte cap", async () => {
        extendChain(80, 1024 * 1024)
        let reply: any
        const ranges = await rangesRead(async () => (reply = await getBlockSegment({ from: 4, to: 80 })))
        const served = reply.response.headers.length
        expect(served).toBe(7)
        expect(reply.response).toMatchObject({ from: 4, to: 4 + served - 1 })
        const total = reply.response.headers.reduce((sum: number, h: any) => sum + h.contentBytes.length, 0)
        expect(total).toBeLessThanOrEqual(MAX_SEGMENT_CONTENT_BYTES)
        expect(ranges).toEqual([[4, 28]])
    })

    it("serves one block over the byte cap rather than nothing", async () => {
        extendChain(5, MAX_SEGMENT_CONTENT_BYTES + 1)
        const reply = await getBlockSegment({ from: 4, to: 5 })
        expect(reply.response).toMatchObject({ from: 4, to: 4 })
    })
})

describe("getStorageProof", () => {
    const row = (i: number, overrides: Record<string, unknown> = {}) => ({
        storageAddress: `stor-${i}`,
        owner: keys[0].identity,
        programName: `p${i}`,
        encoding: "json",
        data: { i },
        sizeBytes: 4,
        acl: { mode: "public" },
        metadata: null,
        createdByTx: TX.ok,
        lastModifiedByTx: TX.ok,
        isDeleted: false,
        ...overrides,
    })
    type Row = ReturnType<typeof row>

    /** The live table after the head and its undo log, as the node keeps them. */
    let table: Map<string, Row & { smtLeaf: string }>
    let history: { block: number; storageAddress: string; record: any }[]
    /** Records as of the state after each block, keyed by block then address. */
    let stateAfter: Map<number, Map<string, any>>

    const tableRoot = () =>
        SparseMerkleTree.build([...table.values()].map(r => ({ key: storageProgramKey(r.storageAddress), valueHash: r.smtLeaf }))).rootHex
    const snapshotRecords = () => new Map([...table.values()].map(r => [r.storageAddress, storageProgramRecord(r)]))

    const reader = {
        read: async <T,>(work: (snapshot: any) => Promise<T>) =>
            await work({
                leaves: async () => [...table.values()].map(r => ({ storageAddress: r.storageAddress, smtLeaf: r.smtLeaf, version: "1" })),
                rows: async addresses => addresses.flatMap(a => (table.has(a) ? [structuredClone(table.get(a)!)] : [])),
                history: async (from, to) =>
                    structuredClone(history.filter(h => h.block >= from && h.block <= to).sort((a, b) => b.block - a.block)),
            }),
        fillLeaves: async () => {},
    }
    // Uncapped here: the cap has its own tests.
    const root = new realStorageRoot.StorageProgramsRoot(reader, () => false, { trees: 4, buildsPerWindow: 1_000, windowMs: 1 })

    /**
     * Stores block `number`, committing the root of the state after the
     * block before it, then applies its writes with their undo rows.
     */
    function storeBlock(number: number, writes: [string, Row | null][] = []) {
        store(number, header(number, blocks.get(number - 1)!.hash, { native_tables_hashes: { native_storage_programs: tableRoot() } }))
        for (const [address, next] of writes) {
            const before = table.get(address)
            history.push({ block: number, storageAddress: address, record: before ? storageProgramRecord(before) : null })
            if (next === null) table.delete(address)
            else table.set(address, { ...next, smtLeaf: storageProgramLeafHex(next) })
            root.markDirty()
        }
        stateAfter.set(number, snapshotRecords())
    }

    /** Blocks 4..6 write storage; the head, block 6, deletes one program. */
    function withStorage() {
        storeBlock(4, [["stor-1", row(1)]])
        storeBlock(5, [["stor-1", row(1, { data: { i: 1, v: 2 } })], ["stor-2", row(2)]])
        storeBlock(6, [["stor-2", null]])
    }

    beforeEach(() => {
        table = new Map()
        history = []
        root.markDirty()
        stateAfter = new Map([[3, new Map()]])
        historyStart = 1
        countStorageProofRootMismatch.mockReset()
        proveStoragePrograms.mockImplementation((addresses, undo, expectedRoot) => root.prove(addresses, undo, expectedRoot))
    })

    function expectServedState(reply: any, blockNumber: number, addresses: string[]) {
        expect(reply.result).toBe(200)
        expect(reply.response.anchor.number).toBe(blockNumber)
        expect(reply.response.anchorParent.number).toBe(blockNumber - 1)
        expect(reply.response.asOfBlock).toBe(blockNumber - 1)
        const verdict = verifyStorageProof(reply.response, trusted, rules)
        expect(verdict.verdict).toBe("final")
        expect(verdict.asOfBlock).toBe(blockNumber - 1)
        const expected = stateAfter.get(blockNumber - 1)!
        expect(verdict.records).toEqual(addresses.map(a => ({ storageAddress: a, record: expected.get(a) ?? null })))
    }

    it("serves the head even when the head block wrote storage", async () => {
        withStorage()
        expect(tableRoot()).not.toBe(blocks.get(6)!.content.native_tables_hashes.native_storage_programs)
        const reply = await getStorageProof({ storageAddresses: ["stor-1", "stor-2", "stor-9", "stor-1"] })
        expectServedState(reply, 6, ["stor-1", "stor-2", "stor-9", "stor-1"])
        expect(proveStoragePrograms).toHaveBeenCalledWith(
            ["stor-1", "stor-2", "stor-9"],
            { fromBlock: 6, toBlock: 6 },
            blocks.get(6)!.content.native_tables_hashes.native_storage_programs,
        )
        // Deleted by the head itself: served as it stood before the head.
        expect(reply.response.proofs[1].record).toEqual(storageProgramRecord(row(2)))
    })

    it("serves each recent block's committed state after several writes and a delete", async () => {
        withStorage()
        storeBlock(7)
        for (const blockNumber of [4, 5, 6, 7]) {
            const reply = await getStorageProof({ storageAddresses: ["stor-1", "stor-2"], blockNumber })
            expectServedState(reply, blockNumber, ["stor-1", "stor-2"])
        }
        // Before block 4 nothing existed; after block 5 both did.
        const before = await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: "4" })
        expect(before.response.proofs[0].record).toBeNull()
        const after5 = await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: 6 })
        expect(after5.response.proofs[0].record.dataHash).toBe(sha256(JSON.stringify({ i: 1, v: 2 })))
    })

    it("answers 410 history_unavailable below the window, 404 above the head", async () => {
        withStorage()
        const head = 6 + STORAGE_HISTORY_BLOCKS
        for (let n = 7; n <= head; n++) storeBlock(n)
        const oldest = head - STORAGE_HISTORY_BLOCKS + 1
        const gone = await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: oldest - 1 })
        expect(gone.result).toBe(410)
        expect(gone.extra).toEqual({ reason: "history_unavailable" })
        expect(gone.response).toMatchObject({ head, oldestBlock: oldest })
        expectServedState(await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: oldest }), oldest, ["stor-1"])

        const above = await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: head + 1 })
        expect(above.result).toBe(404)
        expect(above.extra).toEqual({ reason: "not_found" })
        expect((await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: 0 })).extra).toEqual({ reason: "no_storage_commitment" })
        for (const blockNumber of [-1, 1.5, "x", {}]) {
            expect((await getStorageProof({ storageAddresses: ["stor-1"], blockNumber })).result).toBe(400)
        }
    })

    it("answers 500 root_mismatch, counted, when the undo log cannot rebuild the committed root", async () => {
        withStorage()
        history = history.filter(h => !(h.block === 6 && h.storageAddress === "stor-2"))
        const reply = await getStorageProof({ storageAddresses: ["stor-1"] })
        expect(reply.result).toBe(500)
        expect(reply.extra).toEqual({ reason: "root_mismatch" })
        expect(reply.response).toMatchObject({ blockNumber: 6, head: 6 })
        expect(countStorageProofRootMismatch).toHaveBeenCalledTimes(1)
        // Blocks the gap does not reach are still served.
        storeBlock(7)
        expectServedState(await getStorageProof({ storageAddresses: ["stor-1"] }), 7, ["stor-1"])
    })

    it("answers 503 busy, uncounted, when a block lands while the proof is built", async () => {
        withStorage()
        // A block applied outside the sync lock writes storage after the head read.
        proveStoragePrograms.mockImplementation(async (addresses, undo) => {
            storeBlock(7, [["stor-1", row(1, { data: { i: 1, v: 3 } })]])
            return await root.prove(addresses, undo)
        })
        const reply = await getStorageProof({ storageAddresses: ["stor-1"] })
        expect(reply.result).toBe(503)
        expect(reply.extra).toEqual({ reason: "busy" })
        expect(countStorageProofRootMismatch).not.toHaveBeenCalled()
    })

    it("answers 503 busy, uncounted, when a block lands between picking a kept tree and reading it", async () => {
        withStorage()
        expect((await getStorageProof({ storageAddresses: ["stor-1"] })).result).toBe(200)
        proveStoragePrograms.mockImplementation(async (addresses, undo, expectedRoot) => {
            // Committed before the write marks the table dirty.
            const markDirty = root.markDirty
            root.markDirty = () => {}
            try {
                storeBlock(7, [["stor-1", row(1, { data: { i: 1, v: 3 } })]])
            } finally {
                root.markDirty = markDirty
            }
            return await root.prove(addresses, undo, expectedRoot)
        })
        const reply = await getStorageProof({ storageAddresses: ["stor-1"] })
        expect(reply.result).toBe(503)
        expect(reply.extra).toEqual({ reason: "busy" })
        expect(countStorageProofRootMismatch).not.toHaveBeenCalled()
    })

    describe("while a committed block is not yet published", () => {
        const chainModule = async () => (await import("src/libs/blockchain/chain")).default as any

        /** Runs `work` with the published head held at `published`, as insertBlock does before its side effects finish. */
        async function withPublishedHead<T>(published: number, work: () => Promise<T>): Promise<T> {
            const chain = await chainModule()
            const real = chain.getLastBlock
            chain.getLastBlock = async () => structuredClone(blocks.get(published) ?? null)
            try {
                return await work()
            } finally {
                chain.getLastBlock = real
            }
        }

        it("serves the committed head rather than failing on its state", async () => {
            withStorage()
            storeBlock(7, [["stor-1", row(1, { data: { i: 1, v: 3 } })]])
            const reply = await withPublishedHead(6, () => getStorageProof({ storageAddresses: ["stor-1"] }))
            expectServedState(reply, 7, ["stor-1"])
            expect(countStorageProofRootMismatch).not.toHaveBeenCalled()
        })

        it("answers 503 busy, uncounted, when that block commits while the proof is built", async () => {
            withStorage()
            proveStoragePrograms.mockImplementation(async (addresses, undo, expectedRoot) => {
                storeBlock(7, [["stor-1", row(1, { data: { i: 1, v: 3 } })]])
                return await root.prove(addresses, undo, expectedRoot)
            })
            const reply = await withPublishedHead(6, () => getStorageProof({ storageAddresses: ["stor-1"] }))
            expect(reply.result).toBe(503)
            expect(reply.extra).toEqual({ reason: "busy" })
            expect(countStorageProofRootMismatch).not.toHaveBeenCalled()
        })
    })

    it("answers while a block apply holds the sync lock", async () => {
        withStorage()
        const release = await syncLock.acquire()
        try {
            expectServedState(await getStorageProof({ storageAddresses: ["stor-2"] }), 6, ["stor-2"])
        } finally {
            release()
        }
    })

    it("answers 410 history_unavailable below the first block the undo log holds", async () => {
        withStorage()
        storeBlock(7)
        // The log was created when the head was block 5.
        historyStart = 6
        const gone = await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: 5 })
        expect(gone.result).toBe(410)
        expect(gone.extra).toEqual({ reason: "history_unavailable" })
        expect(gone.response).toMatchObject({ blockNumber: 5, head: 7, oldestBlock: 6 })
        expect(proveStoragePrograms).not.toHaveBeenCalled()
        expectServedState(await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: 6 }), 6, ["stor-1"])
    })

    it("answers 503 busy when the tree rebuild cap is spent", async () => {
        withStorage()
        storeBlock(7)
        const capped = new realStorageRoot.StorageProgramsRoot(reader, () => false, { trees: 4, buildsPerWindow: 1, windowMs: 60_000 })
        proveStoragePrograms.mockImplementation((addresses, undo, expectedRoot) => capped.prove(addresses, undo, expectedRoot))
        expect((await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: 6 })).result).toBe(200)
        // The tree of 6..7 is kept; another range needs a rebuild.
        expect((await getStorageProof({ storageAddresses: ["stor-2"], blockNumber: 6 })).result).toBe(200)
        const refused = await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: 5 })
        expect(refused.result).toBe(503)
        expect(refused.extra).toEqual({ reason: "busy" })
        expect(refused.response.retryAfterSeconds).toBeGreaterThanOrEqual(1)
        expect(countStorageProofRootMismatch).not.toHaveBeenCalled()
    })

    it("answers 503 busy when the chain below the head changes under the reads", async () => {
        withStorage()
        storeBlock(7)
        let reads = 0
        const chain = (await import("src/libs/blockchain/chain")).default as any
        const realByNumber = chain.getBlockByNumber
        chain.getBlockByNumber = async (n: number) => {
            // Block 5 is replaced, and the head with it, after the head read.
            if (n === 5 && reads++ === 0) {
                store(5, header(5, blocks.get(4)!.hash, { note: "another branch" }))
                store(7, header(7, blocks.get(6)!.hash, { note: "another head" }))
            }
            return await realByNumber(n)
        }
        try {
            const reply = await getStorageProof({ storageAddresses: ["stor-1"], blockNumber: 6 })
            expect(reply.result).toBe(503)
            expect(reply.extra).toEqual({ reason: "busy" })
            expect(proveStoragePrograms).not.toHaveBeenCalled()
        } finally {
            chain.getBlockByNumber = realByNumber
        }
    })

    it("answers 404 no_storage_commitment when the block commits no storage root", async () => {
        store(4, header(4, blocks.get(3)!.hash, { native_tables_hashes: {} }))
        const reply = await getStorageProof({ storageAddresses: ["stor-1"] })
        expect(reply.result).toBe(404)
        expect(reply.extra).toEqual({ reason: "no_storage_commitment" })
        expect(proveStoragePrograms).not.toHaveBeenCalled()
    })

    it("refuses anything but 1..16 address strings", async () => {
        const many = Array.from({ length: 17 }, (_, i) => `stor-${i}`)
        for (const storageAddresses of [undefined, [], many, [""], [5], "stor-1", ["x".repeat(257)]]) {
            expect((await getStorageProof({ storageAddresses })).result).toBe(400)
        }
    })
})

describe("getStorageProgramLimits", () => {
    it("names the proof batch, the history window, the size and depth limits and the program pricing", async () => {
        const reply = getStorageProgramLimits()
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual({
            maxAddressesPerProof: 16,
            historyBlocks: 64,
            maxDataBytes: 1_048_576,
            measuredOver: expect.stringContaining("JSON.stringify(data)"),
            maxJsonDepth: 64,
            appliesFromBlock: 0,
            maxProgramSizeBytes: 1_048_576,
            pricingChunkBytes: 10_240,
            feePerChunk: "1",
        })
    })

    it("reports the constants the storage routines enforce", async () => {
        const { response } = getStorageProgramLimits()
        expect(response.maxDataBytes).toBe(STORAGE_PROGRAM_MAX_SIZE_BYTES)
        expect(response.maxJsonDepth).toBe(STORAGE_PROGRAM_MAX_JSON_DEPTH)
        expect(response.measuredOver).toContain("binary")
    })
})

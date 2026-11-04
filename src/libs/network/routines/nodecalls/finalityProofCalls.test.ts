/**
 * The finality proof read calls: what each answers for a stored chain, the
 * refusals a client must tell apart (not found, not yet committed, behind,
 * busy, state ahead of the anchor, bad input), and that the transaction and
 * storage proofs served pass the offline reference verifier unchanged.
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
let txRows = new Map<string, { hash: string; status: string; attrs: any; blockNumber: number }>()
const getTxByHash = jest.fn(async (hash: string) => txRows.get(hash) ?? null)
const lastNumber = () => Math.max(-1, ...blocks.keys())

mock.module("src/libs/blockchain/chain", () => ({
    __esModule: true,
    default: {
        getTxByHash,
        getBlockByNumber: async (n: number) => structuredClone(blocks.get(n) ?? null),
        getLastBlock: async () => structuredClone(blocks.get(lastNumber()) ?? null),
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

const proveStoragePrograms = jest.fn(async (_addresses: string[]) => ({ root: "", proofs: [] as any[] }))
const realStorageRoot = await import("src/libs/blockchain/finality/storageRoot")
mock.module("src/libs/blockchain/finality/storageRoot", () => ({ ...realStorageRoot, proveStoragePrograms }))

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
const { default: getBlockSegment, MAX_SEGMENT_BLOCKS } = await import("./getBlockSegment")
const { default: getStorageProof } = await import("./getStorageProof")

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

const TX = { ok: sha256("ok"), failed: sha256("failed"), carried: sha256("carried"), later: sha256("later") }
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
    txRows.set(TX.ok, { hash: TX.ok, status: "confirmed", attrs: null, blockNumber: 2 })
    txRows.set(TX.failed, { hash: TX.failed, status: "failed", attrs: { code: "TX_NONCE_INVALID_LOW" }, blockNumber: 2 })
    txRows.set(TX.carried, { hash: TX.carried, status: "confirmed", attrs: null, blockNumber: 1 })
    const leaves = [leafOf(TX.ok, "confirmed", null), leafOf(TX.failed, "failed", "TX_NONCE_INVALID_LOW"), leafOf(TX.carried, "failed", "TX_EXISTS")]
    store(3, header(3, blocks.get(2)!.hash, { parent_results_root: toHex(rfcRoot(leaves)), ordered_transactions: [TX.later] }))
    txRows.set(TX.later, { hash: TX.later, status: "confirmed", attrs: null, blockNumber: 3 })
}

const FORKS = {
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
        expect(verifyTransactionProof(ok.response, trusted, rules)).toEqual({ verdict: "final-executed" })

        const failed = await getTransactionProof({ hash: TX.failed.toUpperCase() })
        expect(failed.result).toBe(200)
        expect(JSON.parse(failed.response.leaf)).toEqual({ code: "TX_NONCE_INVALID_LOW", hash: TX.failed, status: "failed" })
        expect(verifyTransactionProof(failed.response, trusted, rules)).toEqual({ verdict: "final-failed" })
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
})

describe("getStorageProof", () => {
    const row = (i: number) => ({
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
    })

    function withStorage() {
        const rows = [row(1), row(2)]
        const tree = SparseMerkleTree.build(rows.map(r => ({ key: storageProgramKey(r.storageAddress), valueHash: storageProgramLeafHex(r) })))
        // Blocks 4 and 5 commit the same root: block 4 wrote nothing.
        store(4, header(4, blocks.get(3)!.hash, { native_tables_hashes: { native_storage_programs: tree.rootHex } }))
        store(5, header(5, blocks.get(4)!.hash, { native_tables_hashes: { native_storage_programs: tree.rootHex } }))
        proveStoragePrograms.mockImplementation(async (addresses: string[]) => ({
            root: tree.rootHex,
            proofs: addresses.map(a => {
                const r = rows.find(x => x.storageAddress === a)
                return { storageAddress: a, record: r ? storageProgramRecord(r) : null, ...tree.prove(storageProgramKey(a)) }
            }),
        }))
        return tree
    }

    it("serves proofs against the head's root that the offline verifier accepts", async () => {
        withStorage()
        const reply = await getStorageProof({ storageAddresses: ["stor-1", "stor-9", "stor-1"] })
        expect(reply.result).toBe(200)
        expect(reply.response.asOfBlock).toBe(4)
        expect(reply.response.anchor.number).toBe(5)
        expect(reply.response.anchorParent.number).toBe(4)
        expect(reply.response.proofs.map((p: any) => p.storageAddress)).toEqual(["stor-1", "stor-9", "stor-1"])
        expect(proveStoragePrograms).toHaveBeenCalledWith(["stor-1", "stor-9"])
        const verdict = verifyStorageProof(reply.response, trusted, rules)
        expect(verdict.verdict).toBe("final")
        expect(verdict.records?.[1].record).toBeNull()
    })

    it("answers 503 state_ahead_of_anchor when the table moved past the head's root", async () => {
        withStorage()
        proveStoragePrograms.mockResolvedValue({ root: "11".repeat(32), proofs: [] })
        const reply = await getStorageProof({ storageAddresses: ["stor-1"] })
        expect(reply.result).toBe(503)
        expect(reply.extra).toEqual({ reason: "state_ahead_of_anchor" })
        expect(reply.response.retryAfterSeconds).toBeGreaterThan(0)
    })

    it("builds the proof while holding the sync lock", async () => {
        withStorage()
        let lockedDuringProof = false
        const impl = proveStoragePrograms.getMockImplementation()!
        proveStoragePrograms.mockImplementation(async addresses => {
            lockedDuringProof = syncLock.isLocked()
            return await impl(addresses)
        })
        expect((await getStorageProof({ storageAddresses: ["stor-2"] })).result).toBe(200)
        expect(lockedDuringProof).toBe(true)
        expect(syncLock.isLocked()).toBe(false)
    })

    it("answers 404 no_storage_commitment when the head commits no storage root", async () => {
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

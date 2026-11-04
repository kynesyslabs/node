/**
 * The reference offline verifier against proofs built here from first
 * principles (real ed25519 keys, RFC 6962 and sparse trees, the content
 * hash rule), and against each way a prover could lie: a changed leaf, a
 * tree size the signed block does not give, a forged or repeated signer, a
 * signature from another round, a block from another chain, and a validator
 * set the client does not hold.
 */

import { describe, expect, it } from "bun:test"
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { jcsCanonicalize } from "src/libs/crypto/jcs"
import { auditPath, root, toHex } from "src/libs/crypto/merkle/rfc6962"
import { SparseMerkleTree } from "src/libs/crypto/merkle/sparse"
import { precommitMessage } from "src/libs/consensus/v2/commitLock/messages"
import type { ValidatorSetEntry } from "src/model/entities/ValidatorSetSnapshots"
import {
    storageProgramKey,
    storageProgramLeafHex,
    storageProgramRecord,
    type StorageProgramRow,
} from "./storageRecord"
import { validatorSetHash } from "./validatorSetRecord"
import {
    verifyStorageProof,
    verifyTransactionProof,
    type BlockBytes,
    type CommitteeRules,
    type SignedHeader,
    type StorageProof,
    type TransactionProof,
} from "./verify"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

interface Key {
    identity: string
    privateKey: KeyObject
}

function newKey(): Key {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32)
    return { identity: `0x${raw.toString("hex")}`, privateKey }
}

const keys = Array.from({ length: 5 }, newKey).sort((a, b) => (a.identity < b.identity ? -1 : 1))
const members = keys.slice(0, 4)
const outsider = keys[4]

const validators: ValidatorSetEntry[] = members.map(k => ({
    identity: k.identity,
    stake: "1000000000000000000000",
    status: "2",
    validAt: 0,
}))
const SET_HASH = validatorSetHash(validators)
const trusted = { validators }
const rules: CommitteeRules = { shardSize: 4 }
const ROUND = 1_800_000_123

function blockOf(number: number, content: Record<string, unknown>): BlockBytes {
    const contentBytes = JSON.stringify(content)
    return { number, hash: sha256(contentBytes), contentBytes }
}

function certify(block: BlockBytes, signers: Key[], round = ROUND): SignedHeader {
    const message = precommitMessage(block.number, round, block.hash)
    const signatures: Record<string, string> = {}
    for (const k of signers) {
        signatures[k.identity] = sign(null, Buffer.from(message, "utf8"), k.privateKey).toString("hex")
    }
    return { ...block, round, signedMessage: message, signatures }
}

const resultLeafText = (hash: string, status: string, code: string | null) =>
    jcsCanonicalize({ code, hash, status })

const TX = ["a1", "b2", "c3", "d4", "e5"].map(seed => sha256(seed))
const RESULTS = [
    resultLeafText(TX[0], "confirmed", null),
    resultLeafText(TX[1], "failed", "TX_NONCE_INVALID_LOW"),
    resultLeafText(TX[2], "confirmed", null),
    resultLeafText(TX[3], "failed", "TX_EXISTS"),
    resultLeafText(TX[4], "confirmed", null),
]
const leafBytes = RESULTS.map(text => new TextEncoder().encode(text))
const M = 41

interface ChainOptions {
    peerlist?: string[]
    setHash?: string
    signers?: Key[]
    storageRoot?: string
}

function chain(options: ChainOptions = {}) {
    const inclusion = blockOf(M, {
        previousHash: sha256("block 40"),
        ordered_transactions: TX,
        peerlist: options.peerlist ?? members.map(k => k.identity),
        native_tables_hashes: { native_storage_programs: options.storageRoot ?? "00".repeat(32) },
        number: M,
        parent_results_root: sha256("results of 40"),
        validator_set_hash: options.setHash ?? SET_HASH,
    })
    const commit = blockOf(M + 1, {
        previousHash: inclusion.hash,
        ordered_transactions: [],
        peerlist: members.map(k => k.identity),
        native_tables_hashes: { native_storage_programs: options.storageRoot ?? "00".repeat(32) },
        number: M + 1,
        parent_results_root: toHex(root(leafBytes)),
        validator_set_hash: SET_HASH,
    })
    return { inclusion, commit: certify(commit, options.signers ?? members.slice(0, 3)) }
}

function txProof(index: number, options: ChainOptions = {}): TransactionProof {
    const { inclusion, commit } = chain(options)
    return {
        hash: TX[index],
        blockNumber: M,
        leafIndex: index,
        treeSize: TX.length,
        leaf: RESULTS[index],
        auditPath: auditPath(leafBytes, index).map(toHex),
        committedIn: M + 1,
        inclusionBlock: inclusion,
        commitBlock: commit,
    }
}

const clone = <T>(value: T): T => structuredClone(value)

describe("verifyTransactionProof", () => {
    it("accepts an executed and a failed transaction at every position", () => {
        for (let i = 0; i < TX.length; i++) {
            const expected = RESULTS[i].includes('"confirmed"') ? "final-executed" : "final-failed"
            expect(verifyTransactionProof(txProof(i), trusted, rules)).toEqual({ verdict: expected })
        }
    })

    it("accepts a certificate signed by all four members", () => {
        expect(verifyTransactionProof(txProof(0, { signers: members }), trusted, rules).verdict).toBe("final-executed")
    })

    it("rejects a flipped leaf", () => {
        const proof = txProof(1)
        proof.leaf = resultLeafText(TX[1], "confirmed", null)
        const verdict = verifyTransactionProof(proof, trusted, rules)
        expect(verdict.verdict).toBe("invalid")
        expect(verdict.reason).toMatch(/audit path/)
    })

    it("rejects a leaf that is not in canonical form", () => {
        const proof = txProof(0)
        proof.leaf = JSON.stringify({ hash: TX[0], status: "confirmed", code: null })
        expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/canonical/)
    })

    it("rejects a leaf for another transaction, or the wrong index", () => {
        const proof = txProof(0)
        proof.hash = TX[2]
        expect(verifyTransactionProof(proof, trusted, rules).verdict).toBe("invalid")
        const shifted = txProof(2)
        shifted.leafIndex = 3
        expect(verifyTransactionProof(shifted, trusted, rules).reason).toMatch(/does not order/)
    })

    it("rejects a tree size other than the signed block's transaction count", () => {
        for (const treeSize of [TX.length - 1, TX.length + 1, 8]) {
            const proof = txProof(4)
            proof.treeSize = treeSize
            expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/treeSize/)
        }
    })

    it("rejects a changed or truncated audit path", () => {
        const proof = txProof(2)
        proof.auditPath[0] = sha256("forged")
        expect(verifyTransactionProof(proof, trusted, rules).verdict).toBe("invalid")
        const short = txProof(2)
        short.auditPath.pop()
        expect(verifyTransactionProof(short, trusted, rules).verdict).toBe("invalid")
    })

    it("rejects a forged signature: two genuine ones are below the quorum", () => {
        const proof = txProof(0)
        const forger = members[2].identity
        proof.commitBlock.signatures[forger] = sign(
            null,
            Buffer.from(proof.commitBlock.signedMessage!, "utf8"),
            outsider.privateKey,
        ).toString("hex")
        const verdict = verifyTransactionProof(proof, trusted, rules)
        expect(verdict.verdict).toBe("invalid")
        expect(verdict.reason).toMatch(/2 verified signature/)
    })

    it("does not count a signer outside the validator set", () => {
        const proof = txProof(0, { signers: [members[0], members[1], outsider] })
        expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/2 verified signature/)
    })

    it("counts one key spelled twice as one signer", () => {
        const proof = txProof(0, { signers: members.slice(0, 2) })
        const [identity, signature] = Object.entries(proof.commitBlock.signatures)[0]
        proof.commitBlock.signatures[identity.toUpperCase().replace(/^0X/, "0x")] = signature
        proof.commitBlock.signatures[identity.slice(2)] = signature
        expect(Object.keys(proof.commitBlock.signatures)).toHaveLength(4)
        expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/2 verified signature/)
    })

    it("rejects signatures from another round", () => {
        const proof = txProof(0)
        const other = certify(proof.commitBlock, members.slice(0, 3), ROUND - 7)
        proof.commitBlock.signatures = other.signatures
        expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/0 verified signature/)

        const relabelled = txProof(0)
        relabelled.commitBlock.round = ROUND + 1
        expect(verifyTransactionProof(relabelled, trusted, rules).reason).toMatch(/signedMessage/)

        const rewritten = txProof(0)
        rewritten.commitBlock.round = ROUND + 1
        rewritten.commitBlock.signedMessage = precommitMessage(M + 1, ROUND + 1, rewritten.commitBlock.hash)
        expect(verifyTransactionProof(rewritten, trusted, rules).reason).toMatch(/0 verified signature/)
    })

    it("rejects a block whose bytes do not hash to its hash", () => {
        const proof = txProof(0)
        proof.inclusionBlock.contentBytes = proof.inclusionBlock.contentBytes.replace(`"number":${M}`, `"number":${M} `)
        expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/does not hash/)
    })

    it("rejects an inclusion block that is not the commit block's parent", () => {
        const proof = txProof(0)
        const other = chain({ peerlist: members.slice(0, 3).map(k => k.identity) }).inclusion
        proof.inclusionBlock = other
        expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/does not follow/)
    })

    it("rejects a block whose content commits another height", () => {
        const proof = txProof(0)
        proof.commitBlock = certify({ ...proof.commitBlock, number: M + 2 }, members.slice(0, 3))
        proof.committedIn = M + 2
        proof.blockNumber = M + 1
        proof.inclusionBlock = { ...proof.inclusionBlock, number: M + 1 }
        expect(verifyTransactionProof(proof, trusted, rules).verdict).toBe("invalid")
    })

    it("is indeterminate when the client holds another validator set", () => {
        const stale = { validators: validators.slice(0, 3) }
        const verdict = verifyTransactionProof(txProof(0), stale, rules)
        expect(verdict.verdict).toBe("indeterminate")
        expect(verdict.reason).toMatch(/commits validator set/)
    })

    it("draws the signer pool from the committed peerlist", () => {
        // members[3] is staked but not in the peerlist: its signature does
        // not count, so two of the three peerlist members fall short.
        const peerlist = members.slice(0, 3).map(k => k.identity)
        const proof = txProof(0, { peerlist, signers: [members[0], members[1], members[3]] })
        expect(verifyTransactionProof(proof, trusted, rules).reason).toMatch(/2 verified signature\(s\) from its signer pool of 3/)
    })

    it("falls back to the whole staked set when the peerlist is below the quorum", () => {
        const proof = txProof(0, { peerlist: [members[0].identity], signers: [members[1], members[2], members[3]] })
        expect(verifyTransactionProof(proof, trusted, rules).verdict).toBe("final-executed")
    })

    it("counts only an explicit committee when the client gives one", () => {
        const committee = members.slice(1, 4).map(k => k.identity)
        expect(verifyTransactionProof(txProof(0), trusted, { ...rules, committee }).reason).toMatch(/2 verified/)
        expect(
            verifyTransactionProof(txProof(0, { signers: members.slice(1, 4) }), trusted, { ...rules, committee }).verdict,
        ).toBe("final-executed")
    })

    it("answers invalid, never throws, on malformed input", () => {
        for (const broken of [null, {}, { ...txProof(0), auditPath: "x" }, { ...txProof(0), commitBlock: null }, { ...txProof(0), leaf: "{" }]) {
            expect(verifyTransactionProof(broken as never, trusted, rules).verdict).toBe("invalid")
        }
    })
})

function storageRow(i: number, overrides: Partial<StorageProgramRow> = {}): StorageProgramRow {
    return {
        storageAddress: `stor-${i}`,
        owner: members[0].identity,
        programName: `program-${i}`,
        encoding: "json",
        data: { i },
        sizeBytes: 8,
        acl: { mode: i === 2 ? "restricted" : "public" },
        metadata: null,
        createdByTx: TX[0],
        lastModifiedByTx: TX[0],
        isDeleted: false,
        ...overrides,
    }
}

function storageProof(addresses: string[], options: ChainOptions = {}): StorageProof {
    const rows = [1, 2, 3].map(i => storageRow(i))
    const tree = SparseMerkleTree.build(
        rows.map(r => ({ key: storageProgramKey(r.storageAddress), valueHash: storageProgramLeafHex(r) })),
    )
    const { inclusion, commit } = chain({ ...options, storageRoot: tree.rootHex })
    return {
        anchor: commit,
        anchorParent: inclusion,
        asOfBlock: M,
        proofs: addresses.map(address => {
            const row = rows.find(r => r.storageAddress === address)
            return { storageAddress: address, record: row ? storageProgramRecord(row) : null, ...tree.prove(storageProgramKey(address)) }
        }),
    }
}

describe("verifyStorageProof", () => {
    it("accepts present and absent programs against the anchor's storage root", () => {
        const verdict = verifyStorageProof(storageProof(["stor-1", "stor-2", "stor-404"]), trusted, rules)
        expect(verdict.verdict).toBe("final")
        expect(verdict.asOfBlock).toBe(M)
        expect(verdict.records?.map(r => [r.storageAddress, r.record?.programName ?? null])).toEqual([
            ["stor-1", "program-1"],
            ["stor-2", "program-2"],
            ["stor-404", null],
        ])
    })

    it("rejects a changed record, a record claimed absent and an absent one claimed present", () => {
        const changed = storageProof(["stor-1"])
        changed.proofs[0].record!.sizeBytes = 9
        expect(verifyStorageProof(changed, trusted, rules).reason).toMatch(/not the one committed/)

        const hidden = storageProof(["stor-3"])
        hidden.proofs[0].record = null
        expect(verifyStorageProof(hidden, trusted, rules).reason).toMatch(/not proven absent/)

        const invented = storageProof(["stor-404"])
        invented.proofs[0].record = storageProgramRecord(storageRow(404))
        expect(verifyStorageProof(invented, trusted, rules).verdict).toBe("invalid")
    })

    it("rejects a record served under another address", () => {
        const proof = storageProof(["stor-1"])
        proof.proofs[0].storageAddress = "stor-2"
        expect(verifyStorageProof(proof, trusted, rules).reason).toMatch(/another program/)
    })

    it("rejects an asOfBlock other than the anchor's parent", () => {
        const proof = storageProof(["stor-1"])
        proof.asOfBlock = M + 1
        expect(verifyStorageProof(proof, trusted, rules).reason).toMatch(/asOfBlock/)
    })

    it("rejects an anchor without a quorum and is indeterminate on another set", () => {
        expect(verifyStorageProof(storageProof(["stor-1"], { signers: members.slice(0, 2) }), trusted, rules).verdict).toBe("invalid")
        expect(verifyStorageProof(storageProof(["stor-1"]), { validators: validators.slice(1) }, rules).verdict).toBe("indeterminate")
    })
})

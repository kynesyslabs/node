/**
 * The reference offline verifier against proofs built here from first
 * principles (real ed25519 keys, RFC 6962 and sparse trees, the content
 * hash rule), and against each way a prover could lie: a changed leaf, a
 * tree size the signed block does not give, a forged or repeated signer, a
 * signature from another round, a block from another chain, a parent whose
 * peerlist names only its signers, and a validator set the client does not
 * hold.
 */

import { describe, expect, it } from "bun:test"
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { jcsCanonicalize } from "src/libs/crypto/jcs"
import { auditPath, root, toHex } from "src/libs/crypto/merkle/rfc6962"
import { SparseMerkleTree } from "src/libs/crypto/merkle/sparse"
import { precommitMessage } from "src/libs/consensus/v2/commitLock/messages"
import { serializeTxContent } from "src/libs/crypto/txContentSerializer"
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
    type ExpectedTransaction,
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

/** The balance edits the SDK ships with a native send of `amount` to `to`. */
function sendEdits(to: string, amount: string) {
    return [
        { type: "balance", operation: "remove", isRollback: false, account: `0x${"a1".repeat(32)}`, txhash: "", amount },
        { type: "balance", operation: "add", isRollback: false, account: to, txhash: "", amount },
    ]
}

/** A native transfer as the node hashes it once osDenomination applies. */
function transferContent(nonce: number, amount: bigint, to: string) {
    return {
        type: "native",
        from: `0x${"a1".repeat(32)}`,
        to,
        amount,
        data: ["native", { nativeOperation: "send", args: [to, amount.toString()] }],
        gcr_edits: sendEdits(to, amount.toString()),
        nonce,
        timestamp: 1_790_000_000_000 + nonce,
        transaction_fee: { network_fee: 1n, rpc_fee: 0n, additional_fee: 0n, rpc_address: null },
        from_ed25519_address: `0x${"a1".repeat(32)}`,
    }
}
const PAYEE = `0x${"b2".repeat(32)}`
const MALLORY = `0x${"c3".repeat(32)}`

/** A native send whose top-level fields, args and edits can disagree. */
function forgedContent(nonce: number, top: { to?: string; amount?: bigint }, args: [string, bigint], paid: [string, bigint]) {
    const { to: _to, amount: _amount, ...rest } = transferContent(nonce, args[1], args[0])
    return {
        ...rest,
        ...top,
        gcr_edits: sendEdits(paid[0], paid[1].toString()),
    }
}
const PAYMENT = 9_500_000_000n
/** Top-level says the expected payment; the args and edits pay another account and amount. */
const ARGS_ELSEWHERE_BYTES = serializeTxContent(
    forgedContent(11, { to: PAYEE, amount: PAYMENT }, [MALLORY, 1_000_000_000n], [MALLORY, 1_000_000_000n]) as never,
    true,
)
/** The args and edits pay the expected payment; the top-level names another account. */
const TOP_ELSEWHERE_BYTES = serializeTxContent(
    forgedContent(12, { to: MALLORY, amount: PAYMENT }, [PAYEE, PAYMENT], [PAYEE, PAYMENT]) as never,
    true,
)
/** Top-level and args say the expected payment; the edits credit another account. */
const EDITS_ELSEWHERE_BYTES = serializeTxContent(
    forgedContent(13, { to: PAYEE, amount: PAYMENT }, [PAYEE, PAYMENT], [MALLORY, PAYMENT]) as never,
    true,
)
/** A send with no top-level to or amount: the args and edits alone say the payment. */
const ARGS_ONLY_BYTES = serializeTxContent(forgedContent(14, {}, [PAYEE, PAYMENT], [PAYEE, PAYMENT]) as never, true)
const PAYMENT_BYTES = serializeTxContent(transferContent(7, 9_500_000_000n, PAYEE) as never, true)
const LOW_NONCE_BYTES = serializeTxContent(transferContent(6, 9_500_000_000n, PAYEE) as never, true)
const OTHER_BYTES = serializeTxContent(transferContent(8, 1_000_000_000n, PAYEE) as never, true)

const TX = [
    sha256(PAYMENT_BYTES),
    sha256(LOW_NONCE_BYTES),
    sha256(OTHER_BYTES),
    sha256(EDITS_ELSEWHERE_BYTES),
    sha256(ARGS_ELSEWHERE_BYTES),
    sha256(TOP_ELSEWHERE_BYTES),
    sha256(ARGS_ONLY_BYTES),
]
const RESULTS = [
    resultLeafText(TX[0], "confirmed", null),
    resultLeafText(TX[1], "failed", "TX_NONCE_INVALID_LOW"),
    resultLeafText(TX[2], "confirmed", null),
    resultLeafText(TX[3], "failed", "TX_EXISTS"),
    resultLeafText(TX[4], "confirmed", null),
    resultLeafText(TX[5], "confirmed", null),
    resultLeafText(TX[6], "confirmed", null),
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

    /** Seven staked validators: members plus three more, with their set. */
    function widerSet() {
        const extra = Array.from({ length: 3 }, newKey)
        const wide = {
            validators: [...members, ...extra].map(k => ({
                identity: k.identity,
                stake: "1000000000000000000000",
                status: "2",
                validAt: 0,
            })),
        }
        return { extra, wide, setHash: validatorSetHash(wide.validators) }
    }

    it("is indeterminate without a committee when the pool is larger than the shard", () => {
        // Seven eligible validators, a shard of four: three signers outside
        // the drawn committee would reach the quorum of three by themselves.
        const { extra, wide, setHash } = widerSet()
        const proof = txProof(0, {
            peerlist: [...members, ...extra].map(k => k.identity),
            setHash,
            signers: extra,
        })
        const trustedBlockHash = (height: number) => (height === M ? proof.inclusionBlock.hash : undefined)
        const verdict = verifyTransactionProof(proof, wide, { ...rules, trustedBlockHash })
        expect(verdict.verdict).toBe("indeterminate")
        expect(verdict.reason).toMatch(/drawn from 7 identities/)
        const committee = members.map(k => k.identity)
        expect(verifyTransactionProof(proof, wide, { ...rules, committee }).verdict).toBe("invalid")
    })

    it("does not let a quorum of the shard pick its own parent peerlist", () => {
        // Three of seven staked validators fabricate block M naming only
        // themselves, then sign M + 1 on top of it.
        const { extra, wide, setHash } = widerSet()
        const forged = txProof(0, { peerlist: extra.map(k => k.identity), setHash, signers: extra })

        const unbound = verifyTransactionProof(forged, wide, rules)
        expect(unbound.verdict).toBe("indeterminate")
        expect(unbound.reason).toMatch(/not on a chain the client holds and 7 validators are staked/)

        const honest = txProof(0, { setHash })
        const trustedBlockHash = (height: number) => (height === M ? honest.inclusionBlock.hash : undefined)
        const bound = verifyTransactionProof(forged, wide, { ...rules, trustedBlockHash })
        expect(bound.verdict).toBe("invalid")
        expect(bound.reason).toMatch(/not the trusted chain's block 41/)

        const committee = members.map(k => k.identity)
        expect(verifyTransactionProof(forged, wide, { ...rules, committee }).reason).toMatch(/0 verified/)
    })

    it("accepts a parent the client vouches for, in hex with or without 0x", () => {
        const proof = txProof(0)
        for (const spelled of [proof.inclusionBlock.hash, `0x${proof.inclusionBlock.hash.toUpperCase()}`]) {
            const trustedBlockHash = (height: number) => (height === M ? spelled : undefined)
            expect(verifyTransactionProof(proof, trusted, { ...rules, trustedBlockHash }).verdict).toBe("final-executed")
        }
        const elsewhere = () => sha256("another block 41")
        expect(verifyTransactionProof(proof, trusted, { ...rules, trustedBlockHash: elsewhere }).verdict).toBe("invalid")
    })

    it("matches a committee named without 0x against the staked set", () => {
        const committee = members.slice(0, 3).map(k => k.identity.slice(2).toUpperCase())
        expect(verifyTransactionProof(txProof(0), trusted, { ...rules, committee }).verdict).toBe("final-executed")
    })

    it("answers invalid, never throws, on malformed input", () => {
        for (const broken of [null, {}, { ...txProof(0), auditPath: "x" }, { ...txProof(0), commitBlock: null }, { ...txProof(0), leaf: "{" }]) {
            expect(verifyTransactionProof(broken as never, trusted, rules).verdict).toBe("invalid")
        }
    })
})

describe("verifyTransactionProof with the transaction", () => {
    const withTx = (index = 0, contentBytes = PAYMENT_BYTES, hash = TX[index]): TransactionProof => ({
        ...txProof(index),
        tx: { hash, contentBytes, signature: { type: "ed25519", data: "00".repeat(64) }, ed25519_signature: null },
    })
    const payment: ExpectedTransaction = { from: `0x${"a1".repeat(32)}`, to: PAYEE, amount: 9_500_000_000n, nonce: 7 }

    it("serves the signed content and accepts the expected payment", () => {
        const verdict = verifyTransactionProof(withTx(), trusted, rules, payment)
        expect(verdict.verdict).toBe("final-executed")
        expect(verdict.content).toMatchObject({ from: payment.from, to: PAYEE, amount: "9500000000", nonce: 7 })
    })

    it("compares addresses without case or 0x and quantities in any integer spelling", () => {
        const loose = { from: "A1".repeat(32), to: PAYEE.toUpperCase().replace("0X", "0x"), amount: "09500000000", nonce: 7n }
        expect(verifyTransactionProof(withTx(), trusted, rules, loose).verdict).toBe("final-executed")
        expect(verifyTransactionProof(withTx(), trusted, rules, { amount: 9_500_000_000 }).verdict).toBe("final-executed")
    })

    it("refuses a payment whose from, to, amount or nonce is not the expected one", () => {
        const altered: [keyof ExpectedTransaction, unknown][] = [
            ["from", `0x${"c3".repeat(32)}`],
            ["to", `0x${"c3".repeat(32)}`],
            ["amount", 9_500_000_001n],
            ["amount", "9.5"],
            ["nonce", 8],
        ]
        for (const [field, value] of altered) {
            const verdict = verifyTransactionProof(withTx(), trusted, rules, { ...payment, [field]: value })
            expect(verdict.verdict).toBe("invalid")
            expect(verdict.reason).toContain(field)
        }
    })

    it("judges a native send by the args its edits are built from", () => {
        const argsElsewhere = withTx(4, ARGS_ELSEWHERE_BYTES)
        for (const expected of [payment, { to: PAYEE }, { amount: PAYMENT }]) {
            const verdict = verifyTransactionProof(argsElsewhere, trusted, rules, expected)
            expect(verdict.verdict).toBe("invalid")
            expect(verdict.reason).toContain("top-level")
        }
        const paidTo = verifyTransactionProof(argsElsewhere, trusted, rules, { to: MALLORY, amount: 1_000_000_000n })
        expect(paidTo.verdict).toBe("invalid")

        const topElsewhere = withTx(5, TOP_ELSEWHERE_BYTES)
        for (const expected of [{ ...payment, nonce: 12 }, { to: PAYEE }, { to: MALLORY }]) {
            const verdict = verifyTransactionProof(topElsewhere, trusted, rules, expected)
            expect(verdict.verdict).toBe("invalid")
            expect(verdict.reason).toContain("top-level to")
        }
        expect(verifyTransactionProof(topElsewhere, trusted, rules, { amount: PAYMENT }).verdict).toBe("invalid")
    })

    it("refuses a native send whose edits do not credit what its args pay", () => {
        const verdict = verifyTransactionProof(withTx(3, EDITS_ELSEWHERE_BYTES), trusted, rules, { to: PAYEE, amount: PAYMENT })
        expect(verdict.verdict).toBe("invalid")
        expect(verdict.reason).toContain("balance edits")
    })

    it("accepts a native send without top-level to or amount when its args and edits pay", () => {
        const verdict = verifyTransactionProof(withTx(6, ARGS_ONLY_BYTES), trusted, rules, { to: PAYEE, amount: PAYMENT, nonce: 14 })
        expect(verdict.verdict).toBe("final-executed")
        expect(verifyTransactionProof(withTx(6, ARGS_ONLY_BYTES), trusted, rules, { to: MALLORY }).verdict).toBe("invalid")
    })

    it("refuses content that hashes to another transaction", () => {
        for (const proof of [withTx(0, OTHER_BYTES), withTx(0, OTHER_BYTES, TX[2])]) {
            expect(verifyTransactionProof(proof, trusted, rules).verdict).toBe("invalid")
            expect(verifyTransactionProof(proof, trusted, rules, payment).verdict).toBe("invalid")
        }
        const flipped = withTx(0, PAYMENT_BYTES.replace('"nonce":7', '"nonce":8'))
        expect(verifyTransactionProof(flipped, trusted, rules).reason).toContain("does not hash to")
    })

    it("refuses content that is not a JSON object even when it hashes", () => {
        const proof = withTx(0, "[1]")
        proof.hash = sha256("[1]")
        expect(verifyTransactionProof(proof, trusted, rules).verdict).toBe("invalid")
        expect(verifyTransactionProof({ ...withTx(), tx: { hash: TX[0] } } as never, trusted, rules).verdict).toBe("invalid")
    })

    it("checks the content of a failed transaction too, and keeps its verdict", () => {
        const failed = withTx(1, LOW_NONCE_BYTES)
        const verdict = verifyTransactionProof(failed, trusted, rules, { ...payment, nonce: 6 })
        expect(verdict.verdict).toBe("final-failed")
        expect(verdict.content).toMatchObject({ nonce: 6 })
        expect(verifyTransactionProof(failed, trusted, rules, payment).verdict).toBe("invalid")
    })

    it("keeps today's answer without the transaction, and is indeterminate when fields are expected", () => {
        expect(verifyTransactionProof(txProof(0), trusted, rules)).toEqual({ verdict: "final-executed" })
        expect(verifyTransactionProof(txProof(0), trusted, rules, {})).toEqual({ verdict: "final-executed" })
        const unchecked = verifyTransactionProof(txProof(0), trusted, rules, { to: PAYEE })
        expect(unchecked.verdict).toBe("indeterminate")
        expect(unchecked.reason).toContain("to")
    })

    it("still answers invalid for a broken proof that carries the right transaction", () => {
        const proof = withTx()
        proof.commitBlock.signatures = {}
        expect(verifyTransactionProof(proof, trusted, rules, payment).verdict).toBe("invalid")
        expect(verifyTransactionProof({ ...txProof(0), commitBlock: proof.commitBlock }, trusted, rules, payment).verdict).toBe("invalid")
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

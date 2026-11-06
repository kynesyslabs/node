/**
 * The requester's package for #1059 and #1060 (PATH-OS, 2026-10-15), checked
 * against the offline verifier, the storage record and the capacity rules.
 *
 * Testnet runs without finalityProofs, so none of the package's captures
 * carries a proof. What the fixtures expect is encoded here on proofs built
 * from first principles, reusing the package's own identifiers where it has
 * them: the included-but-failed transaction of N07, the sixteen storage
 * programs of F03, the tamper classes of N05 and N06 and the acceptance tests
 * the issues list.
 */

import { describe, expect, it, mock } from "bun:test"
import { sign } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { ValidatorSetEntry } from "src/model/entities/ValidatorSetSnapshots"
import { jcsCanonicalize } from "src/libs/crypto/jcs"
import { canonicalJson } from "src/libs/crypto/canonicalJson"
import { auditPath, root, toHex } from "src/libs/crypto/merkle/rfc6962"
import { precommitMessage } from "src/libs/consensus/v2/commitLock/messages"
import {
    GCRStorageProgramRoutines,
    STORAGE_PROGRAM_MAX_SIZE_BYTES,
    validateStorageProgramPayload,
} from "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
import {
    blockOf,
    buildStorageProof,
    buildTxProof,
    certify,
    newKey,
    sha256Hex as sha256,
    sortedKeys,
    type Key,
    type ProofChainSpec,
} from "./proofTestKit"
import { storageProgramLeafHex, storageProgramRecord, type StorageProgramRow } from "./storageRecord"
import { validatorSetHash } from "./validatorSetRecord"
import {
    verifyStorageProof,
    verifyTransactionProof,
    type BlockBytes,
    type CommitteeRules,
    type StorageProof,
    type TransactionProof,
} from "./verify"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {} },
}))

const FIXTURES = join(import.meta.dir, "__fixtures__", "requester-1059-1060")
const load = (path: string) => JSON.parse(readFileSync(join(FIXTURES, path), "utf8"))

const F03 = load("fixtures/F03_live_lifecycle_storage_anchors_20260907.json")
const F04 = load("fixtures/F04_existing_api_readback_composition.json")
const N05 = load("negative/N05_client_verifier_negatives_offline_20261014.json")
const N06 = load("negative/N06_bundle_evidence_mutations_20260907.json")
const N07 = load("negative/N07_included_but_failed_public_record.json")

const utf8 = new TextEncoder()

// ── a four-member committee with real ed25519 keys ──────────────────────

const keys = sortedKeys(6)
const members = keys.slice(0, 4)
const outsider = keys[4]
const newcomer = keys[5]
const memberIds = members.map(k => k.identity)

const entry = (k: Key): ValidatorSetEntry => ({
    identity: k.identity,
    stake: "1000000000000000000000",
    status: "2",
    validAt: 0,
})
const validators = members.map(entry)
const SET_HASH = validatorSetHash(validators)
const trusted = { validators }
const rules: CommitteeRules = { shardSize: 4 }
const ROUND = 1_800_000_123

// ── N07's block: the failed transfer next to an executed one ────────────

const FAILED_TX: string = N07.tx
const FAILED_CODE: string = N07["reported_responses (quoted from the public records, not re-captured)"]["getTxByHash (excerpt)"].attrs.code
const M: number = N07.block
const EXECUTED_TX = sha256("an executed pay-dem transfer in block 480877")
const TX = [EXECUTED_TX, FAILED_TX]
const RESULTS = [
    jcsCanonicalize({ code: null, hash: EXECUTED_TX, status: "confirmed" }),
    jcsCanonicalize({ code: FAILED_CODE, hash: FAILED_TX, status: "failed" }),
]
const leafBytes = RESULTS.map(text => utf8.encode(text))

interface ChainOptions {
    previousHash?: string
    /** Block m's members and validator set: who may sign block m + 1. */
    peerlist?: string[]
    setHash?: string
    signers?: Key[]
}

const spec = (options: ChainOptions = {}): ProofChainSpec => ({
    number: M,
    transactions: TX,
    results: RESULTS,
    peerlist: options.peerlist ?? memberIds,
    setHash: options.setHash ?? SET_HASH,
    signers: options.signers ?? members.slice(0, 3),
    round: ROUND,
    previousHash: options.previousHash,
})

const txProof = (index: number, options: ChainOptions = {}): TransactionProof => buildTxProof(spec(options), index)

const FINAL = new Set(["final-executed", "final-failed", "final"])

/** A tampered proof must never pass: invalid, or indeterminate where the client lacks the set. */
function expectRefused(verdict: { verdict: string; reason?: string }, expected: "invalid" | "indeterminate", reason?: RegExp) {
    expect(FINAL.has(verdict.verdict)).toBe(false)
    expect(verdict.verdict).toBe(expected)
    if (reason) expect(verdict.reason).toMatch(reason)
}

/** Changes one character in the middle of a block's served bytes. */
function oneByteChanged(text: string): string {
    const at = Math.floor(text.length / 2)
    const next = text[at] === "0" ? "1" : "0"
    return text.slice(0, at) + next + text.slice(at + 1)
}

/** Same content with one field changed, hashed again by the prover. */
function rehashed(block: BlockBytes, change: (content: Record<string, unknown>) => void): BlockBytes {
    const content = JSON.parse(block.contentBytes)
    change(content)
    return blockOf(block.number, content)
}

describe("the requester package", () => {
    it("matches the sha256 and length its MANIFEST gives for every JSON fixture", () => {
        const manifest = load("MANIFEST.json")
        const json = manifest.files.filter((f: { path: string }) => f.path.endsWith(".json"))
        expect(json).toHaveLength(12)
        for (const file of json) {
            const bytes = readFileSync(join(FIXTURES, file.path))
            expect([file.path, bytes.length, sha256(bytes)]).toEqual([file.path, file.bytes, file.sha256])
        }
    })
})

describe("#1059 acceptance tests 1 and 2, N07: executed and included-but-failed", () => {
    it("proves the executed transfer executed", () => {
        expect(verifyTransactionProof(txProof(0), trusted, rules)).toEqual({ verdict: "final-executed" })
    })

    it("proves N07's transaction final and not executed, never paid", () => {
        expect(FAILED_CODE).toBe("TX_NONCE_INVALID_LOW")
        expect(verifyTransactionProof(txProof(1), trusted, rules)).toEqual({ verdict: "final-failed" })
    })

    it("refuses N07's result relabelled as executed", () => {
        const proof = txProof(1)
        proof.leaf = jcsCanonicalize({ code: null, hash: FAILED_TX, status: "confirmed" })
        expectRefused(verifyTransactionProof(proof, trusted, rules), "invalid", /audit path/)
    })
})

describe("#1059 acceptance test 3: tampering gives a rejection (N05, N06 analogues)", () => {
    it("accepts the untampered proof (the positive control)", () => {
        expect(verifyTransactionProof(txProof(1), trusted, rules).verdict).toBe("final-failed")
    })

    it("one byte changed in any contentBytes", () => {
        const inclusion = txProof(0)
        inclusion.inclusionBlock.contentBytes = oneByteChanged(inclusion.inclusionBlock.contentBytes)
        expectRefused(verifyTransactionProof(inclusion, trusted, rules), "invalid", /does not hash/)

        const commit = txProof(0)
        commit.commitBlock.contentBytes = oneByteChanged(commit.commitBlock.contentBytes)
        expectRefused(verifyTransactionProof(commit, trusted, rules), "invalid", /does not hash/)
    })

    it("N06 content-changed: changed content the prover hashed again", () => {
        // Block m with another transaction order: block m + 1 no longer follows it.
        const inclusion = txProof(0)
        inclusion.inclusionBlock = rehashed(inclusion.inclusionBlock, c => {
            c.ordered_transactions = [...TX].reverse()
        })
        expectRefused(verifyTransactionProof(inclusion, trusted, rules), "invalid", /does not follow/)

        // Block m + 1 with another results root: its certificate is for other bytes.
        const commit = txProof(1)
        const forgedLeaves = [RESULTS[0], jcsCanonicalize({ code: null, hash: FAILED_TX, status: "confirmed" })]
        const forgedBlock = rehashed(commit.commitBlock, c => {
            c.parent_results_root = toHex(root(forgedLeaves.map(t => utf8.encode(t))))
        })
        commit.commitBlock = {
            ...forgedBlock,
            round: ROUND,
            signedMessage: precommitMessage(M + 1, ROUND, forgedBlock.hash),
            signatures: commit.commitBlock.signatures,
        }
        commit.leaf = forgedLeaves[1]
        commit.auditPath = auditPath(forgedLeaves.map(t => utf8.encode(t)), 1).map(toHex)
        expectRefused(verifyTransactionProof(commit, trusted, rules), "invalid", /0 verified signature/)
    })

    it("a swapped result leaf", () => {
        const other = txProof(1)
        other.leaf = RESULTS[0]
        other.auditPath = auditPath(leafBytes, 0).map(toHex)
        expectRefused(verifyTransactionProof(other, trusted, rules), "invalid", /another transaction/)

        const moved = txProof(1)
        moved.leafIndex = 0
        expectRefused(verifyTransactionProof(moved, trusted, rules), "invalid", /does not order/)
    })

    it("N06 finality-removed: signatures removed below the threshold, or all of them", () => {
        const below = txProof(0)
        delete below.commitBlock.signatures[members[0].identity]
        expectRefused(verifyTransactionProof(below, trusted, rules), "invalid", /2 verified signature/)

        const none = txProof(0)
        none.commitBlock.signatures = {}
        expectRefused(verifyTransactionProof(none, trusted, rules), "invalid", /0 verified signature/)
    })

    it("an extra non-member signature that would be needed to reach the threshold", () => {
        const proof = txProof(0, { signers: [members[0], members[1], outsider] })
        expectRefused(verifyTransactionProof(proof, trusted, rules), "invalid", /2 verified signature/)
    })

    it("a signature reused from another height", () => {
        const proof = txProof(0)
        const elsewhere = certify(proof.commitBlock, members.slice(0, 3), ROUND, precommitMessage(M + 7, ROUND, proof.commitBlock.hash))
        proof.commitBlock.signatures = elsewhere.signatures
        expectRefused(verifyTransactionProof(proof, trusted, rules), "invalid", /0 verified signature/)
    })

    it("N05 cross-domain: signatures over the bare block hash", () => {
        const proof = txProof(0)
        proof.commitBlock.signatures = certify(proof.commitBlock, members.slice(0, 3), ROUND, proof.commitBlock.hash).signatures
        expectRefused(verifyTransactionProof(proof, trusted, rules), "invalid", /0 verified signature/)
    })

    it("N05 forged-zero, forged-truncated, forged-bitflip and N06 vet-pass-forged, role-signature-broken", () => {
        const crypto = N05.selected_checks.filter((c: { category: string; expected: string }) => c.category === "crypto" && c.expected === "invalid")
        expect(crypto.map((c: { name: string }) => c.name)).toEqual(["forged-zero", "forged-truncated", "forged-bitflip", "cross-domain"])
        expect(Object.keys(N06.mutations)).toContain("vet-pass-forged")
        expect(Object.keys(N06.mutations)).toContain("role-signature-broken")

        const otherMessage = Buffer.from(precommitMessage(M + 1, ROUND, sha256("x")), "utf8")
        const forgeries: [string, (genuine: string) => string][] = [
            ["forged-zero", () => "00".repeat(64)],
            ["forged-truncated", genuine => genuine.slice(0, -2)],
            ["forged-bitflip", genuine => genuine.slice(0, -1) + (genuine.endsWith("0") ? "1" : "0")],
            // A member's genuine signature over another block.
            ["vet-pass-forged", () => sign(null, otherMessage, members[0].privateKey).toString("hex")],
            // A non-member's signature under a member's name.
            ["role-signature-broken", () => sign(null, otherMessage, outsider.privateKey).toString("hex")],
        ]
        for (const [name, forge] of forgeries) {
            const proof = txProof(0)
            const id = members[2].identity
            proof.commitBlock.signatures[id] = forge(proof.commitBlock.signatures[id])
            const verdict = verifyTransactionProof(proof, trusted, rules)
            expect([name, verdict.verdict]).toEqual([name, "invalid"])
            expect(verdict.reason).toMatch(/2 verified signature/)
        }
    })

    it("N06 chain-identity-replaced, wrong genesis: a block from another chain", () => {
        // Same committee, another lineage below block m: a client holding
        // its own chain's block m refuses it.
        const honest = txProof(0)
        const foreign = txProof(0, { previousHash: sha256("another genesis") })
        const trustedBlockHash = (height: number) => (height === M ? honest.inclusionBlock.hash : undefined)
        expectRefused(verifyTransactionProof(foreign, trusted, { ...rules, trustedBlockHash }), "invalid", /not the trusted chain's block/)

        // Another network with its own validators: never final against ours.
        const theirs = Array.from({ length: 4 }, newKey)
        const proof = txProof(0, { setHash: validatorSetHash(theirs.map(entry)), signers: theirs.slice(0, 3) })
        expectRefused(verifyTransactionProof(proof, trusted, rules), "indeterminate", /commits validator set/)
    })

    it("a validator set that does not hash to validator_set_hash", () => {
        const altered = { validators: validators.map((v, i) => (i === 0 ? { ...v, stake: "1" } : v)) }
        expectRefused(verifyTransactionProof(txProof(0), altered, rules), "indeterminate", /commits validator set/)
    })
})

describe("#1059 acceptance test 4: a validator set change", () => {
    // Block m commits a set where the newcomer replaced members[3].
    const changed = [...members.slice(0, 3), newcomer].map(entry)
    const changedHash = validatorSetHash(changed)

    it("verifies with the new set", () => {
        const proof = txProof(0, { setHash: changedHash })
        expect(verifyTransactionProof(proof, { validators: changed }, rules).verdict).toBe("final-executed")
    })

    it("is never final with the change left out", () => {
        const proof = txProof(0, { setHash: changedHash })
        expectRefused(verifyTransactionProof(proof, trusted, rules), "indeterminate", /commits validator set/)
    })
})

// ── #1060 on F03's sixteen programs ─────────────────────────────────────

const OWNER = `0x${"ab".repeat(32)}`
/** #1059 names this as the create transaction of F03's paymentEvidence anchor. */
const E38_CREATED_BY = "8fb017326071dd9b7c5d871149c629df87cbe611547e6097a22ced6e021cecfd"
const E38 = "stor-e38cf97976163bf46198163ef4e68075f19aaf40"
/** #1060 observed this address answering 200 null. */
const NEVER_CREATED = `stor-${"0".repeat(40)}`

interface Anchor {
    run: string
    role: string
    address: string
}

const anchors: Anchor[] = F03.runs.flatMap((run: { run_id: string; storage_program_anchors: Record<string, string> }) =>
    Object.entries(run.storage_program_anchors).map(([role, address]) => ({ run: run.run_id, role, address })),
)

/** F03 kept no program data: each row carries a stand-in with unsorted keys. */
function anchorRow(anchor: Anchor, overrides: Partial<StorageProgramRow> = {}): StorageProgramRow {
    const data = { seq: 0, role: anchor.role, run: anchor.run, amount: 9007199254740991, terms: { price_dem: 1, currency: "DEM" } }
    const createdByTx = anchor.address === E38 ? E38_CREATED_BY : sha256(`create ${anchor.address}`)
    return {
        storageAddress: anchor.address,
        owner: OWNER,
        programName: `dacs-${anchor.role}`,
        encoding: "json",
        data,
        sizeBytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
        acl: { mode: "public" },
        metadata: null,
        createdByTx,
        lastModifiedByTx: createdByTx,
        isDeleted: false,
        ...overrides,
    }
}

const storageProof = (addresses: string[], rows: StorageProgramRow[], options: ChainOptions = {}): StorageProof =>
    buildStorageProof(spec(options), rows, addresses)

const rows = anchors.map(a => anchorRow(a))
const runOne = anchors.slice(0, 8).map(a => a.address)
const runTwo = anchors.slice(8).map(a => a.address)

describe("#1060 acceptance tests 1, 2 and 4 on F03's programs", () => {
    it("holds the sixteen distinct anchors of F03, E38 among them", () => {
        expect(anchors).toHaveLength(16)
        expect(new Set(anchors.map(a => a.address)).size).toBe(16)
        expect(anchors.find(a => a.address === E38)?.role).toBe("paymentEvidence")
    })

    it("proves every program present and the never-created address absent, all at one block", () => {
        for (const batch of [runOne, runTwo]) {
            const verdict = verifyStorageProof(storageProof([...batch, NEVER_CREATED], rows), trusted, rules)
            expect(verdict.verdict).toBe("final")
            expect(verdict.asOfBlock).toBe(M)
            expect(verdict.records?.map(r => [r.storageAddress, r.record?.createdByTx ?? null])).toEqual([
                ...batch.map(address => [address, rows.find(r => r.storageAddress === address)!.createdByTx]),
                [NEVER_CREATED, null],
            ])
        }
    })

    it("lets F04's step 1 check rest on the record: dataHash is sha256(JCS(data))", () => {
        const step1 = F04.call_sequence[0].checks as string[]
        expect(step1).toContain("sha256(JCS(data)) is the content hash")
        const row = rows.find(r => r.storageAddress === E38)!
        const record = verifyStorageProof(storageProof([E38], rows), trusted, rules).records![0].record!
        expect(record.createdByTx).toBe(E38_CREATED_BY)
        expect(record.dataHash).toBe(sha256(jcsCanonicalize(row.data)))
    })

    it("builds the leaf the issue specifies: sha256(0x00 || JCS(record))", () => {
        for (const row of rows) {
            const record = storageProgramRecord(row)
            const expected = sha256(Buffer.concat([Buffer.of(0), Buffer.from(jcsCanonicalize(record), "utf8")]))
            expect(storageProgramLeafHex(row)).toBe(expected)
        }
    })
})

describe("#1060 acceptance test 5: tampering gives a rejection", () => {
    const verify = (proof: StorageProof) => verifyStorageProof(proof, trusted, rules)

    it("changed dataBytes: the data a client read no longer has the committed dataHash", () => {
        const proof = storageProof([E38], rows)
        const served = { ...(rows.find(r => r.storageAddress === E38)!.data as Record<string, unknown>), amount: 1 }
        expect(sha256(jcsCanonicalize(served))).not.toBe(proof.proofs[0].record!.dataHash)
        proof.proofs[0].record!.dataHash = sha256(jcsCanonicalize(served))
        expectRefused(verify(proof), "invalid", /not the one committed/)
    })

    it("a changed record field", () => {
        for (const change of [
            (r: any) => (r.sizeBytes += 1),
            (r: any) => (r.owner = `0x${"cd".repeat(32)}`),
            (r: any) => (r.lastModifiedByTx = sha256("a later write")),
            (r: any) => (r.isDeleted = true),
        ]) {
            const proof = storageProof([E38], rows)
            change(proof.proofs[0].record)
            expectRefused(verify(proof), "invalid", /not the one committed/)
        }
    })

    it("a changed sibling", () => {
        const proof = storageProof([E38, NEVER_CREATED], rows)
        for (const entry of proof.proofs) {
            const tampered = structuredClone(proof)
            const target = tampered.proofs.find(p => p.storageAddress === entry.storageAddress)!
            expect(target.siblings.length).toBeGreaterThan(0)
            target.siblings[target.siblings.length - 1] = sha256("forged sibling")
            expectRefused(verify(tampered), "invalid")
        }
    })

    it("a changed root, in place or hashed again by the prover", () => {
        const inPlace = storageProof([E38], rows)
        inPlace.anchor.contentBytes = inPlace.anchor.contentBytes.replace(/"native_storage_programs":"[0-9a-f]{2}/, m => m.slice(0, -2) + (m.endsWith("00") ? "11" : "00"))
        expectRefused(verify(inPlace), "invalid", /does not hash/)

        // A root over a forged record, in a block the committee never signed.
        const forgedRows = rows.map(r => (r.storageAddress === E38 ? anchorRow(anchors.find(a => a.address === E38)!, { data: { seq: 1 } }) : r))
        const forged = storageProof([E38], forgedRows)
        forged.anchor.signatures = storageProof([E38], rows).anchor.signatures
        expectRefused(verify(forged), "invalid", /0 verified signature/)
    })

    it("changed block bytes and a missing signature", () => {
        const bytes = storageProof([E38], rows)
        bytes.anchorParent.contentBytes = oneByteChanged(bytes.anchorParent.contentBytes)
        expectRefused(verify(bytes), "invalid", /does not hash/)

        const unsigned = storageProof([E38], rows, { signers: members.slice(0, 2) })
        expectRefused(verify(unsigned), "invalid", /2 verified signature/)
    })

    it("wrong genesis: another chain's block, or another network's validators", () => {
        const honest = storageProof([E38], rows)
        const foreign = storageProof([E38], rows, { previousHash: sha256("another genesis") })
        const trustedBlockHash = (height: number) => (height === M ? honest.anchorParent.hash : undefined)
        expectRefused(verifyStorageProof(foreign, trusted, { ...rules, trustedBlockHash }), "invalid", /not the trusted chain's block/)

        const theirs = Array.from({ length: 4 }, newKey)
        const other = storageProof([E38], rows, { setHash: validatorSetHash(theirs.map(entry)), signers: theirs.slice(0, 3) })
        expectRefused(verify(other), "indeterminate", /commits validator set/)
    })

    it("an existing program claimed absent, and an absent one claimed present", () => {
        const hidden = storageProof([E38], rows)
        hidden.proofs[0].record = null
        expectRefused(verify(hidden), "invalid", /not proven absent/)

        const invented = storageProof([NEVER_CREATED], rows)
        invented.proofs[0].record = storageProgramRecord(anchorRow({ run: "x", role: "listing", address: NEVER_CREATED }))
        expectRefused(verify(invented), "invalid")
    })
})

describe("#1060 acceptance test 7: soft delete and re-create", () => {
    const anchor = anchors.find(a => a.address === E38)!

    it("proves a soft-deleted program present with isDeleted, never absent", () => {
        const deleted = rows.map(r => (r.storageAddress === E38 ? { ...r, isDeleted: true, lastModifiedByTx: sha256("delete") } : r))
        const proof = storageProof([E38], deleted)
        const verdict = verifyStorageProof(proof, trusted, rules)
        expect(verdict.verdict).toBe("final")
        expect(verdict.records![0].record!.isDeleted).toBe(true)

        proof.proofs[0].record = null
        expectRefused(verifyStorageProof(proof, trusted, rules), "invalid", /not proven absent/)
    })

    it("shows a re-created program by its new createdByTx, and refuses the old generation's record", () => {
        const recreatedBy = sha256("re-create")
        const recreated = rows.map(r =>
            r.storageAddress === E38 ? anchorRow(anchor, { createdByTx: recreatedBy, lastModifiedByTx: recreatedBy }) : r,
        )
        const proof = storageProof([E38], recreated)
        expect(verifyStorageProof(proof, trusted, rules).records![0].record!.createdByTx).toBe(recreatedBy)

        proof.proofs[0].record = storageProgramRecord(anchorRow(anchor))
        expectRefused(verifyStorageProof(proof, trusted, rules), "invalid", /not the one committed/)
    })
})

describe("#1060 acceptance test 9, F05: dataHash over canonical JSON", () => {
    const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../crypto/__fixtures__/jcs_diff.vectors.json"), "utf8"))

    const nfcThroughout = (value: unknown): boolean => {
        if (typeof value === "string") return value === value.normalize("NFC")
        if (Array.isArray(value)) return value.every(nfcThroughout)
        if (value && typeof value === "object") {
            return Object.entries(value).every(([k, v]) => k === k.normalize("NFC") && nfcThroughout(v))
        }
        return true
    }

    it("gives one dataHash whatever order the keys were written or stored in", () => {
        const written = { z: 1, a: { y: [3, { d: 4, c: 5 }], b: "é" }, m: null }
        const stored = { a: { b: "é", y: [3, { c: 5, d: 4 }] }, m: null, z: 1 }
        const hash = (data: unknown) => storageProgramRecord({ ...anchorRow(anchors[0]), data }).dataHash
        expect(hash(written)).toBe(hash(stored))
        expect(hash(written)).toBe(sha256(jcsCanonicalize(stored)))
    })

    it("spells every DACS canonical-json vector with NFC text exactly as JCS does", () => {
        let compared = 0
        for (const vector of vectors.accepts) {
            if (!nfcThroughout(vector.input)) continue
            expect([vector.name, canonicalJson(vector.input)]).toEqual([vector.name, vector.canonical])
            compared++
        }
        expect(compared).toBe(17)
    })

    it("keeps a decomposed string value as stored, where the DACS profile normalizes it", () => {
        // The node hashes what it serves; a client applying CF-1 NFC to a
        // non-NFC value gets another hash. Listings signed under CF-1 are
        // already NFC, so they agree.
        const decomposed = vectors.accepts.find((v: { name: string }) => v.name === "value-decomposed-nfc")
        expect(nfcThroughout(decomposed.input)).toBe(false)
        expect(canonicalJson(decomposed.input)).toBe(JSON.stringify(decomposed.input))
        expect(canonicalJson(decomposed.input)).not.toBe(decomposed.canonical)
    })

    it("gives every node the same dataHash for a large integer; the DACS profile refuses it (N05 unsafe-integer, over-2pow53)", () => {
        const refused = N05.selected_checks
            .filter((c: { code?: string }) => c.code === "NUMBER-OUTSIDE-DACS-MAGNITUDE")
            .map((c: { name: string }) => c.name)
        expect(refused).toEqual(expect.arrayContaining(["unsafe-integer", "over-2pow53"]))

        const text = "{\"amount\":9007199254740993,\"id\":\"x\"}"
        const one = storageProgramRecord({ ...anchorRow(anchors[0]), data: JSON.parse(text) }).dataHash
        const two = storageProgramRecord({ ...anchorRow(anchors[0]), data: JSON.parse(text) }).dataHash
        expect(one).toBe(two)
        expect(() => jcsCanonicalize(JSON.parse(text))).toThrow(/safe range/)
        for (const vector of vectors.rejects) {
            expect(() => jcsCanonicalize(vector.input)).toThrow()
            expect(() => canonicalJson(vector.input)).not.toThrow()
        }
    })
})

describe("#1060 acceptance test 8, N05 oversized-valid-json and deep: capacity", () => {
    const MAX = 1_048_576
    const ADDRESS = `stor-${"ab".repeat(20)}`

    function create(data: unknown, encoding: "json" | "binary" = "json") {
        const variables = { operation: "CREATE_STORAGE_PROGRAM", storageAddress: ADDRESS, programName: "capacity", encoding, data }
        return {
            validated: validateStorageProgramPayload(variables as any, OWNER),
            applied: GCRStorageProgramRoutines.apply(
                {
                    type: "storageProgram",
                    target: ADDRESS,
                    isRollback: false,
                    txhash: sha256("capacity"),
                    context: { operation: "CREATE_STORAGE_PROGRAM", sender: OWNER, data: { variables, metadata: null } },
                } as any,
                null,
                false,
            ),
        }
    }

    /** `{"v":"<filler>"}` of exactly `bytes` UTF-8 bytes. */
    const jsonOfBytes = (bytes: number, unit = "x") => {
        const unitBytes = Buffer.byteLength(unit, "utf8")
        const room = bytes - Buffer.byteLength(JSON.stringify({ v: "" }), "utf8")
        const data = { v: unit.repeat(Math.floor(room / unitBytes)) + "x".repeat(room % unitBytes) }
        expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBe(bytes)
        return data
    }

    it("has the 1,048,576-byte limit #1060 cites", () => {
        expect(STORAGE_PROGRAM_MAX_SIZE_BYTES).toBe(MAX)
    })

    it("accepts JSON of exactly the limit in UTF-8 bytes and refuses one byte more", async () => {
        for (const unit of ["x", "é", "😀"]) {
            const fits = create(jsonOfBytes(MAX, unit))
            expect(fits.validated.valid).toBe(true)
            const applied = await fits.applied
            expect(applied.success).toBe(true)
            // The read proof's sizeBytes is the measured size.
            expect(storageProgramRecord(applied.storageProgram as any).sizeBytes).toBe(MAX)

            const over = create(jsonOfBytes(MAX + 1, unit))
            expect(over.validated.valid).toBe(false)
            expect((await over.applied).success).toBe(false)
        }
    })

    it("accepts binary of exactly the limit in decoded bytes and refuses one byte more", async () => {
        const fits = create(Buffer.alloc(MAX, 7).toString("base64"), "binary")
        expect(fits.validated.valid).toBe(true)
        const applied = await fits.applied
        expect(applied.success).toBe(true)
        expect(storageProgramRecord(applied.storageProgram as any).sizeBytes).toBe(MAX)

        const over = create(Buffer.alloc(MAX + 1, 7).toString("base64"), "binary")
        expect(over.validated.valid).toBe(false)
        expect((await over.applied).success).toBe(false)
    })

    it("accepts JSON nested 64 deep and refuses 65", async () => {
        const nested = (depth: number) => {
            let value: unknown = 1
            for (let i = 0; i < depth; i++) value = { n: value }
            return value
        }
        const fits = create(nested(64))
        expect(fits.validated.valid).toBe(true)
        expect((await fits.applied).success).toBe(true)
        const deep = create(nested(65))
        expect(deep.validated.valid).toBe(false)
        expect((await deep.applied).success).toBe(false)
    })
})

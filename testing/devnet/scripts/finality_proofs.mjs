/**
 * Finality proofs against a live devnet with finalityProofs active, checked
 * the way an outside client would: node:crypto only, nothing from the node
 * code.
 *
 *   - getTransactionProof for the failed and the executed transfer of the
 *     tx-status scenario: block m's and m+1's bytes hash to their hashes and
 *     chain, the leaf is the transaction's result at its index in block m's
 *     signed ordered_transactions, the RFC 6962 audit path rebuilds block
 *     m+1's parent_results_root with the tree size taken from block m, and
 *     block m+1 carries ed25519 precommits from 2/3 + 1 of the shard (3 of
 *     4) in its signer pool (peerlist of m within the set m commits);
 *   - the same proof tampered (flipped leaf, wrong tree size, a dropped
 *     signature below the quorum) is rejected, so the checks are not vacuous;
 *   - getStorageProof for the storage program and for an address never
 *     created: the sparse Merkle path of each verifies against the anchor's
 *     native_storage_programs, and the anchor carries a quorum;
 *   - getBlockSegment over the last blocks: every header hashes, chains and
 *     carries a quorum.
 *
 * Env: NODE_URLS (comma-separated, node-1 first), PROOF_INPUTS_DIR (holds
 * tx-hashes.json from tx_status_failed.mjs and storage.json from
 * storage_root.mjs), SHARD_SIZE (default 4).
 * Prints "OK" and exits 0, or "FAIL: ..." and exits 1.
 */
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const urls = (process.env.NODE_URLS ?? "").split(",").filter(Boolean)
const inputsDir = process.env.PROOF_INPUTS_DIR
if (urls.length < 2 || !inputsDir) {
    console.error("[proofs] missing env: NODE_URLS (at least two), PROOF_INPUTS_DIR")
    process.exit(2)
}
const txs = JSON.parse(readFileSync(join(inputsDir, "tx-hashes.json"), "utf8"))
const storage = JSON.parse(readFileSync(join(inputsDir, "storage.json"), "utf8"))

// 2/3 + 1 of a full shard: 3 of the devnet's four validators.
const SHARD_SIZE = Number(process.env.SHARD_SIZE ?? 4)
const QUORUM = Math.floor((SHARD_SIZE * 2) / 3) + 1
const VALIDATOR_ACTIVE = "2"
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const HEX32 = /^[0-9a-f]{64}$/

let failures = 0
const oneLine = text => String(text).replace(/[\r\n]+/g, " ")
const sleep = ms => new Promise(r => setTimeout(r, ms))
function check(ok, label, detail = "") {
    const suffix = detail ? ": " + oneLine(detail) : ""
    console.log(`[proofs] ${ok ? "PASS" : "FAIL"} ${label}${suffix}`)
    if (!ok) failures++
}

async function nodeCall(url, message, data) {
    const res = await fetch(`${url}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ type: "nodeCall", message, data }] }),
    })
    return await res.json()
}

/** Polls while the node answers one of `retryOn`, e.g. 409 until block m+1 lands. */
async function nodeCallUntil(url, message, data, retryOn, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs
    let answer
    do {
        answer = await nodeCall(url, message, data)
        if (!retryOn.includes(answer.result)) return answer
        await sleep(1000)
    } while (Date.now() < deadline)
    return answer
}

const sha256 = (...parts) => {
    const h = createHash("sha256")
    for (const p of parts) h.update(p)
    return h.digest()
}
const sha256Hex = text => sha256(Buffer.from(text, "utf8")).toString("hex")

// Sorted keys, JSON.stringify for primitives: the JCS / canonicalJson
// spelling of the ASCII strings, integers and booleans used here.
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") {
        const keys = Object.keys(value).sort()
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
    }
    return JSON.stringify(value)
}

function signatureVerifies(identity, signature, message) {
    try {
        const raw = Buffer.from(String(identity).replace(/^0x/i, ""), "hex")
        const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" })
        return verifySignature(null, Buffer.from(message, "utf8"), key, Buffer.from(String(signature).replace(/^0x/i, ""), "hex"))
    } catch {
        return false
    }
}

const setCache = new Map()
async function validatorSet(blockNumber) {
    if (!setCache.has(blockNumber)) {
        const answer = await nodeCall(urls[0], "getValidatorSet", { blockNumber })
        setCache.set(blockNumber, answer.result === 200 ? answer.response : null)
    }
    return setCache.get(blockNumber)
}

/** Content of a served block, or an error string. */
function readBlock(block, number) {
    if (!block || block.number !== number) return `block ${number} not served`
    if (typeof block.contentBytes !== "string" || sha256Hex(block.contentBytes) !== block.hash) {
        return `block ${number}: contentBytes do not hash to ${block.hash}`
    }
    const content = JSON.parse(block.contentBytes)
    if (content.number !== number) return `block ${number}: content commits number ${content.number}`
    return content
}

/**
 * Null when `header` (block n) is final as a client sees it: it follows
 * `parent`, and at least QUORUM members of its signer pool signed its
 * precommit. The pool is the parent's committed peerlist within the active
 * validators of the set the parent commits, fetched by height and checked
 * against that commitment.
 */
async function certificateProblem(header, parent) {
    const content = readBlock(header, header?.number)
    if (typeof content === "string") return content
    const parentContent = readBlock(parent, header.number - 1)
    if (typeof parentContent === "string") return parentContent
    if (content.previousHash !== parent.hash) return `block ${header.number} does not follow block ${header.number - 1}`

    const setHeight = Math.max(header.number - 2, 0)
    const set = await validatorSet(setHeight)
    if (!set) return `no validator set served for block ${setHeight}`
    const setHash = sha256Hex(canonical(set.validators))
    if (setHash !== parentContent.validator_set_hash) {
        return `validator set at ${setHeight} hashes to ${setHash}, block ${header.number - 1} commits ${parentContent.validator_set_hash}`
    }
    const active = new Set(
        set.validators.filter(v => v.status === VALIDATOR_ACTIVE && v.validAt !== null && v.validAt <= setHeight).map(v => v.identity),
    )
    const peerlist = (parentContent.peerlist ?? []).map(id => String(id).toLowerCase())
    let pool = new Set(peerlist.filter(id => active.has(id)))
    if (pool.size < QUORUM) pool = active

    const expected = `demos-precommit:${header.number}:${header.round}:${header.hash}`
    if (header.signedMessage !== expected) return `block ${header.number}: signedMessage ${header.signedMessage}, expected ${expected}`
    const signers = new Set()
    for (const [identity, signature] of Object.entries(header.signatures ?? {})) {
        const id = identity.toLowerCase()
        if (pool.has(id) && signatureVerifies(id, signature, expected)) signers.add(id)
    }
    if (signers.size < QUORUM) return `block ${header.number}: ${signers.size} verified signer(s) of a pool of ${pool.size}, need ${QUORUM}`
    return null
}

// RFC 9162 section 2.1.3.2.
function auditPathRoot(leafText, index, size, path) {
    let fn = index
    let sn = size - 1
    let r = sha256(Buffer.of(0x00), Buffer.from(leafText, "utf8"))
    for (const hex of path) {
        const p = Buffer.from(hex, "hex")
        if (sn === 0) return null
        if (fn % 2 === 1 || fn === sn) {
            r = sha256(Buffer.of(0x01), p, r)
            while (fn % 2 === 0 && fn !== 0) {
                fn = Math.floor(fn / 2)
                sn = Math.floor(sn / 2)
            }
        } else {
            r = sha256(Buffer.of(0x01), r, p)
        }
        fn = Math.floor(fn / 2)
        sn = Math.floor(sn / 2)
    }
    return sn === 0 ? r.toString("hex") : null
}

/** Null when the tx proof holds, else what is wrong. */
async function txProofProblem(proof) {
    const m = proof.blockNumber
    if (proof.committedIn !== m + 1) return `committedIn ${proof.committedIn} is not ${m + 1}`
    const inclusion = readBlock(proof.inclusionBlock, m)
    if (typeof inclusion === "string") return inclusion
    const commit = readBlock(proof.commitBlock, m + 1)
    if (typeof commit === "string") return commit
    const ordered = inclusion.ordered_transactions ?? []
    if (proof.treeSize !== ordered.length) return `treeSize ${proof.treeSize}, block ${m} orders ${ordered.length}`
    if (ordered[proof.leafIndex] !== proof.hash) return `block ${m} does not order ${proof.hash} at ${proof.leafIndex}`
    const leaf = JSON.parse(proof.leaf)
    if (canonical(leaf) !== proof.leaf || leaf.hash !== proof.hash) return `leaf ${proof.leaf} is not this transaction's canonical result`
    // The tree size comes from the signed block, never from the prover.
    const rebuilt = auditPathRoot(proof.leaf, proof.leafIndex, ordered.length, proof.auditPath)
    if (rebuilt !== commit.parent_results_root) return `audit path gives ${rebuilt}, block ${m + 1} commits ${commit.parent_results_root}`
    return await certificateProblem(proof.commitBlock, proof.inclusionBlock)
}

// ---------------------------------------------------------------------------
// Transaction proofs
// ---------------------------------------------------------------------------
for (const [label, hash, status, code] of [
    ["failed", txs.failed, "failed", "TX_NONCE_INVALID_LOW"],
    ["executed", txs.executed, "confirmed", null],
]) {
    const answer = await nodeCallUntil(urls[0], "getTransactionProof", { hash }, [409])
    check(answer.result === 200, `${label}: getTransactionProof answers`, `result ${answer.result} ${JSON.stringify(answer.extra)}`)
    if (answer.result !== 200) continue
    const proof = answer.response
    const problem = await txProofProblem(proof)
    check(problem === null, `${label}: proof verifies offline (hashes, tree size from block m, audit path, quorum ${QUORUM} of ${SHARD_SIZE})`, problem ?? `block ${proof.blockNumber}, index ${proof.leafIndex} of ${proof.treeSize}`)
    const leaf = JSON.parse(proof.leaf)
    check(leaf.status === status && leaf.code === code, `${label}: leaf commits status ${status}`, proof.leaf)

    const status2 = await nodeCall(urls[0], "getTransactionStatus", { hash })
    check(status2.response?.resultCommittedInBlock === proof.committedIn, `${label}: getTransactionStatus names the committing block`, JSON.stringify(status2.response))

    const other = await nodeCall(urls[1], "getTransactionProof", { hash })
    check(
        other.result === 200 && other.response.leaf === proof.leaf && other.response.commitBlock.hash === proof.commitBlock.hash &&
            JSON.stringify(other.response.auditPath) === JSON.stringify(proof.auditPath),
        `${label}: node-2 serves the same leaf, path and committing block`,
    )

    if (label === "failed") {
        const flipped = { ...proof, leaf: canonical({ code: null, hash, status: "confirmed" }) }
        check((await txProofProblem(flipped)) !== null, "tamper: a flipped leaf is rejected")
        const resized = { ...proof, treeSize: proof.treeSize + 1 }
        check((await txProofProblem(resized)) !== null, "tamper: a tree size other than block m's is rejected")
        const signatures = Object.fromEntries(Object.entries(proof.commitBlock.signatures).slice(0, QUORUM - 1))
        const thin = { ...proof, commitBlock: { ...proof.commitBlock, signatures } }
        check((await txProofProblem(thin)) !== null, "tamper: a certificate below the quorum is rejected")
    }
}

// ---------------------------------------------------------------------------
// Storage proofs
// ---------------------------------------------------------------------------
const KEY_BITS = 256
const bitAt = (key, d) => (key[d >> 3] >> (7 - (d & 7))) & 1
const sparseLeaf = (key, valueHash) => sha256(Buffer.of(0x02), key, valueHash)

function sparseRoot(key, terminalHash, siblings) {
    let h = terminalHash
    for (let d = siblings.length - 1; d >= 0; d--) {
        const s = Buffer.from(siblings[d], "hex")
        h = bitAt(key, d) === 1 ? sha256(Buffer.of(0x01), s, h) : sha256(Buffer.of(0x01), h, s)
    }
    return h.toString("hex")
}

/** Null when the entry holds against `root`, else what is wrong. */
function storageEntryProblem(entry, root) {
    const key = sha256(Buffer.from(entry.storageAddress, "utf8"))
    const { siblings, terminal } = entry
    if (!Array.isArray(siblings) || siblings.length > KEY_BITS || !siblings.every(s => HEX32.test(s))) return "malformed siblings"
    if (entry.record !== null) {
        if (entry.record.storageAddress !== entry.storageAddress) return "record for another address"
        const valueHash = sha256(Buffer.of(0x00), Buffer.from(canonical(entry.record), "utf8"))
        if (terminal?.kind !== "leaf" || terminal.key !== key.toString("hex") || terminal.valueHash !== valueHash.toString("hex")) {
            return "terminal is not this record's leaf"
        }
        return sparseRoot(key, sparseLeaf(key, valueHash), siblings) === root ? null : "membership path does not rebuild the root"
    }
    let terminalHash
    if (terminal?.kind === "empty") {
        terminalHash = Buffer.alloc(32)
    } else if (terminal?.kind === "leaf") {
        const other = Buffer.from(terminal.key, "hex")
        if (other.equals(key)) return "absent key ends at its own leaf"
        for (let d = 0; d < siblings.length; d++) if (bitAt(other, d) !== bitAt(key, d)) return "foreign leaf off the key's path"
        terminalHash = sparseLeaf(other, Buffer.from(terminal.valueHash, "hex"))
    } else {
        return "unknown terminal"
    }
    return sparseRoot(key, terminalHash, siblings) === root ? null : "non-membership path does not rebuild the root"
}

const absent = `stor-never-created-${Date.now()}`
const storageAnswer = await nodeCallUntil(urls[0], "getStorageProof", { storageAddresses: [storage.storageAddress, absent] }, [503])
check(storageAnswer.result === 200, "getStorageProof answers", `result ${storageAnswer.result} ${JSON.stringify(storageAnswer.extra)}`)
if (storageAnswer.result === 200) {
    const { anchor, anchorParent, asOfBlock, proofs } = storageAnswer.response
    const anchorContent = readBlock(anchor, anchor?.number)
    const root = anchorContent?.native_tables_hashes?.native_storage_programs
    check(typeof anchorContent !== "string" && HEX32.test(root ?? "") && asOfBlock === anchor.number - 1, "storage anchor hashes and commits a root as of its parent", `anchor ${anchor?.number}, asOf ${asOfBlock}, root ${root}`)
    const anchorProblem = await certificateProblem(anchor, anchorParent)
    check(anchorProblem === null, `storage anchor carries a quorum of ${QUORUM} of ${SHARD_SIZE}`, anchorProblem ?? `block ${anchor.number}`)
    const [program, missing] = proofs ?? []
    const programProblem = program ? storageEntryProblem(program, root) : "no entry"
    check(programProblem === null, "storage program proof verifies offline", programProblem ?? JSON.stringify(program.record))
    check(missing?.record === null && storageEntryProblem(missing, root) === null, "an address never created is proven absent", missing?.terminal?.kind)
    if (program?.record) {
        const forged = { ...program, record: { ...program.record, sizeBytes: program.record.sizeBytes + 1 } }
        check(storageEntryProblem(forged, root) !== null, "tamper: a changed record is rejected")
    }
}

// ---------------------------------------------------------------------------
// Block segment
// ---------------------------------------------------------------------------
const head = Number((await nodeCall(urls[0], "getLastBlockNumber", {})).response)
const from = Math.max(2, head - 20)
const segment = await nodeCall(urls[0], "getBlockSegment", { from: from - 1, to: head })
const headers = segment.response?.headers ?? []
check(segment.result === 200 && headers.length === head - from + 2, `getBlockSegment serves blocks ${from - 1}..${head}`, `result ${segment.result}, ${headers.length} headers`)
const segmentProblems = []
for (let i = 1; i < headers.length; i++) {
    const problem = await certificateProblem(headers[i], headers[i - 1])
    if (problem) segmentProblems.push(problem)
}
check(segmentProblems.length === 0, `every header in the segment hashes, chains and carries a quorum`, segmentProblems.slice(0, 3).join("; "))
const tooLarge = await nodeCall(urls[0], "getBlockSegment", { from: 0, to: 500 })
check(tooLarge.result === 400, "a segment of more than 500 blocks is refused", `result ${tooLarge.result}`)

if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed`)
    process.exit(1)
}
console.log("OK")

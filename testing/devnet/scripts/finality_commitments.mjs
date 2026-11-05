/**
 * Finality commitments against a live devnet with finalityProofs active,
 * checked the way an outside client would.
 *
 * For every block 1..head, every node must serve the same block, whose content
 * ends with number, parent_results_root and validator_set_hash in that order,
 * with number equal to its height. The parent_results_root of block m+1 is
 * rebuilt here, independently of the node code, from block m's ordered
 * transactions and their statuses: RFC 6962 over jcs({code, hash, status}).
 *
 * Env: NODE_URLS (comma-separated, node-1 first).
 * Prints "OK" and exits 0, or "FAIL: ..." and exits 1.
 */
import { createHash } from "node:crypto"

const urls = (process.env.NODE_URLS ?? "").split(",").filter(Boolean)
if (urls.length < 2) {
    console.error("[finality] missing env: NODE_URLS (at least two)")
    process.exit(2)
}

const COMMITMENT_KEYS = ["number", "parent_results_root", "validator_set_hash"]
const EMPTY_RESULTS_ROOT = createHash("sha256").update("").digest("hex")
const HEX32 = /^[0-9a-f]{64}$/

let failures = 0
const oneLine = text => String(text).replace(/[\r\n]+/g, " ")
function check(ok, label, detail = "") {
    const suffix = detail ? ": " + oneLine(detail) : ""
    console.log(`[finality] ${ok ? "PASS" : "FAIL"} ${label}${suffix}`)
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

async function block(url, number) {
    const answer = await nodeCall(url, "getBlockByNumber", { blockNumber: number })
    if (answer.result !== 200 || !answer.response) return null
    const content = typeof answer.response.content === "string" ? JSON.parse(answer.response.content) : answer.response.content
    return { hash: answer.response.hash, content }
}

const sha256 = (...parts) => {
    const h = createHash("sha256")
    for (const p of parts) h.update(p)
    return h.digest()
}

// RFC 6962 section 2.1: split at the largest power of two below n.
function merkleRoot(leaves) {
    if (leaves.length === 0) return sha256(Buffer.alloc(0))
    if (leaves.length === 1) return sha256(Buffer.of(0x00), leaves[0])
    let k = 1
    while (k * 2 < leaves.length) k *= 2
    return sha256(Buffer.of(0x01), merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)))
}

// Keys in sorted order, plain ASCII values: JSON.stringify is the JCS encoding.
const resultLeaf = (hash, status, code) => Buffer.from(JSON.stringify({ code, hash, status }), "utf8")

async function expectedResultsRoot(parent) {
    const ordered = parent.content?.ordered_transactions ?? []
    if (ordered.length === 0) return EMPTY_RESULTS_ROOT
    const leaves = []
    for (const hash of ordered) {
        const answer = await nodeCall(urls[0], "getTransactionStatus", { hash })
        const s = answer.response
        if (answer.result !== 200 || !s) return `unresolved tx ${hash}`
        if (s.blockNumber !== parent.number) leaves.push(resultLeaf(hash, "failed", "TX_EXISTS"))
        else if (s.state === "included") leaves.push(resultLeaf(hash, "confirmed", null))
        else if (s.state === "failed") leaves.push(resultLeaf(hash, "failed", typeof s.code === "string" ? s.code : null))
        else return `tx ${hash} in state ${s.state}`
    }
    return merkleRoot(leaves).toString("hex")
}

const heads = await Promise.all(urls.map(async u => Number((await nodeCall(u, "getLastBlockNumber", {})).response)))
const head = Math.min(...heads)
check(head >= 2, "chain has at least two blocks", `head ${head}`)

let previous = null
let withTxs = 0
const setHashes = new Set()
for (let n = 1; n <= head; n++) {
    const served = await Promise.all(urls.map(u => block(u, n)))
    if (served.includes(null) || new Set(served.map(b => b.hash)).size !== 1) {
        check(false, `block ${n}: same block on every node`, served.map(b => b?.hash).join(" / "))
        previous = null
        continue
    }
    const { content } = served[0]
    const keys = Object.keys(content ?? {})
    const tail = keys.slice(-COMMITMENT_KEYS.length)
    const shapeOk =
        tail.join(",") === COMMITMENT_KEYS.join(",") &&
        content.number === n &&
        HEX32.test(content.parent_results_root) &&
        HEX32.test(content.validator_set_hash)
    if (!shapeOk) check(false, `block ${n}: commitments last, in order, number = height`, keys.join(","))
    setHashes.add(content.validator_set_hash)

    if (n === 1) {
        if (content.parent_results_root !== EMPTY_RESULTS_ROOT) {
            check(false, "block 1 commits the empty results root", content.parent_results_root)
        }
    } else if (previous) {
        const expected = await expectedResultsRoot({ number: n - 1, content: previous })
        if ((previous.ordered_transactions ?? []).length > 0) withTxs++
        if (content.parent_results_root !== expected) {
            check(false, `block ${n}: parent_results_root rebuilt by the client`, `${content.parent_results_root} != ${expected}`)
        }
    }
    previous = content
}
check(failures === 0, `blocks 1..${head}: commitments well-formed and results roots rebuilt independently`, `${withTxs} parent block(s) with transactions`)
check(withTxs > 0, "at least one rebuilt root covers real transactions", String(withTxs))
check(setHashes.size >= 1, "validator set hash committed", [...setHashes].join(" / "))

if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed`)
    process.exit(1)
}
console.log("OK")

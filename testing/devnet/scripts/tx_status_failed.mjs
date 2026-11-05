/**
 * Client read calls against a live devnet: a transaction a block keeps but
 * does not execute must read as failed, never included.
 *
 * Two transfers signed with the same nonce are submitted to two different
 * nodes (a node refuses a second pending tx for a nonce it already holds),
 * so the merged block executes one and keeps the other as failed with
 * TX_NONCE_INVALID_LOW. Then:
 *   - SDK broadcastAndWait resolves both, one included and one failed;
 *   - getTransactionStatus answers the same on two nodes, with the code and
 *     the height searched; the receiver gained only the executed amount;
 *   - an unknown hash is 404 not_found with the height, block 0 is served,
 *     a getTransactions page serialises, and a history page is capped;
 *   - getFinalizedHead answers a head at or above the inclusion block, with
 *     the hash that height is stored under and a non-negative age.
 *
 * Env: NODE1_URL, NODE2_URL, IDENTITY_PATH, RECEIVER_PUBKEY, AMOUNT_OS.
 * Prints "OK" and exits 0, or "FAIL: ..." and exits 1.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto"
import { readFileSync } from "node:fs"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"

const { NODE1_URL, NODE2_URL, IDENTITY_PATH, RECEIVER_PUBKEY, AMOUNT_OS } = process.env
if (!NODE1_URL || !NODE2_URL || !IDENTITY_PATH || !RECEIVER_PUBKEY || !AMOUNT_OS) {
    console.error("[tx-status] missing env: NODE1_URL, NODE2_URL, IDENTITY_PATH, RECEIVER_PUBKEY, AMOUNT_OS")
    process.exit(2)
}

let failures = 0
// Node answers are echoed; keep each check on one line.
const oneLine = text => String(text).replace(/[\r\n]+/g, " ")

function check(ok, label, detail = "") {
    const verdict = ok ? "PASS" : "FAIL"
    const suffix = detail ? ": " + oneLine(detail) : ""
    console.log(`[tx-status] ${verdict} ${label}${suffix}`)
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

const demos = new Demos()
await demos.connect(NODE1_URL)
await demos.connectWallet(readFileSync(IDENTITY_PATH, "utf8").trim())
const sender = demos.getAddress()
const demos2 = new Demos()
await demos2.connect(NODE2_URL)
await demos2.connectWallet(readFileSync(IDENTITY_PATH, "utf8").trim())

const amount = BigInt(AMOUNT_OS)
const receiverBefore = BigInt((await demos.getAddressInfo(RECEIVER_PUBKEY))?.balance ?? 0)

// Both signed before either reaches the mempool, so both carry the same nonce.
const txA = await demos.pay(RECEIVER_PUBKEY, amount)
const txB = await demos.pay(RECEIVER_PUBKEY, amount * 2n)
check(txA.content.nonce === txB.content.nonce, "both transfers carry the same nonce", `${txA.content.nonce} / ${txB.content.nonce}`)

const [validA, validB] = await Promise.all([DemosTransactions.confirm(txA, demos), DemosTransactions.confirm(txB, demos2)])
const waited = await Promise.allSettled([
    DemosTransactions.broadcastAndWait(validA, demos, { timeoutMs: 120_000 }),
    DemosTransactions.broadcastAndWait(validB, demos2, { timeoutMs: 120_000 }),
])
const states = waited.map(r => (r.status === "fulfilled" ? r.value.status.state : `rejected: ${String(r.reason).slice(0, 200)}`))
check(
    states.filter(s => s === "included").length === 1 && states.filter(s => s === "failed").length === 1,
    "SDK broadcastAndWait resolves one included and one failed",
    states.join(", "),
)

const hashes = waited.map(r => (r.status === "fulfilled" ? r.value.hash : null))
if (hashes.includes(null)) {
    console.log("FAIL: a broadcast did not resolve")
    process.exit(1)
}

for (const [name, url] of [["node-1", NODE1_URL], ["node-2", NODE2_URL]]) {
    let answers = []
    for (let i = 0; i < 30; i++) {
        answers = await Promise.all(hashes.map(hash => nodeCall(url, "getTransactionStatus", { hash })))
        if (answers.every(a => a.result === 200)) break
        await new Promise(r => setTimeout(r, 1000))
    }
    const failed = answers.find(a => a.response?.state === "failed")
    const included = answers.find(a => a.response?.state === "included")
    check(Boolean(failed && included), `${name}: one included, one failed`, JSON.stringify(answers.map(a => a.response)))
    if (failed) {
        check(failed.response.code === "TX_NONCE_INVALID_LOW", `${name}: failed carries TX_NONCE_INVALID_LOW`, failed.response.code)
        check(
            Number.isInteger(failed.response.checkedThroughBlock) && failed.response.checkedThroughBlock >= failed.response.blockNumber,
            `${name}: checkedThroughBlock covers the inclusion block`,
            `${failed.response.checkedThroughBlock} >= ${failed.response.blockNumber}`,
        )
    }
    if (failed && included) {
        check(failed.response.blockNumber === included.response.blockNumber, `${name}: both in the same block`)
    }
}

const executedHash = hashes[states.indexOf("included")]
const executedAmount = executedHash === txA.hash ? amount : amount * 2n
let receiverAfter = receiverBefore
for (let i = 0; i < 10 && receiverAfter === receiverBefore; i++) {
    receiverAfter = BigInt((await demos.getAddressInfo(RECEIVER_PUBKEY))?.balance ?? 0)
    if (receiverAfter === receiverBefore) await new Promise(r => setTimeout(r, 1000))
}
check(receiverAfter - receiverBefore === executedAmount, "receiver gained only the executed transfer", `${receiverAfter - receiverBefore} == ${executedAmount}`)

const unknown = await nodeCall(NODE1_URL, "getTransactionStatus", { hash: "ab".repeat(32) })
check(
    unknown.result === 404 && unknown.response?.state === "unknown" && unknown.extra?.reason === "not_found" &&
        Number.isInteger(unknown.response?.checkedThroughBlock),
    "unknown hash is 404 not_found with the height searched",
    JSON.stringify({ result: unknown.result, response: unknown.response, extra: unknown.extra }),
)

const genesis = await nodeCall(NODE1_URL, "getBlockByNumber", { blockNumber: 0 })
check(genesis.result === 200 && typeof genesis.response?.hash === "string", "block 0 served for a numeric 0", `result ${genesis.result}`)

const page = await nodeCall(NODE1_URL, "getTransactions", {})
const pageHashes = new Set((Array.isArray(page.response) ? page.response : []).map(r => r.hash))
check(
    page.result === 200 && hashes.every(h => pageHashes.has(h)),
    "getTransactions page serialises and lists both transfers",
    `result ${page.result}, rows ${pageHashes.size}`,
)
const row = (Array.isArray(page.response) ? page.response : []).find(r => r.hash === executedHash)
check(typeof row?.amount === "string", "page amounts are decimal strings", typeof row?.amount)

const history = await nodeCall(NODE1_URL, "getTransactionHistory", { address: sender, type: "all", limit: 100000 })
check(history.result === 200 && Array.isArray(history.response) && history.response.length <= 100, "history page capped at 100", `result ${history.result}, rows ${history.response?.length}`)
const badHistory = await nodeCall(NODE1_URL, "getTransactionHistory", { address: sender, type: "all", limit: -1 })
check(badHistory.result === 400, "history refuses a negative limit", `result ${badHistory.result}`)

const inclusionBlock = (await nodeCall(NODE1_URL, "getTransactionStatus", { hash: executedHash })).response?.blockNumber
const head = await nodeCall(NODE1_URL, "getFinalizedHead", {})
const headBlock = Number.isInteger(head.response?.number)
    ? await nodeCall(NODE1_URL, "getBlockByNumber", { blockNumber: head.response.number })
    : null
check(
    head.result === 200 && Number.isInteger(inclusionBlock) && head.response.number >= inclusionBlock && head.response.checkedThroughBlock === head.response.number &&
        head.response.hash === headBlock?.response?.hash && Number.isInteger(head.response.ageSeconds) && head.response.ageSeconds >= 0 &&
        typeof head.response.nodeSynced === "boolean" && head.response.signatureCount >= 1,
    "finalized head covers the inclusion block, matches the stored hash, age non-negative",
    JSON.stringify({ result: head.result, ...head.response, signatures: undefined }),
)

// A client must be able to verify the head's certificate from this answer
// alone: ed25519 over the signed message, by the validator key in each entry.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
function signatureVerifies(identity, signature, message) {
    try {
        const raw = Buffer.from(String(identity).replace(/^0x/, ""), "hex")
        const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" })
        return verifySignature(null, Buffer.from(message, "utf8"), key, Buffer.from(String(signature).replace(/^0x/, ""), "hex"))
    } catch {
        return false
    }
}
const headSigs = Object.entries(head.response?.signatures ?? {})
const verifiedSigs = typeof head.response?.signedMessage === "string"
    ? headSigs.filter(([id, sig]) => signatureVerifies(id, sig, head.response.signedMessage)).length
    : 0
check(
    verifiedSigs >= 3 && head.response.signedMessage.endsWith(head.response.hash),
    "finalized head signatures verify offline against signedMessage (quorum 3 of 4)",
    `${verifiedSigs}/${headSigs.length} verified, round ${head.response?.round}, message ${head.response?.signedMessage}`,
)

if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed`)
    process.exit(1)
}
console.log("OK")

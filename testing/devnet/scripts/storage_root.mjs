/**
 * Storage Program state root against a live devnet with finalityProofs active.
 *
 * Creates a program, writes it, changes its access control and deletes it,
 * one transaction per step. A block commits the root of the state after the
 * previous block, so the root for a write included in block m is read from
 * block m+1. After each
 * step, every node must serve that block with the same hash and the same
 * native_storage_programs root, and the root must differ from the previous
 * step's. At the end every node must agree on every block hash from 1 to the
 * shared head.
 *
 * Env: NODE_URLS (comma-separated, node-1 first), IDENTITY_PATH.
 * Prints "OK" and exits 0, or "FAIL: ..." and exits 1.
 */
import { readFileSync } from "node:fs"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"

const { NODE_URLS, IDENTITY_PATH } = process.env
const urls = (NODE_URLS ?? "").split(",").filter(Boolean)
if (urls.length < 2 || !IDENTITY_PATH) {
    console.error("[storage-root] missing env: NODE_URLS (at least two), IDENTITY_PATH")
    process.exit(2)
}

const EMPTY_ROOT = "00".repeat(32)
let failures = 0
// Node answers are echoed; keep each check on one line.
const oneLine = text => String(text).replace(/[\r\n]+/g, " ")
const sleep = ms => new Promise(r => setTimeout(r, ms))

function check(ok, label, detail = "") {
    const verdict = ok ? "PASS" : "FAIL"
    const suffix = detail ? ": " + oneLine(detail) : ""
    console.log(`[storage-root] ${verdict} ${label}${suffix}`)
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

async function head(url) {
    const answer = await nodeCall(url, "getLastBlockNumber", {})
    return Number(answer.response)
}

async function waitForHeight(height, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const heads = await Promise.all(urls.map(u => head(u).catch(() => -1)))
        if (heads.every(h => h >= height)) return true
        await sleep(1000)
    }
    return false
}

async function blockOn(url, number) {
    const answer = await nodeCall(url, "getBlockByNumber", { blockNumber: number })
    if (answer.result !== 200 || !answer.response) return null
    const block = answer.response
    const content = typeof block.content === "string" ? JSON.parse(block.content) : block.content
    return { hash: block.hash, root: content?.native_tables_hashes?.native_storage_programs ?? null }
}

// Root of the state after `number - 1`, as every node serves it in block `number`.
async function rootsAt(number) {
    if (!(await waitForHeight(number))) return null
    return await Promise.all(urls.map(u => blockOn(u, number)))
}

function checkAgreement(label, blocks) {
    if (!blocks || blocks.includes(null)) {
        check(false, `${label}: block served by every node`, JSON.stringify(blocks))
        return null
    }
    const hashes = new Set(blocks.map(b => b.hash))
    const roots = new Set(blocks.map(b => b.root))
    check(hashes.size === 1, `${label}: same block hash on ${blocks.length} nodes`, [...hashes].join(" / "))
    check(roots.size === 1, `${label}: same storage root on ${blocks.length} nodes`, [...roots].join(" / "))
    const root = blocks[0].root
    check(typeof root === "string" && /^[0-9a-f]{64}$/.test(root), `${label}: root is 32-byte lowercase hex`, root)
    return root
}

async function txBlock(hash) {
    for (let i = 0; i < 30; i++) {
        const answer = await nodeCall(urls[0], "getTransactionStatus", { hash })
        if (answer.result === 200 && Number.isInteger(answer.response?.blockNumber)) return answer.response
        await sleep(1000)
    }
    return null
}

const demos = new Demos()
await demos.connect(urls[0])
await demos.connectWallet(readFileSync(IDENTITY_PATH, "utf8").trim())
const owner = demos.getAddress()

async function send(label, payload) {
    const tx = await demos.storagePrograms.sign(payload)
    const valid = await DemosTransactions.confirm(tx, demos)
    let state = "rejected"
    try {
        const waited = await DemosTransactions.broadcastAndWait(valid, demos, { timeoutMs: 120_000 })
        state = waited.status.state
    } catch (err) {
        state = `rejected: ${String(err).slice(0, 200)}`
    }
    const status = await txBlock(tx.hash)
    check(state === "included" && status?.state === "included", `${label}: executed`, `${state}, ${JSON.stringify(status)}`)
    return status?.blockNumber ?? null
}

const startHead = await head(urls[0])
const baseline = checkAgreement(`before any write (block ${startHead})`, await rootsAt(startHead))
check(baseline === EMPTY_ROOT, "no storage program yet: empty root", baseline)

const nonce = await demos.getNextNonce(owner)
const create = StorageProgram.createStorageProgram(owner, `root-probe-${Date.now()}`, { hello: "world" }, "json", undefined, { nonce })
const address = create.storageAddress

const steps = [
    ["create", create],
    ["write", StorageProgram.writeStorage(address, { hello: "again", n: 1 }, "json")],
    ["access control", StorageProgram.updateAccessControl(address, StorageProgram.publicACL())],
    ["delete", StorageProgram.deleteStorageProgram(address)],
]

let previous = baseline
for (const [label, payload] of steps) {
    const included = await send(label, payload)
    if (included === null) break
    const root = checkAgreement(`${label} (in ${included}, root in ${included + 1})`, await rootsAt(included + 1))
    check(root !== null && root !== previous, `${label}: root changed`, `${previous} -> ${root}`)
    previous = root
    if (label === "write") {
        const read = await demos.storagePrograms.read(address)
        const data = read?.response?.data ?? read?.data
        check(data?.n === 1 && data?.hello === "again", "write: program data reads back", JSON.stringify(data))
    }
}

const finalHead = Math.min(...(await Promise.all(urls.map(head))))
const mismatched = []
for (let n = 1; n <= finalHead; n++) {
    const blocks = await Promise.all(urls.map(u => blockOn(u, n)))
    if (blocks.includes(null) || new Set(blocks.map(b => b.hash)).size !== 1) mismatched.push(n)
}
check(mismatched.length === 0, `every node agrees on blocks 1..${finalHead}`, mismatched.join(","))

if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed`)
    process.exit(1)
}
console.log("OK")

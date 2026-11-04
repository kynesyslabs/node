/**
 * Devnet probe: a transfer whose `to` is 0x, 64 hex characters and U+0000.
 *
 * The node reads `to` through Buffer.from(hex), which stops at the NUL, so
 * without a NUL check the transfer is admitted, gossiped and put in a block.
 * Postgres then refuses the NUL in `transactions.to` and in the receiver's
 * GCR row, the block's commit fails on every node and no block follows.
 *
 * The SDK signer refuses such a `to`, so the transfer is built by the SDK to a
 * clean address, the recipient is swapped, the edits are regenerated with the
 * SDK and the hash is signed with the wallet's key, exactly as a hostile
 * client would. The probe says which of the two happened.
 *
 * Then it watches both nodes for WATCH_SECONDS (30 by default) and reports
 * whether the chain kept producing blocks. Works against any build:
 *   - before the fix: ADMISSION accepted, LIVENESS halted, exit 1;
 *   - after the fix:  ADMISSION refused,  LIVENESS advancing, exit 0.
 *
 * Env: NODE1_URL, NODE2_URL, IDENTITY_PATH (the sender's mnemonic file).
 * Optional: RECEIVER_PUBKEY (0x + 64 hex, default 0xcd..cd), AMOUNT_OS
 * (default 1000000000), WATCH_SECONDS (default 30), MIN_NEW_BLOCKS (default 2).
 * Exit 0 when the transfer is refused and both nodes advance, 1 otherwise,
 * 2 on bad input.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Demos, DemosTransactions, GCRGeneration, uint8ArrayToHex } from "@kynesyslabs/demosdk/websdk"
import { denomination } from "@kynesyslabs/demosdk"

const { NODE1_URL, NODE2_URL, IDENTITY_PATH } = process.env
if (!NODE1_URL || !NODE2_URL || !IDENTITY_PATH) {
    console.error("[nul-probe] missing env: NODE1_URL, NODE2_URL, IDENTITY_PATH")
    process.exit(2)
}
const RECEIVER = (process.env.RECEIVER_PUBKEY ?? "0x" + "cd".repeat(32)).toLowerCase()
if (!/^0x[0-9a-f]{64}$/.test(RECEIVER)) {
    console.error(`[nul-probe] RECEIVER_PUBKEY must be 0x and 64 hex characters, got ${RECEIVER}`)
    process.exit(2)
}
const AMOUNT_OS = BigInt(process.env.AMOUNT_OS ?? "1000000000")
const WATCH_SECONDS = Number(process.env.WATCH_SECONDS ?? 30)
const MIN_NEW_BLOCKS = Number(process.env.MIN_NEW_BLOCKS ?? 2)
const NUL_RECEIVER = RECEIVER + "\u0000"

// Node answers are echoed; keep them on one line and visible when they carry a NUL.
const show = value => JSON.stringify(value ?? null).replace(/[\r\n]+/g, " ").slice(0, 400)

const demos = new Demos()
await demos.connect(NODE1_URL)
await demos.connectWallet(readFileSync(IDENTITY_PATH, "utf8").trim())
console.log(`[nul-probe] sender ${demos.getAddress()}, to ${show(NUL_RECEIVER)}`)

const sha256Hex = text => createHash("sha256").update(text).digest("hex")

// Byte-for-byte the node's src/libs/crypto/txSignaturePreimage.ts; the SDK
// does not export its copy.
const preimage = (hash, chainId, active) =>
    new TextEncoder().encode(active ? `demos-tx:v1:${chainId}:${hash}` : hash)

async function handSigned() {
    const tx = JSON.parse(JSON.stringify(await DemosTransactions.pay(RECEIVER, AMOUNT_OS, demos)))
    tx.content.to = NUL_RECEIVER
    tx.content.data[1].args[0] = NUL_RECEIVER
    tx.content.gcr_edits = await GCRGeneration.generate(tx)
    const serialized = denomination.serializeTransactionContent(tx.content, await demos._isPostForkCached())
    tx.content = JSON.parse(serialized)
    tx.hash = sha256Hex(serialized)
    const signed = await demos.crypto.sign(
        "ed25519",
        preimage(tx.hash, await demos._chainIdCached(), await demos._isSignatureDomainActiveCached()),
    )
    tx.signature = { type: "ed25519", data: uint8ArrayToHex(signed.signature) }
    return tx
}

let tx
let builtBy
try {
    tx = await DemosTransactions.pay(NUL_RECEIVER, AMOUNT_OS, demos)
    builtBy = "SDK pay() signed the NUL recipient itself"
} catch (e) {
    console.log(`[nul-probe] SDK pay() refused the NUL recipient: ${String(e?.message ?? e).slice(0, 200)}`)
    tx = await handSigned()
    builtBy = "built by hand from an SDK transfer, signed with the SDK wallet key"
}
console.log(`[nul-probe] BUILD ${builtBy}; hash ${tx.hash}, nonce ${tx.content.nonce}`)

async function height(url) {
    try {
        const res = await fetch(`${url}/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ method: "nodeCall", params: [{ type: "nodeCall", message: "getLastBlockNumber", data: {} }] }),
            signal: AbortSignal.timeout(5_000),
        })
        const body = await res.json()
        return Number.isInteger(Number(body?.response)) ? Number(body.response) : null
    } catch {
        return null
    }
}

const startHeights = [await height(NODE1_URL), await height(NODE2_URL)]
console.log(`[nul-probe] heights before submit: node-1 ${startHeights[0]}, node-2 ${startHeights[1]}`)

let admission = "refused"
let detail = ""
try {
    // confirm() throws when the node answers valid: false.
    const validity = await DemosTransactions.confirm(tx, demos)
    const sent = await DemosTransactions.broadcast(validity, demos)
    if (sent?.result === 200) {
        admission = "accepted"
        detail = `broadcast: ${show(sent?.response)}`
    } else {
        detail = `broadcast: result ${sent?.result} ${show(sent?.response ?? sent?.extra)}`
    }
} catch (e) {
    detail = `threw: ${String(e?.message ?? e).slice(0, 300)}`
}
console.log(`[nul-probe] ADMISSION ${admission} (${detail})`)

const deadline = Date.now() + WATCH_SECONDS * 1000
let endHeights = startHeights
while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3_000))
    endHeights = [await height(NODE1_URL), await height(NODE2_URL)]
    console.log(`[nul-probe] heights: node-1 ${endHeights[0]}, node-2 ${endHeights[1]}`)
}

const advanced = [0, 1].map(i =>
    startHeights[i] !== null && endHeights[i] !== null ? endHeights[i] - startHeights[i] : null,
)
const alive = advanced.every(n => n !== null && n >= MIN_NEW_BLOCKS)
console.log(
    `[nul-probe] LIVENESS ${alive ? "advancing" : "halted"} (new blocks in ${WATCH_SECONDS}s: node-1 ${advanced[0]}, node-2 ${advanced[1]}, need ${MIN_NEW_BLOCKS})`,
)

if (admission === "refused" && alive) {
    console.log("OK: the NUL transfer was refused and the chain kept producing blocks")
    process.exit(0)
}
console.log(
    `FAIL: ${admission === "accepted" ? "the NUL transfer was admitted" : "the NUL transfer was refused"}` +
        `${alive ? "" : " and the chain stopped producing blocks"}`,
)
process.exit(1)

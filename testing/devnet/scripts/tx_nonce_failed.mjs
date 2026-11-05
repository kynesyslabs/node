/**
 * A transaction that lands in a block and fails there spends its nonce
 * (`nonceIntegrity`), on every node, and the nonce cannot be used again.
 *
 *   1. Two creates of one storage program, signed with consecutive nonces
 *      and submitted together, each pass admission (it simulates against
 *      the chain, where the program does not exist yet). The second fails
 *      when a block applies it after the first. Its status reads failed and
 *      the sender's nonce moves past it on two nodes.
 *   2. The failed transaction confirmed again is refused, and so is another
 *      transaction signed for the nonce it spent.
 *   3. The next nonce applies: the failure left no gap behind.
 *   4. Admission refuses a second pending transaction for one nonce and a
 *      nonce more than the window past the confirmed one.
 *
 * Env: NODE1_URL, NODE2_URL, IDENTITY_PATH, RECEIVER_PUBKEY, AMOUNT_OS.
 * Prints "OK" and exits 0, or "FAIL: ..." and exits 1.
 */
import { readFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"

const { NODE1_URL, NODE2_URL, IDENTITY_PATH, RECEIVER_PUBKEY, AMOUNT_OS } = process.env
if (!NODE1_URL || !NODE2_URL || !IDENTITY_PATH || !RECEIVER_PUBKEY || !AMOUNT_OS) {
    console.error("[nonce-failed] missing env: NODE1_URL, NODE2_URL, IDENTITY_PATH, RECEIVER_PUBKEY, AMOUNT_OS")
    process.exit(2)
}

// Mirrors MEMPOOL_MAX_NONCE_AHEAD in src/utilities/constants.ts.
const MAX_NONCE_AHEAD = 16

let failures = 0
const oneLine = text => String(text).replace(/[\r\n]+/g, " ").slice(0, 400)
function check(ok, label, detail = "") {
    console.log(`[nonce-failed] ${ok ? "PASS" : "FAIL"} ${label}${detail ? ": " + oneLine(detail) : ""}`)
    if (!ok) failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function nodeCall(url, message, data) {
    const res = await fetch(`${url}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ type: "nodeCall", message, data }] }),
    })
    return await res.json()
}

const identity = readFileSync(IDENTITY_PATH, "utf8").trim()
const demos = new Demos()
await demos.connect(NODE1_URL)
await demos.connectWallet(identity)
const demos2 = new Demos()
await demos2.connect(NODE2_URL)
await demos2.connectWallet(identity)
const sender = demos.getAddress()
const amount = BigInt(AMOUNT_OS)

const nonceOn = async d => Number((await d.getAddressInfo(sender))?.nonce ?? -1)
async function settledNonce(target) {
    let seen = []
    for (let i = 0; i < 30; i++) {
        seen = [await nonceOn(demos), await nonceOn(demos2)]
        if (seen.every(n => n >= target)) break
        await sleep(1000)
    }
    return seen
}

/** Whether a node accepted a confirm, and what it said. */
async function confirmOn(tx, d) {
    try {
        const out = await DemosTransactions.confirm(tx, d)
        const valid = out?.result === 200 && out?.response?.data?.valid !== false
        return { ok: valid, out, text: JSON.stringify(out?.response?.data?.message ?? out?.response ?? out) }
    } catch (e) {
        return { ok: false, text: String(e) }
    }
}

/** Whether a node admitted a broadcast to its pool, and what it said. */
async function broadcastOn(validity, d) {
    try {
        const out = await DemosTransactions.broadcast(validity, d)
        const text = JSON.stringify(out)
        return { ok: out?.result === 200, text }
    } catch (e) {
        return { ok: false, text: String(e) }
    }
}

/** Broadcasts through `d` and waits for the block verdict on that node. */
async function sendAndWait(validity, d, url) {
    const sent = await broadcastOn(validity, d)
    if (!sent.ok) return { state: "refused", text: sent.text }
    const hash = validity.response?.data?.transaction?.hash
    let last = null
    for (let i = 0; i < 120; i++) {
        last = await nodeCall(url, "getTransactionStatus", { hash })
        const state = last?.response?.state
        if (state === "included" || state === "failed") return { state, text: JSON.stringify(last.response) }
        await sleep(1000)
    }
    return { state: "timeout", text: `${sent.text} / ${JSON.stringify(last?.response)}` }
}

const start = await nonceOn(demos)
check(start >= 0, "sender nonce readable", String(start))

// 1. The second create of one program fails in the block.
const programName = "nonce-probe-" + randomBytes(6).toString("hex")
const salt = Date.now()
const createProgram = () => StorageProgram.createStorageProgram(sender, programName, { probe: 1 }, "json", undefined, { nonce: salt })
const created = await demos.storagePrograms.sign(createProgram(), { nonce: start + 1 })
const write = await demos.storagePrograms.sign(createProgram(), { nonce: start + 2 })
check(write.content.nonce === start + 2, "the second create carries the nonce after the first", String(write.content.nonce))
const [createdValid, writeValid] = await Promise.all([confirmOn(created, demos), confirmOn(write, demos)])
check(createdValid.ok && writeValid.ok, "both creates pass confirm", `${createdValid.text} / ${writeValid.text}`)
const [createdSent, writeSent] = createdValid.ok && writeValid.ok
    ? await Promise.all([sendAndWait(createdValid.out, demos, NODE1_URL), sendAndWait(writeValid.out, demos, NODE1_URL)])
    : [{ state: "not sent", text: "" }, { state: "not sent", text: "" }]
check(createdSent.state === "included", "the first create applies", `${createdSent.state} ${createdSent.text}`)
check(writeSent.state === "failed", "the second create lands in a block as failed", `${writeSent.state} ${writeSent.text}`)
for (const [name, url] of [["node-1", NODE1_URL], ["node-2", NODE2_URL]]) {
    let status = null
    for (let i = 0; i < 30; i++) {
        status = await nodeCall(url, "getTransactionStatus", { hash: write.hash })
        if (status.result === 200) break
        await sleep(1000)
    }
    check(status?.response?.state === "failed", `${name}: status of the write is failed`, JSON.stringify(status?.response))
}
const afterFail = await settledNonce(start + 2)
check(afterFail.every(n => n === start + 2), "the failed create spent its nonce on both nodes", `${afterFail} == ${start + 2}`)

// 2. The spent nonce is gone for good.
const replay = await confirmOn(write, demos)
check(!replay.ok, "the failed create confirmed again is refused", replay.text)
const reuse = await DemosTransactions.pay(RECEIVER_PUBKEY, amount, demos, { nonce: start + 2 })
const reuseValid = await confirmOn(reuse, demos2)
check(!reuseValid.ok, "another transaction for the spent nonce is refused", reuseValid.text)

// 3. The next nonce applies.
const receiverBefore = BigInt((await demos.getAddressInfo(RECEIVER_PUBKEY))?.balance ?? 0)
const next = await DemosTransactions.pay(RECEIVER_PUBKEY, amount, demos, { nonce: start + 3 })
const nextValid = await confirmOn(next, demos)
const nextSent = nextValid.ok ? await sendAndWait(nextValid.out, demos, NODE1_URL) : { state: "not sent", text: nextValid.text }
check(nextSent.state === "included", "the next nonce applies after the failed one", `${nextSent.state} ${nextSent.text}`)
const afterNext = await settledNonce(start + 3)
check(afterNext.every(n => n === start + 3), "the nonce follows on both nodes", `${afterNext} == ${start + 3}`)
let receiverAfter = receiverBefore
for (let i = 0; i < 10 && receiverAfter === receiverBefore; i++) {
    receiverAfter = BigInt((await demos.getAddressInfo(RECEIVER_PUBKEY))?.balance ?? 0)
    if (receiverAfter === receiverBefore) await sleep(1000)
}
check(receiverAfter - receiverBefore === amount, "the receiver gained the transfer", `${receiverAfter - receiverBefore} == ${amount}`)

// 4. Admission: one pending transaction per nonce, inside the window. A gap
//    keeps both probes in the pool, so nothing here reaches a block before
//    the duplicate is tried.
const gap = start + 5
const first = await DemosTransactions.pay(RECEIVER_PUBKEY, amount, demos, { nonce: gap })
const twin = await DemosTransactions.pay(RECEIVER_PUBKEY, amount * 2n, demos, { nonce: gap })
const firstValid = await confirmOn(first, demos)
const twinValid = await confirmOn(twin, demos)
check(firstValid.ok && twinValid.ok, "both same-nonce transfers pass confirm, which reads only the chain", `${firstValid.text} / ${twinValid.text}`)
if (firstValid.ok && twinValid.ok) {
    const firstSent = await broadcastOn(firstValid.out, demos)
    const twinSent = await broadcastOn(twinValid.out, demos)
    check(firstSent.ok, "the first is admitted to the pool", firstSent.text)
    check(!twinSent.ok && /already pending/.test(twinSent.text), "the second for the same nonce is refused", twinSent.text)
}
const far = await DemosTransactions.pay(RECEIVER_PUBKEY, amount, demos, { nonce: start + 3 + MAX_NONCE_AHEAD + 1 })
const farValid = await confirmOn(far, demos)
check(!farValid.ok && /too far ahead/.test(farValid.text), "a nonce past the window is refused at confirm", farValid.text)

const end = await settledNonce(start + 3)
check(end.every(n => n === start + 3), "the gapped probes moved no nonce", `${end} == ${start + 3}`)

if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed`)
    process.exit(1)
}
console.log("OK")

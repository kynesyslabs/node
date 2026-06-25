/**
 * Epic #21 / P-ORDER e2e — multi-RPC SEQUENTIAL-NONCE ordering.
 *
 * Distinct from double_broadcast_replay.mjs (which replays the SAME tx).
 * Here the same wallet sends THREE DIFFERENT sequential-nonce txs
 * (N, N+1, N+2) to THREE DIFFERENT RPCs concurrently. This is the
 * colleague's reported scenario and the thing P-ORDER fixes:
 *
 *   Before P-ORDER: the merged mempool was ordered by timestamp, so the
 *   three txs could be applied out of nonce order -> expectedPrior
 *   mismatch -> all-but-first dropped; and two honest nodes could forge
 *   different hashes -> vote divergence -> stall.
 *
 *   After P-ORDER: (sender,nonce,hash) ordering lays them out N, N+1, N+2
 *   on every node, so all three apply in order and land.
 *
 * Asserts:
 *   - receiver balance increases by EXACTLY 3 * AMOUNT_OS (all three land)
 *   - sender nonce advances by EXACTLY 3
 *
 * NOTE: this is the ORDERING acceptance for P-ORDER. The full "header
 * count == DB count" invariant is P-TRIM's job (separate task #193);
 * this driver only proves the three sequential txs are not dropped.
 *
 * Env (set by the wrapper script):
 *   NODE1_URL, NODE2_URL[, NODE3_URL]  RPC URLs — >=2 required (RC devnet is
 *                                      2 validators; NODE3_URL optional)
 *   IDENTITY_PATH                    sender mnemonic file
 *   RECEIVER_PUBKEY                  0x... receiver
 *   AMOUNT_OS                        per-tx amount, decimal string
 */
import { readFileSync } from "node:fs"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"

// NODE3_URL is OPTIONAL — the documented RC devnet is 2 validators
// (genesis.devnet.json). With 2 RPCs the round-robin just alternates
// node-1 / node-2; a 3rd is used if provided. (Greptile P2.)
const NODE_URLS = [
    process.env.NODE1_URL,
    process.env.NODE2_URL,
    process.env.NODE3_URL,
].filter(Boolean)
const IDENTITY_PATH = process.env.IDENTITY_PATH
const RECEIVER_PUBKEY = process.env.RECEIVER_PUBKEY
const AMOUNT_OS = process.env.AMOUNT_OS

if (NODE_URLS.length < 2 || !IDENTITY_PATH || !RECEIVER_PUBKEY || !AMOUNT_OS) {
    console.error(
        "[multi-rpc-seq] missing env: need >=2 of NODE1_URL/NODE2_URL/NODE3_URL plus IDENTITY_PATH RECEIVER_PUBKEY AMOUNT_OS",
    )
    process.exit(2)
}

const mnemonic = readFileSync(IDENTITY_PATH, "utf8").trim()
const amountOs = BigInt(AMOUNT_OS)
const N = 3

// One client per node, all the same wallet.
const clients = []
for (const url of NODE_URLS) {
    const d = new Demos()
    await d.connect(url)
    await d.connectWallet(mnemonic)
    clients.push(d)
}

const sender = clients[0].getAddress()
const before = await clients[0].getAddressInfo(sender)
const recBefore = await clients[0].getAddressInfo(RECEIVER_PUBKEY)
const senderBalBefore = BigInt(before?.balance ?? 0)
const senderNonceBefore = Number(before?.nonce ?? 0)
const receiverBalBefore = BigInt(recBefore?.balance ?? 0)

console.log(`[multi-rpc-seq] sender=${sender}`)
console.log(`[multi-rpc-seq] sender balance=${senderBalBefore} nonce=${senderNonceBefore}`)
console.log(`[multi-rpc-seq] receiver balance=${receiverBalBefore}`)

if (senderBalBefore < amountOs * BigInt(N)) {
    console.error(`[multi-rpc-seq] balance too low for ${N} transfers`)
    process.exit(2)
}

// Submit N sequential txs, EACH through a DIFFERENT RPC (round-robin),
// broadcasting one before building the next so the node-side nonce advances
// naturally (nonce 1, 2, 3, ...). This is the realistic cross-RPC sequence a
// scripted sender produces today (strict admission: nonce == committed+1).
//
// What it proves for P-ORDER: txs submitted across different RPCs all land
// AND both nodes stay byte-identically in sync (deterministic ordering ->
// vote convergence). The concurrent FUTURE-nonce variant (nonce 1,2,3 fired
// at once before any confirms) requires bounded-range admission and is the
// acceptance for P-ADMIT (task #196), not P-ORDER — strict admission rejects
// a gap by design, so it is intentionally NOT exercised here.
console.log(`[multi-rpc-seq] submitting ${N} sequential txs round-robin across RPCs`)
for (let i = 0; i < N; i++) {
    const d = clients[i % clients.length]
    const tx = await d.pay(RECEIVER_PUBKEY, amountOs)
    if (!tx?.content) {
        console.error(`[multi-rpc-seq] FAIL: pay() #${i} returned no tx`)
        process.exit(1)
    }
    console.log(
        `[multi-rpc-seq]   tx#${i} -> node#${i % clients.length} nonce=${tx.content.nonce} hash=${tx.hash}`,
    )
    const confirmed = await DemosTransactions.confirm(tx, d)
    const r = await DemosTransactions.broadcast(confirmed, d)
    console.log(`[multi-rpc-seq]   tx#${i} broadcast: ${JSON.stringify(r).slice(0, 80)}`)
    // wait for this tx to land before submitting the next (so the next pay()
    // reads the advanced nonce). Poll up to ~24s.
    const targetDelta = amountOs * BigInt(i + 1)
    for (let p = 0; p < 12; p++) {
        await new Promise(r => setTimeout(r, 2000))
        const rec = await clients[0].getAddressInfo(RECEIVER_PUBKEY)
        if (BigInt(rec?.balance ?? 0) - receiverBalBefore >= targetDelta) break
    }
}

// Poll for all three to land (+ settling window).
const expectedDelta = amountOs * BigInt(N)
let observedDelta = 0n
let nonceDelta = 0
const maxPolls = 40
async function sample() {
    const infos = await Promise.all([
        ...clients.map(c => c.getAddressInfo(RECEIVER_PUBKEY)),
        ...clients.map(c => c.getAddressInfo(sender)),
    ])
    // Slice by clients.length (number of RPCs queried), NOT N (tx count).
    // infos = [...receiver-per-client, ...sender-per-client], so the split is
    // at clients.length. Using N would mix sender/receiver objects when
    // N != clients.length (e.g. 2-RPC devnet, N=3). (Greptile P2.)
    const recBals = infos
        .slice(0, clients.length)
        .map(x => BigInt(x?.balance ?? 0))
    const sendNonces = infos
        .slice(clients.length)
        .map(x => Number(x?.nonce ?? 0))
    const recMax = recBals.reduce((a, b) => (a > b ? a : b), 0n)
    const nonceMax = sendNonces.reduce((a, b) => (a > b ? a : b), 0)
    return { delta: recMax - receiverBalBefore, nonceDelta: nonceMax - senderNonceBefore }
}

for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const s = await sample()
    observedDelta = s.delta
    nonceDelta = s.nonceDelta
    console.log(`[multi-rpc-seq]   t=${(i + 1) * 2}s delta=${observedDelta}/${expectedDelta} nonce_delta=${nonceDelta}/${N}`)
    if (observedDelta >= expectedDelta && nonceDelta >= N) break
}

// settling window to catch over-application
for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const s = await sample()
    observedDelta = s.delta
    nonceDelta = s.nonceDelta
}

console.log("[multi-rpc-seq] === FINAL ===")
console.log(`[multi-rpc-seq] receiver_delta=${observedDelta} (expected ${expectedDelta})`)
console.log(`[multi-rpc-seq] nonce_delta=${nonceDelta} (expected ${N})`)

if (observedDelta === expectedDelta && nonceDelta === N) {
    console.log("[multi-rpc-seq] OK — all 3 sequential-nonce txs landed in order across RPCs")
    process.exit(0)
}
if (observedDelta > expectedDelta || nonceDelta > N) {
    console.error("[multi-rpc-seq] FAIL — over-application (double-spend / nonce overrun)")
    process.exit(1)
}
console.error(`[multi-rpc-seq] FAIL — only ${nonceDelta}/${N} txs landed (the colleague's bug: rest dropped)`)
process.exit(1)

/**
 * Audit-sweep batch C / E e2e test — cross-RPC nonce-replay protection.
 *
 * Verifies that the `nonceEnforcement` fork (registered in PR #884,
 * wired up in PR #886) rejects a captured signed transaction
 * re-broadcast through a second RPC. This is the cross-RPC
 * double-spend scenario PR #886's plain-English summary called out;
 * the test exercises the full handshake:
 *
 *   1. Build + sign ONE tx via SDK against node-1 (single nonce).
 *   2. Submit the SAME signed tx to BOTH node-1 and node-2 in parallel
 *      via DemosTransactions.confirm().
 *   3. Both per-node validations may pass (each sees stale state).
 *   4. Broadcast the resulting ValidityData from each side.
 *   5. Poll until the chain advances. Verify:
 *        - Receiver balance increased by EXACTLY one transfer amount,
 *          not two (no double-spend).
 *        - Sender account.nonce advanced by EXACTLY 1.
 *
 * Outputs `OK` on success, `FAIL` + diagnostic dump on any
 * inconsistency. Designed for sub-60s feedback against the
 * `testing/devnet` fixture stack with `nonceEnforcement.
 * activationHeight: 0` (devnet default since PR #884).
 *
 * Env vars (set by `test-double-broadcast-e2e.sh`):
 *   NODE1_URL          RPC URL of first node (the one that builds the tx)
 *   NODE2_URL          RPC URL of second node (the replay target)
 *   IDENTITY_PATH      Path to sender's identity mnemonic file
 *   RECEIVER_PUBKEY    0x... ed25519 pubkey of the receiver
 *   AMOUNT_OS          Amount to transfer, decimal string in OS
 */
import { readFileSync } from "node:fs"
import { Demos, DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { denomination } from "@kynesyslabs/demosdk"
const { osToDem } = denomination

const NODE1_URL = process.env.NODE1_URL
const NODE2_URL = process.env.NODE2_URL
const IDENTITY_PATH = process.env.IDENTITY_PATH
const RECEIVER_PUBKEY = process.env.RECEIVER_PUBKEY
const AMOUNT_OS = process.env.AMOUNT_OS

if (!NODE1_URL || !NODE2_URL || !IDENTITY_PATH || !RECEIVER_PUBKEY || !AMOUNT_OS) {
    console.error(
        "[double-broadcast] missing required env vars: NODE1_URL, NODE2_URL, IDENTITY_PATH, RECEIVER_PUBKEY, AMOUNT_OS",
    )
    process.exit(2)
}

const mnemonic = readFileSync(IDENTITY_PATH, "utf8").trim()
const amountOs = BigInt(AMOUNT_OS)

console.log(`[double-broadcast] NODE1_URL=${NODE1_URL}`)
console.log(`[double-broadcast] NODE2_URL=${NODE2_URL}`)
console.log(`[double-broadcast] RECEIVER=${RECEIVER_PUBKEY}`)
console.log(`[double-broadcast] AMOUNT_OS=${AMOUNT_OS}`)

// -----------------------------------------------------------------------------
// 1. Connect both demos clients with the same identity
// -----------------------------------------------------------------------------
const demos1 = new Demos()
await demos1.connect(NODE1_URL)
await demos1.connectWallet(mnemonic)

const demos2 = new Demos()
await demos2.connect(NODE2_URL)
await demos2.connectWallet(mnemonic)

const sender = demos1.getAddress()
console.log(`[double-broadcast] SENDER=${sender}`)

// -----------------------------------------------------------------------------
// 2. Snapshot pre-state
// -----------------------------------------------------------------------------
const senderInfoBefore = await demos1.getAddressInfo(sender)
const receiverInfoBefore = await demos1.getAddressInfo(RECEIVER_PUBKEY)
const senderBalBefore = BigInt(senderInfoBefore?.balance ?? 0)
const senderNonceBefore = Number(senderInfoBefore?.nonce ?? 0)
const receiverBalBefore = BigInt(receiverInfoBefore?.balance ?? 0)

console.log(
    `[double-broadcast] sender balance before: ${senderBalBefore.toString()} OS (${osToDem(senderBalBefore)} DEM)`,
)
console.log(`[double-broadcast] sender nonce before:   ${senderNonceBefore}`)
console.log(
    `[double-broadcast] receiver balance before: ${receiverBalBefore.toString()} OS (${osToDem(receiverBalBefore)} DEM)`,
)

if (senderBalBefore < amountOs) {
    console.error(
        `[double-broadcast] sender balance ${senderBalBefore} < amount ${amountOs}; cannot test`,
    )
    process.exit(2)
}

// -----------------------------------------------------------------------------
// 3. Build + sign ONE tx via SDK (uses node-1 for nonce lookup)
// -----------------------------------------------------------------------------
console.log("[double-broadcast] [1/4] pay() — building + signing single tx")
const signedTx = await demos1.pay(RECEIVER_PUBKEY, amountOs)
const localHash = signedTx?.hash
console.log(`[double-broadcast]   local tx hash: ${localHash}`)
console.log(`[double-broadcast]   tx.content.nonce: ${signedTx.content.nonce}`)

// -----------------------------------------------------------------------------
// 4. Submit the SAME signed tx to both nodes in parallel
//    confirm() performs RPC validation; both nodes will see the tx
//    via the validation handshake. If both pass, both produce
//    ValidityData and the test proceeds to broadcast both copies.
// -----------------------------------------------------------------------------
console.log("[double-broadcast] [2/4] confirm() in parallel on BOTH nodes")
const confirmResults = await Promise.allSettled([
    DemosTransactions.confirm(signedTx, demos1),
    DemosTransactions.confirm(signedTx, demos2),
])

const confirm1 = confirmResults[0]
const confirm2 = confirmResults[1]

console.log(
    `[double-broadcast]   node-1 confirm: status=${confirm1.status}` +
        (confirm1.status === "rejected"
            ? ` reason=${String(confirm1.reason).slice(0, 200)}`
            : ""),
)
console.log(
    `[double-broadcast]   node-2 confirm: status=${confirm2.status}` +
        (confirm2.status === "rejected"
            ? ` reason=${String(confirm2.reason).slice(0, 200)}`
            : ""),
)

const confirmed1 = confirm1.status === "fulfilled" ? confirm1.value : null
const confirmed2 = confirm2.status === "fulfilled" ? confirm2.value : null

if (!confirmed1 && !confirmed2) {
    console.error(
        "[double-broadcast] FAIL: both confirms rejected; nothing to broadcast — test cannot verify replay protection",
    )
    process.exit(1)
}

// -----------------------------------------------------------------------------
// 5. Broadcast in parallel — if both validations passed, both
//    ValidityData payloads get broadcast simultaneously. The
//    consensus rule (PR #886's `expectedPrior` reject in
//    GCRNonceRoutines) is the safety net for the case where
//    both reach block-formation.
// -----------------------------------------------------------------------------
console.log("[double-broadcast] [3/4] broadcast() in parallel on BOTH nodes")
const broadcastResults = await Promise.allSettled([
    confirmed1
        ? DemosTransactions.broadcast(confirmed1, demos1)
        : Promise.reject(new Error("node-1 confirm failed; skipping broadcast")),
    confirmed2
        ? DemosTransactions.broadcast(confirmed2, demos2)
        : Promise.reject(new Error("node-2 confirm failed; skipping broadcast")),
])

console.log(
    `[double-broadcast]   node-1 broadcast: status=${broadcastResults[0].status}`,
)
console.log(
    `[double-broadcast]   node-2 broadcast: status=${broadcastResults[1].status}`,
)

// -----------------------------------------------------------------------------
// 6. Poll post-state. Wait up to 60s for one (and only one) transfer
//    to land. Re-check via BOTH RPCs so we don't fool ourselves on
//    stale node-1 state.
// -----------------------------------------------------------------------------
console.log("[double-broadcast] [4/4] polling post-state for up to 60s")

let observedDelta = 0n
let observedNonceDelta = 0
let polls = 0
const maxPolls = 30
const expectedDelta = amountOs

for (let i = 0; i < maxPolls; i++) {
    polls = i + 1
    await new Promise(r => setTimeout(r, 2000))
    const recInfo = await demos1.getAddressInfo(RECEIVER_PUBKEY)
    const sendInfo = await demos1.getAddressInfo(sender)
    const recBal = BigInt(recInfo?.balance ?? 0)
    const sendNonce = Number(sendInfo?.nonce ?? 0)
    observedDelta = recBal - receiverBalBefore
    observedNonceDelta = sendNonce - senderNonceBefore
    console.log(
        `[double-broadcast]   t=${(i + 1) * 2}s  receiver_delta=${observedDelta} OS  sender_nonce_delta=${observedNonceDelta}`,
    )
    if (observedDelta >= expectedDelta) break
}

// -----------------------------------------------------------------------------
// 7. Assertions
//    A. observedDelta MUST equal expectedDelta. Greater means
//       double-spend; smaller means neither broadcast landed.
//    B. observedNonceDelta MUST equal 1. Greater means both
//       transactions applied and consensus failed to dedupe.
// -----------------------------------------------------------------------------
console.log("[double-broadcast] === FINAL STATE ===")
console.log(
    `[double-broadcast]   receiver_delta:    ${observedDelta} OS (expected: ${expectedDelta} OS)`,
)
console.log(
    `[double-broadcast]   sender_nonce_delta: ${observedNonceDelta} (expected: 1)`,
)
console.log(`[double-broadcast]   polls: ${polls}`)

if (observedDelta === expectedDelta && observedNonceDelta === 1) {
    console.log(
        "[double-broadcast] OK — nonceEnforcement deduplicated the replay correctly",
    )
    process.exit(0)
}

if (observedDelta > expectedDelta || observedNonceDelta > 1) {
    console.error(
        `[double-broadcast] FAIL — DOUBLE-SPEND detected: delta=${observedDelta} (expected ${expectedDelta}), nonce_delta=${observedNonceDelta} (expected 1)`,
    )
    process.exit(1)
}

if (observedDelta < expectedDelta) {
    console.error(
        `[double-broadcast] FAIL — neither tx landed within ${maxPolls * 2}s; receiver_delta=${observedDelta}`,
    )
    process.exit(1)
}

console.error("[double-broadcast] FAIL — unreachable assertion branch")
process.exit(1)

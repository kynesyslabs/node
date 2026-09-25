/**
 * End-to-end evidence for atomic Works on a 4-node devnet with the
 * atomicWork fork active. Start it with ./e2e.sh, not directly.
 *
 * Every transaction is built and signed with the SDK builder. The scenario
 * covers a DACS purchase end to end, the node-built receipt, refusals
 * (forged role signature, contended slot, undeclared effect, expired
 * deadline, payer other than the submitter), a replay, reading Works back
 * from a node that did not produce the block, and a validator killed and
 * recovered mid-run. It exits non-zero if any check fails.
 */
import crypto, { createHash, randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

// Run through ./e2e.sh, which brings the network up and sets these.
const NODE = process.env.NODE_ROOT ?? new URL("../..", import.meta.url).pathname
const SDK_BUILD = process.env.SDK_BUILD
if (!SDK_BUILD) throw new Error("SDK_BUILD must point at an SDK build with atomicWork support")
const { Demos, DemosTransactions } = await import(`${SDK_BUILD}/websdk/index.js`)
const { jcsCanonicalize } = await import(`${NODE}/src/libs/crypto/jcs.ts`)
const vectors = JSON.parse(readFileSync(`${NODE}/src/libs/atomic-work/__fixtures__/workid.vectors.json`, "utf8"))

const dev = process.env.IDENTITIES ?? `${NODE}/testing/devnet/identities`
const mnemonic = readFileSync(`${dev}/node1.identity`, "utf8").trim()
const SENDER = readFileSync(`${dev}/node1.pubkey`, "utf8").trim()
const PAYEE = readFileSync(`${dev}/node3.pubkey`, "utf8").trim()
const DBS = ["node1_db", "node2_db", "node3_db", "node4_db"]

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const hex = () => randomBytes(32).toString("hex")
const sql = (db: string, q: string) =>
    execFileSync("docker", ["exec", "demos-devnet-postgres", "psql", "-U", "demosuser", "-d", db, "-Atc", q]).toString().trim()
const everyNode = (q: string) => DBS.map(db => sql(db, q))
const step = (n: string) => console.log(`\n== ${n}`)
function check(ok: boolean, what: string) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}`)
    if (!ok) process.exitCode = 1
}
async function until(fn: () => boolean, secs = 90) {
    for (let i = 0; i < secs / 3; i++) {
        if (fn()) return true
        await new Promise(r => setTimeout(r, 3000))
    }
    return false
}

const demos = new Demos()
await demos.connect("http://localhost:53551")
await demos.connectWallet(mnemonic)

// A DACS purchase: the reference intent, a fresh job, and role keys a node can check.
function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
    return { hex: "0x" + publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"), privateKey }
}
function purchase(jobId: string, signWith?: Record<string, ReturnType<typeof keypair>>, expiresAt?: number, payerAccount = SENDER) {
    const keys = Object.fromEntries(["buyer", "seller", "orchestrator", "payer"].map(r => [r, keypair()]))
    const intent = structuredClone(vectors.cases[0].intent)
    intent.jobId = jobId
    if (expiresAt !== undefined) intent.expiresAt = expiresAt
    // The payer's native account is the one the payment debits: the submitter.
    intent.roleRoster = intent.roleRoster.map((r: any) => ({
        ...r,
        signer: keys[r.role].hex,
        ...(r.role === "payer" ? { nativeAccount: payerAccount } : {}),
    }))
    const workId = sha("dacs-atomic-work:v1:" + jcsCanonicalize(intent))
    const authorizations = intent.operations.flatMap((op: any, operationIndex: number) =>
        op.requiredRoles.map((role: string) => {
            const auth: Record<string, unknown> = {
                authorizationVersion: "1", algorithm: "ed25519", workId,
                executionProfile: intent.executionProfile, networkId: intent.networkId, railId: intent.railId,
                jobId: intent.jobId, phaseIndex: intent.phaseIndex, operationId: op.operationId, operationIndex,
                operationKind: op.kind, role, signer: keys[role].hex,
            }
            const signed = "dacs-atomic-work-authorization:v1:" + sha(jcsCanonicalize(auth))
            auth.value = crypto.sign(null, Buffer.from(signed), (signWith ?? keys)[role].privateKey).toString("base64url")
            return auth
        }),
    )
    return { intent, workId, authorizations, bytesHash: sha(jcsCanonicalize(intent)) }
}
function put(name: string, discriminator: string, value: Record<string, unknown>) {
    const target = "stor-" + sha("demos-atomic-storage-address:v1:" + jcsCanonicalize({ writer: SENDER, name, discriminator })).slice(0, 40)
    return { type: "storage-program-put", target, writer: SENDER, name, discriminator, mode: "create-only", valueDigest: sha(jcsCanonicalize(value)), value }
}
function purchaseEdits(p: ReturnType<typeof purchase>, slotKey: string, tag: string) {
    return [
        { type: "work-attempt", workId: p.workId, attemptId: `${tag}-a1`, canonicalBytesHash: p.bytesHash, attemptClass: "normal", replacementFor: null },
        put("buyer-vet", tag, { pass: true }),
        put("seller-vet", tag, { pass: true }),
        put("commitment", tag, { committed: tag }),
        { type: "resource-slot-cas", resourceKey: slotKey, expected: { state: "vacant", generation: 0 }, transition: "settle", workId: p.workId, conflictDigest: hex() },
    ]
}
async function send(payload: unknown) {
    try {
        const tx = await DemosTransactions.atomicWork(payload, demos)
        const res = await demos.broadcast(await demos.confirm(tx))
        return { tx, res, ok: res.result === 200 && res.response !== false && !res.extra?.error }
    } catch (e) {
        return { tx: null, res: { error: String(e) }, ok: false }
    }
}
const workRows = (id: string) => everyNode(`select count(*) from gcr_atomic_works where "workId"='${id}'`)

const slotKey = hex()
const w1 = purchase("JOB-" + hex().slice(0, 20))
const payeeBefore = everyNode(`select balance from gcr_main where pubkey='${PAYEE}'`)

step("1. a DACS purchase: 3 writes, a slot claim and a payment, all role-signed")
const r1 = await send({ intent: w1.intent, authorizations: w1.authorizations, edits: purchaseEdits(w1, slotKey, "w1"), transfers: [{ to: PAYEE, amount: "500000000000" }] })
console.log("broadcast:", JSON.stringify(r1.res.response ?? r1.res).slice(0, 160))
check(await until(() => workRows(w1.workId).every(c => c === "1")), "purchase recorded on all 4 nodes")
check(everyNode(`select state from gcr_resource_slots where "resourceKey"='${slotKey}'`).every(s => s === "settled"), "payment slot settled on every node")
check(everyNode(`select count(*) from gcr_storageprogram where metadata->'atomicWork' is not null`).every(c => c === "3"), "all three writes stored on every node")

step("1b. the node built the receipt and committed to it with the effects")
const receipts = everyNode(`select receipt::text from gcr_atomic_works where "workId"='${w1.workId}'`).map(r => JSON.parse(r))
const commitments = receipts.map(r => r.receiptCommitment)
check(commitments.every(c => /^[0-9a-f]{64}$/.test(c) && c === commitments[0]), "same receipt commitment on every node")
const { receiptCommitment: _drop, ...core } = receipts[0]
check(sha("dacs-atomic-work-receipt:v1:" + jcsCanonicalize(core)) === commitments[0], "commitment recomputes from the stored receipt")
check(everyNode(`select record->>'receiptCommitment' from gcr_resource_slots where "resourceKey"='${slotKey}'`).every(c => c === commitments[0]), "the settled slot names that receipt")
const landedAt = sql("node1_db", `select "blockNumber" from transactions where hash='${r1.tx.hash}'`)
check(receipts[0].blockRef.height === landedAt, `receipt names the block it landed in (${landedAt})`)
check(receipts[0].winningAttempt.nativeTransactionRef.value === r1.tx.hash, "receipt names the transaction that won")
const blockTs = Number(JSON.parse(sql("node1_db", `select (content#>>'{}') from blocks where number=${landedAt}`)).timestamp) * 1000
check(receipts.every(r => r.blockRef.timestamp === blockTs), `receipt carries the block's consensus time on every node (${blockTs})`)
check((receipts[0].operationResults as any[]).length === 6 && receipts[0].operationResults.every((o: any) => o.status === "committed"), "one committed result per operation")
const payeeAfter = everyNode(`select balance from gcr_main where pubkey='${PAYEE}'`)
check(payeeAfter.every((b, i) => BigInt(b) - BigInt(payeeBefore[i]) === 500000000000n), "payee paid exactly once on every node")

step("2. a purchase with a forged role signature is refused")
const impostor = Object.fromEntries(["buyer", "seller", "orchestrator", "payer"].map(r => [r, keypair()]))
const w2 = purchase("JOB-" + hex().slice(0, 20), impostor)
const r2 = await send({ intent: w2.intent, authorizations: w2.authorizations, edits: purchaseEdits(w2, hex(), "w2"), transfers: [{ to: PAYEE, amount: "700000000000" }] })
console.log("broadcast:", JSON.stringify(r2.res.extra ?? r2.res).slice(0, 200))
check(!r2.ok, "submission refused")

step("3. a second purchase on the same payment slot is refused")
const w3 = purchase("JOB-" + hex().slice(0, 20))
const r3 = await send({ intent: w3.intent, authorizations: w3.authorizations, edits: purchaseEdits(w3, slotKey, "w3"), transfers: [{ to: PAYEE, amount: "700000000000" }] })
console.log("broadcast:", JSON.stringify(r3.res.extra ?? r3.res).slice(0, 200))
check(!r3.ok, "submission refused")

step("4. a purchase whose effects differ from its intent is refused")
const w4 = purchase("JOB-" + hex().slice(0, 20))
const r4 = await send({ intent: w4.intent, authorizations: w4.authorizations, edits: purchaseEdits(w4, hex(), "w4"), transfers: [{ to: PAYEE, amount: "1" }, { to: PAYEE, amount: "1" }] })
console.log("broadcast:", JSON.stringify(r4.res.extra ?? r4.res).slice(0, 200))
check(!r4.ok, "submission refused")

step("4b. a purchase whose deadline has passed is refused")
const expired = purchase("JOB-" + hex().slice(0, 20), undefined, blockTs - 1)
const r4b = await send({ intent: expired.intent, authorizations: expired.authorizations, edits: purchaseEdits(expired, hex(), "w4b"), transfers: [{ to: PAYEE, amount: "1" }] })
console.log("broadcast:", JSON.stringify(r4b.res.extra ?? r4b.res).slice(0, 200))
check(!r4b.ok, "submission refused")

step("4c. a purchase whose payer is not the submitter is refused")
const relayed = purchase("JOB-" + hex().slice(0, 20), undefined, undefined, PAYEE)
const r4c = await send({ intent: relayed.intent, authorizations: relayed.authorizations, edits: purchaseEdits(relayed, hex(), "w4c"), transfers: [{ to: PAYEE, amount: "1" }] })
console.log("broadcast:", JSON.stringify(r4c.res.extra ?? r4c.res).slice(0, 220))
check(!r4c.ok, "submission refused")

await new Promise(r => setTimeout(r, 25000))
check([w2, w3, w4, expired, relayed].every(w => workRows(w.workId).every(c => c === "0")), "none of the refused purchases reached any node")
check(everyNode(`select balance from gcr_main where pubkey='${PAYEE}'`).every((b, i) => b === payeeAfter[i]), "payee received nothing more")

step("5. a replay of the purchase is accepted and writes nothing")
const beforeReplay = everyNode(`select balance||':'||nonce from gcr_main where pubkey='${SENDER}'`)
const r5 = await send({ intent: w1.intent, edits: [{ type: "work-attempt", workId: w1.workId, attemptId: "w1-replay", canonicalBytesHash: w1.bytesHash, attemptClass: "replay", replacementFor: null }] })
check(r5.ok && (await until(() => everyNode(`select count(*) from transactions where hash='${r5.tx.hash}' and status='confirmed'`).every(c => c === "1"))), "replay included on all 4 nodes")
check(everyNode(`select "winnerAttemptId" from gcr_atomic_works where "workId"='${w1.workId}'`).every(a => a === "w1-a1"), "winner unchanged")
const afterReplay = everyNode(`select balance||':'||nonce from gcr_main where pubkey='${SENDER}'`)
check(afterReplay.every((a, i) => {
    const [b0, n0] = beforeReplay[i].split(":"), [b1, n1] = a.split(":")
    return b0 === b1 && Number(n1) === Number(n0) + 1
}), "the replay spent the sender's nonce and charged no fee, on every node")

step("6. reading Works back from any node")
async function nodeCall(port: number, message: string, data: unknown) {
    const res = await fetch(`http://localhost:${port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data, muid: "e2e" }] }),
    })
    return (await res.json()) as { result: number; response: any }
}
function attested(answer: any): boolean {
    const { statement, attestation } = answer
    if (sha(jcsCanonicalize(statement)) !== attestation.digest) return false
    const key = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(attestation.signer.replace(/^0x/, ""), "hex")]),
        format: "der",
        type: "spki",
    })
    return crypto.verify(null, Buffer.from(attestation.digest), key, Buffer.from(attestation.signature.replace(/^0x/, ""), "hex"))
}
const caps = await Promise.all([53551, 53553].map(p => nodeCall(p, "getAtomicWorkCapability", {})))
check(caps.every(c => c.response.advertised && c.response.capability.profiles.includes("dacs-purchase-v1")), "capability advertised with the DACS purchase profile")
check(caps[0].response.digest === caps[1].response.digest, "two nodes advertise the same capability digest")
const rec = await nodeCall(53553, "getAtomicWorkReceipt", { workId: w1.workId })
check(rec.result === 200 && rec.response.verified === true, "receipt served by a node that did not produce the block, and it verifies")
check(rec.response.receiptCommitment === commitments[0] && rec.response.block.hash === sql("node3_db", `select hash from blocks where number=${landedAt}`), "served receipt names the committed block")
const st1 = await nodeCall(53553, "getAtomicWorkStatus", { workId: w1.workId })
check(st1.response.statement.state === "included-committed" && attested(st1.response), "purchase: included-committed, signed by the node")
const st2 = await nodeCall(53553, "getAtomicWorkStatus", { workId: w2.workId })
check(st2.response.statement.state === "unknown" && attested(st2.response), "refused purchase: unknown (indeterminate), signed")
const st5 = await nodeCall(53553, "getAtomicWorkStatus", { txHash: r5.tx.hash })
check(st5.response.statement.state === "included-replay" && attested(st5.response), "replay transaction: included-replay, signed")
const forged = structuredClone(st1.response)
forged.statement.state = "unknown"
check(!attested(forged), "a tampered status no longer verifies")

step("7. all nodes agree")
const snap = (db: string) =>
    sql(db, `select md5(coalesce(string_agg("workId"||"winnerAttemptId"||coalesce("receiptCommitment",''), ',' order by "workId"),'')) from gcr_atomic_works`) +
    sql(db, `select md5(coalesce(string_agg(pubkey||balance, ',' order by pubkey),'')) from gcr_main`) +
    sql(db, `select hash from blocks order by number desc offset 1 limit 1`)
const snaps = DBS.map(snap)
check(snaps.every(s => s === snaps[0]), "Work state, every balance and the block hash identical on all 4 nodes")
step("8. a node killed mid-run recovers and agrees")
execFileSync("docker", ["kill", "-s", "KILL", "demos-devnet-node-3"])
const w8 = purchase("JOB-" + hex().slice(0, 20))
const slot8 = hex()
const r8 = await send({ intent: w8.intent, authorizations: w8.authorizations, edits: purchaseEdits(w8, slot8, "w8"), transfers: [{ to: PAYEE, amount: "1000" }] })
check(r8.ok, "a purchase commits while a node is down")
const upNodes = ["node1_db", "node2_db", "node4_db"]
check(await until(() => upNodes.every(db => sql(db, `select count(*) from gcr_atomic_works where "workId"='${w8.workId}'`) === "1")), "the running nodes record it")
execFileSync("docker", ["start", "demos-devnet-node-3"])
check(await until(() => sql("node3_db", `select count(*) from gcr_atomic_works where "workId"='${w8.workId}'`) === "1", 240), "the killed node catches up and records the same Work")
const height = sql("node1_db", "select max(number) from blocks")
await until(() => Number(sql("node3_db", "select coalesce(max(number),0) from blocks")) >= Number(height), 120)
const recovered = DBS.map(snap)
check(recovered.every(s => s === recovered[0]), "after recovery, Work state, balances and block hash match on all 4 nodes")

console.log(process.exitCode ? "\nE2E FAILED" : "\nE2E PASSED")

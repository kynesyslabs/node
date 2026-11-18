#!/usr/bin/env bun
/**
 * L2PS settlement end to end on a 4-validator devnet (run through run.sh).
 * node-1 and node-2 are subnet members, node-3 and node-4 are not.
 *
 *   00-network     chain up, membership as configured, fork active, baseline state
 *   01-happy       settled transfers via the SDK land in l2psBatch txs; every
 *                  validator holds the same balances, nonces, fee credits and
 *                  GCR digests (DEM-816 EXPECT=fixed); supply conserved
 *   02-failures    bad signature, replays, nonce too far ahead, overdraft,
 *                  old-format transfer, cross-member double spend and
 *                  overdraft: refused or failed with no edits; zero-amount
 *                  transfer to a fresh receiver settles
 *   03-restart     a member is killed while holding admitted transfers and
 *                  catches up via Sync to the same state
 *   04-throughput  3N transfers (TP_TRANSFERS) with L1 load beside them: L2PS TPS, proof
 *                  time, submit-to-applied time, block times, main TPS
 *   05-final       every height's block hash and the whole state agree
 *
 * Batch size and limits come from the node's settlement code, never assumed.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { SETTLEMENT_TRANSFERS } from "../../src/libs/l2ps/settlement/encoding"
import { MAX_NONCE_AHEAD } from "../../src/libs/l2ps/settlement/transfer"
import {
    EVIDENCE_DIR, MEMBERS, NODES, RUN_DIR, UID, accountOn, blockAt, blockTimeMs, changedAccounts, check, checks,
    client, compose, docker, evidence, followSettlement, json, nodeCall, quantiles, quiescentStates, replayEnvelope,
    say, sendTransfer, sleep, stateDifferences, stateSummary, step, tip, tips, txStatus, waitBlocks, waitHeight,
    type NodeState, type SendResult, type Settlement,
} from "./lib"
import { DEM, throughputTransfers, type Wallet } from "./wallets"

const N = SETTLEMENT_TRANSFERS
const W: Record<string, Wallet> = JSON.parse(readFileSync(`${RUN_DIR}/inputs/wallets.secret.json`, "utf8"))
const SETTLE_MS = Number(process.env.SETTLE_TIMEOUT_S ?? 900) * 1000
const L1_TPS = Number(process.env.L1_TPS ?? 2)
const [n1, n2, n3] = NODES
const metrics: Record<string, unknown> = {}
const allSends: SendResult[] = []
const allSettled = new Map<string, Settlement>()
let chainId = -1
let genesisSupply = -1n
let firstHeight = 0
let l1SupplyDelta = 0n

// ---- helpers --------------------------------------------------------------------

/** Every validator's reading agrees, compared under one check id. */
function agree(id: string, label: string, states: NodeState[]): boolean {
    const diffs = stateDifferences(states)
    evidence(`${id}-state`, stateSummary(states))
    return check(
        id,
        `${label}: all 4 validators hold the same block hash, balances, nonces and GCR digests at height ${states[0].height}`,
        diffs.length === 0,
        diffs.length === 0 ? `balances digest ${states[0].balancesDigest}, ${states[0].accounts} accounts` : diffs.join("; "),
    )
}

type Expected = Map<string, { delta: bigint; nonceDelta: number }>
function expectTransfer(exp: Expected, s: SendResult) {
    const add = (a: string, d: bigint, n: number) => {
        const e = exp.get(a) ?? { delta: 0n, nonceDelta: 0 }
        e.delta += d
        e.nonceDelta += n
        exp.set(a, e)
    }
    add(s.sender, -(s.amount + s.fee), 1)
    add(s.to, s.amount, 0)
}

/**
 * On every node, each listed account moved exactly as expected (zero for an
 * account expected not to move), and supply is unchanged.
 */
function checkDeltas(
    id: string, before: NodeState[], after: NodeState[], exp: Expected, watch: string[] = [], checkSupply = true,
) {
    const accounts = new Set([...exp.keys(), ...watch])
    const problems: string[] = []
    // whatever else moved (fee recipients, L1 load), kept to explain a supply change
    const others: Record<string, string> = {}
    let othersNet = 0n
    for (const [a, m] of changedAccounts(before[0], after[0])) {
        if (accounts.has(a)) continue
        others[label(a)] = `${m.delta}/${m.nonceDelta}`
        othersNet += m.delta
    }
    evidence(`${id}-other-movers`, { node: after[0].node, net: othersNet, accounts: others })
    for (let k = 0; k < after.length; k++) {
        const moved = changedAccounts(before[k], after[k])
        for (const a of accounts) {
            const e = exp.get(a) ?? { delta: 0n, nonceDelta: 0 }
            const m = moved.get(a) ?? { delta: 0n, nonceDelta: 0 }
            if (m.delta !== e.delta || m.nonceDelta !== e.nonceDelta) {
                problems.push(`${after[k].node} ${label(a)}: moved ${m.delta}/${m.nonceDelta}, expected ${e.delta}/${e.nonceDelta}`)
            }
        }
        if (checkSupply && after[k].totalSupply !== before[k].totalSupply) {
            problems.push(`${after[k].node} supply ${before[k].totalSupply} -> ${after[k].totalSupply}`)
        }
    }
    return check(
        id,
        `balances and nonces of ${accounts.size} accounts moved exactly as the transfers say on all 4 validators${checkSupply ? "; supply unchanged" : ""}`,
        problems.length === 0,
        problems.slice(0, 20).join("; "),
    )
}

/** Fees the participants paid are exactly what the fee recipients received, on every node. */
function checkFees(id: string, before: NodeState[], after: NodeState[], participants: Set<string>, fees: bigint) {
    const problems: string[] = []
    const recipients: Record<string, string> = {}
    for (let k = 0; k < after.length; k++) {
        let credited = 0n
        for (const [a, m] of changedAccounts(before[k], after[k])) {
            if (participants.has(a)) continue
            credited += m.delta
            if (k === 0) recipients[a] = m.delta.toString()
        }
        if (credited !== fees) problems.push(`${after[k].node} credited ${credited} to fee recipients, transfers paid ${fees}`)
    }
    evidence(`${id}-fee-recipients`, recipients)
    return check(
        id,
        `fee credits: the ${fees} OS of settlement fees reach the same recipients on all 4 validators`,
        problems.length === 0,
        problems.length === 0 ? `recipients ${Object.keys(recipients).length}` : problems.join("; "),
    )
}

const labelOf = new Map(Object.values(W).map(w => [w.address, w.label]))
function label(a: string) {
    return labelOf.get(a) ?? `${a.slice(0, 10)}…`
}

/** Each batch hash is included, with the same block, on every validator. */
async function checkBatches(id: string, hashes: string[], want: "included" | "failed" = "included") {
    const rows: Record<string, unknown> = {}
    const problems: string[] = []
    for (const h of hashes) {
        const per = await Promise.all(NODES.map(n => txStatus(n, h)))
        rows[h] = per.map((p, k) => ({ node: NODES[k].name, state: p?.state, block: p?.blockNumber, code: p?.code, message: p?.message }))
        const states = new Set(per.map(p => `${p?.state}@${p?.blockNumber}`))
        if (states.size !== 1 || per[0]?.state !== want) problems.push(`${h.slice(0, 12)}: ${[...states].join(",")}`)
    }
    evidence(`${id}-batches`, rows)
    return check(id, `${hashes.length} l2psBatch tx(s) ${want} in the same block on all 4 validators`, problems.length === 0 && hashes.length > 0, problems.join("; "))
}

function record(name: string, sends: SendResult[], settled?: Map<string, Settlement>) {
    evidence(
        name,
        sends.map(s => ({
            tag: s.tag, from: s.from, to: label(s.to), via: s.via, amount: s.amount, fee: s.fee, nonce: s.nonce,
            accepted: s.accepted, stage: s.stage, message: s.message.slice(0, 400), innerHash: s.innerHash, outerHash: s.outerHash,
            submittedAt: s.submittedAt, settlement: settled?.get(s.innerHash),
        })),
    )
}

async function send(tag: string, from: string, via: typeof n1, o: Parameters<typeof sendTransfer>[3]) {
    const s = await sendTransfer(tag, W[from], via, o)
    allSends.push(s)
    say(`${tag}: ${from} -> ${label(o.to)} ${o.amount} OS via ${via.name} nonce ${s.nonce}: ${s.accepted ? "accepted" : `refused at ${s.stage}`} ${s.accepted ? "" : s.message.slice(0, 200)}`)
    return s
}

async function nonceOf(address: string): Promise<number> {
    return (await accountOn(n3, address))?.nonce ?? 0
}

async function pool<T, R>(items: T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    await Promise.all(
        Array.from({ length: Math.min(width, items.length) }, async () => {
            while (next < items.length) {
                const k = next++
                out[k] = await fn(items[k])
            }
        }),
    )
    return out
}

function settledHashes(settled: Map<string, Settlement>, status = "confirmed"): string[] {
    return [...new Set([...settled.values()].filter(s => s.status === status && s.l1BatchHash).map(s => s.l1BatchHash!))]
}

// ---- steps ----------------------------------------------------------------------

await step("00-network", async () => {
    const t = await waitHeight(3, NODES, 600_000)
    check("00.chain", "all 4 validators produce blocks", t.every(x => x >= 3), `tips ${t.join("/")}`)
    firstHeight = Math.min(...t)
    const info = await nodeCall(n1, "getNetworkInfo")
    const fork = info.response?.forks?.l2psSettlement
    check("00.fork", "l2psSettlement is active", fork?.activated === true && fork?.activationHeight === 0, json(fork))
    chainId = (await (await client(W.hs0, n1)).getNetworkInfo())?.chainId
    check("00.chainid", "the node reports the chain id the SDK signs for", typeof chainId === "number", `chain id ${chainId}`)
    const part = await Promise.all(NODES.map(n => nodeCall(n, "getL2PSParticipationById", { l2psUid: UID })))
    const flags = part.map(p => p.response?.participating === true)
    check(
        "00.members",
        "node-1 and node-2 are subnet members, node-3 and node-4 are not",
        flags.join() === "true,true,false,false",
        `participating ${flags.join("/")}`,
    )
    const states = await quiescentStates()
    agree("00.baseline", "baseline", states)
    genesisSupply = states[0].totalSupply
    metrics.settlementTransfersPerBatch = N
    metrics.maxNonceAhead = Number(MAX_NONCE_AHEAD)
})

await step("01-happy", async () => {
    const before = await quiescentStates()
    const sends: SendResult[] = []
    // n single senders, alternating between the members; accounts never cross members
    const singles = Array.from({ length: N }, (_, i) => ({ i, via: i % 2 === 0 ? n1 : n2 }))
    sends.push(...(await pool(singles, 6, ({ i, via }) => send("happy", `hs${i}`, via, { to: W[`hr${i}`].address, amount: BigInt(i + 1) * DEM }))))
    // one sender, three consecutive nonces in one member's queue: to a funded
    // receiver, a fresh account and another sender of the same member
    const base = await nonceOf(W.hm.address)
    const multi: [string, bigint][] = [[W.hr0.address, 5n * DEM], [W.hx.address, 7n * DEM], [W.hs2.address, 3n * DEM]]
    for (let k = 0; k < multi.length; k++) {
        sends.push(await send("happy-multi", "hm", n1, { to: multi[k][0], amount: multi[k][1], nonce: base + 1 + k }))
    }
    check("01.admitted", `all ${sends.length} SDK-built settled transfers admitted by the members`, sends.every(s => s.accepted),
        sends.filter(s => !s.accepted).map(s => `${s.from}: ${s.message.slice(0, 160)}`).join("; "))

    const settled = await followSettlement(sends, W, SETTLE_MS)
    for (const [k, v] of settled) allSettled.set(k, v)
    record("01-happy-transfers", sends, settled)
    const confirmed = sends.filter(s => settled.get(s.innerHash)?.status === "confirmed")
    check("01.settled", `all ${sends.length} transfers confirmed in an l2psBatch`, confirmed.length === sends.length,
        `${confirmed.length}/${sends.length} confirmed; others ${sends.filter(s => !confirmed.includes(s)).map(s => `${s.from}=${settled.get(s.innerHash)?.status}:${settled.get(s.innerHash)?.message ?? ""}`).join(", ")}`)
    const batches = settledHashes(settled)
    await checkBatches("01.batches", batches)
    metrics.happyBatches = batches.length

    await waitBlocks(1)
    const after = await quiescentStates()
    agree("01.agree", "DEM-816 EXPECT=fixed after settled transfers", after)
    const exp: Expected = new Map()
    for (const s of confirmed) expectTransfer(exp, s)
    checkDeltas("01.deltas", before, after, exp)
    const participants = new Set(sends.flatMap(s => [s.sender, s.to]))
    checkFees("01.fees", before, after, participants, confirmed.reduce((a, s) => a + s.fee, 0n))
    // non-members hold no subnet plaintext but apply the same net changes
    const n3view = await Promise.all(sends.map(s => accountOn(n3, s.to)))
    check("01.nonmember", "node-3 (not a member) shows every receiver's balance", n3view.every(v => v !== null))
})

await step("02-failures", async () => {
    const before = await quiescentStates()
    const sends: SendResult[] = []
    const refused = async (tag: string, s: SendResult, pattern: RegExp, what: string) => {
        sends.push(s)
        // A node's answer only: an SDK build error can match the same words
        // without the transfer ever reaching admission.
        const answered = s.stage === "confirm" || s.stage === "broadcast"
        check(`02.${tag}`, `${what} is refused at admission`, !s.accepted && answered && pattern.test(s.message), `${s.stage}: ${s.message.slice(0, 300)}`)
    }
    const fr = W.fr.address
    await refused("badsig", await send("bad-signature", "fsig", n1, { to: fr, amount: DEM, chainId: chainId + 1 }), /signature/i,
        "a transfer whose settlement signature is for another chain")
    await refused("oldformat", await send("old-format", "fold", n1, { to: fr, amount: DEM, settle: false }), /old-format/i,
        "an old-format (pre-settlement) L2PS transfer")
    const aheadBase = await nonceOf(W.fahead.address)
    await refused("ahead", await send("nonce-too-far-ahead", "fahead", n1, {
        to: fr, amount: DEM, nonce: aheadBase + Number(MAX_NONCE_AHEAD) + 1, outerNonce: aheadBase + 1,
    }), /past the account nonce|too far ahead/i, `a nonce more than MAX_NONCE_AHEAD (${MAX_NONCE_AHEAD}) past the account nonce`)
    await refused("overdraft", await send("overdraft", "fover", n1, { to: fr, amount: 5n * DEM }), /insufficient/i,
        "a transfer of the whole balance plus fee (overdraft)")
    // a fresh envelope nonce, so the refusal is the settlement layer's own
    const hs0Nonce = await nonceOf(W.hs0.address)
    await refused("spent", await send("spent-nonce", "hs0", n1, { to: fr, amount: DEM, nonce: hs0Nonce, outerNonce: hs0Nonce + 1 }),
        /already spent/i, "a transfer reusing a nonce settlement already spent")
    const original = allSends.find(s => s.from === "hs0" && s.tag === "happy")!
    for (const via of MEMBERS) {
        const r = await replayEnvelope("replay", W.hs0, via, original)
        allSends.push(r)
        await refused(`replay-${via.name}`, r, /already|duplicate|processed|spent|nonce/i,
            `the exact envelope of a settled transfer, replayed to ${via.name}`)
    }

    // zero amount to a fresh receiver, the double spend across members and the
    // overdraft split across members, all at once
    const dblNonce = (await nonceOf(W.fdbl.address)) + 1
    const ovxNonce = (await nonceOf(W.fovx.address)) + 1
    const [zero, dblA, dblB, ovxA] = await Promise.all([
        send("zero-amount", "fzero", n2, { to: W.fz.address, amount: 0n }),
        send("double-spend", "fdbl", n1, { to: W.frA.address, amount: 10n * DEM, nonce: dblNonce }),
        send("double-spend", "fdbl", n2, { to: W.frB.address, amount: 10n * DEM, nonce: dblNonce }),
        send("cross-overdraft", "fovx", n1, { to: W.frC.address, amount: 10n * DEM, nonce: ovxNonce }),
    ])
    const ovxB = await send("cross-overdraft", "fovx", n2, { to: W.frD.address, amount: 10n * DEM, nonce: ovxNonce + 1 })
    sends.push(zero, dblA, dblB, ovxA, ovxB)
    check("02.racers-admitted", "the zero-amount transfer and the first cross-member transfers are admitted",
        zero.accepted && ovxA.accepted && (dblA.accepted || dblB.accepted),
        [zero, dblA, dblB, ovxA, ovxB].map(s => `${s.tag}@${s.via}=${s.accepted ? "accepted" : s.message.slice(0, 120)}`).join("; "))

    const settled = await followSettlement([zero, dblA, dblB, ovxA], W, SETTLE_MS)
    // The second overdraft half waits for a nonce and then a balance it never gets.
    const ovxBState = (await followSettlement([ovxB], W, 20_000, ["confirmed", "failed"])).get(ovxB.innerHash)
    if (ovxBState) settled.set(ovxB.innerHash, ovxBState)
    for (const [k, v] of settled) allSettled.set(k, v)
    record("02-failure-transfers", sends, settled)

    check("02.zero", "a zero-amount transfer to a fresh receiver settles", settled.get(zero.innerHash)?.status === "confirmed",
        json(settled.get(zero.innerHash)))
    const dblStates = [dblA, dblB].filter(s => s.accepted).map(s => settled.get(s.innerHash)?.status)
    check("02.double", "the same nonce sent through both members settles exactly once; the other ends failed",
        dblStates.filter(x => x === "confirmed").length === 1 && dblStates.every(x => x === "confirmed" || x === "failed"),
        [dblA, dblB].map(s => `${s.via}: ${s.accepted ? `${settled.get(s.innerHash)?.status} ${settled.get(s.innerHash)?.message ?? ""}` : `refused ${s.message.slice(0, 120)}`}`).join("; "))
    check("02.cross-overdraft", "the overdraft split across members settles its first half only",
        settled.get(ovxA.innerHash)?.status === "confirmed" && !["confirmed"].includes(settled.get(ovxB.innerHash)?.status ?? "refused"),
        `first ${settled.get(ovxA.innerHash)?.status}; second ${ovxB.accepted ? settled.get(ovxB.innerHash)?.status : `refused ${ovxB.message.slice(0, 120)}`}`)

    // a losing double-spend batch that L1 included as failed must read failed everywhere
    const failedBatches = [...new Set([dblA, dblB].map(s => settled.get(s.innerHash)).filter(s => s?.status === "failed" || s?.status === "pending")
        .flatMap(s => (s?.l1BatchHash ? [s.l1BatchHash] : [])))]
    const loserTrail: Record<string, unknown> = {}
    for (const h of failedBatches) loserTrail[h] = await Promise.all(NODES.map(n => txStatus(n, h)))
    evidence("02-double-spend-loser-batches", loserTrail)
    metrics.doubleSpendLoserPath = failedBatches.length > 0 ? "batch included as failed on L1, then dropped" : "dropped before L1 (nonce spent at planning)"
    if (failedBatches.length > 0) await checkBatches("02.double-l1", failedBatches, "failed")

    await checkBatches("02.batches", settledHashes(settled))
    await waitBlocks(1)
    const after = await quiescentStates()
    agree("02.agree", "after the failure cases", after)
    const exp: Expected = new Map()
    for (const s of [zero, dblA, dblB, ovxA, ovxB]) if (settled.get(s.innerHash)?.status === "confirmed") expectTransfer(exp, s)
    const watch = ["fsig", "fold", "fahead", "fover", "hs0", "fr", "fdbl", "frA", "frB", "fovx", "frC", "frD", "fz"].map(l => W[l].address)
    checkDeltas("02.deltas", before, after, exp, watch)
    const fz = after.map(s => s.balances.get(W.fz.address))
    check("02.zero-receiver", "the fresh zero-amount receiver reads the same (balance 0) on every validator",
        new Set(fz.map(x => (x ? `${x.balance}/${x.nonce}` : "absent"))).size === 1 && (fz[0]?.balance ?? 0n) === 0n,
        fz.map((x, k) => `${after[k].node}=${x ? `${x.balance}/${x.nonce}` : "absent"}`).join(" "))
})

await step("03-restart", async () => {
    const before = await quiescentStates()
    const sends = await pool(Array.from({ length: N }, (_, i) => i), 6, i =>
        send("restart", `rs${i}`, i % 2 === 0 ? n1 : n2, { to: W[`rr${i}`].address, amount: BigInt(i + 1) * DEM }))
    check("03.admitted", "transfers admitted before the restart", sends.every(s => s.accepted))
    await sleep(3000)
    const killedAt = await tip(n1)
    const killed = compose(["kill", "node-2"])
    say(`node-2 killed at height ${killedAt}: ${killed.out.slice(0, 200)}`)
    // A node-2 that is still up would let every check below pass without
    // the restart they are about.
    let down = killed.ok
    for (const t0 = Date.now(); down && Date.now() - t0 < 30_000 && (await tip(n2)) >= 0; ) await sleep(1000)
    down = down && (await tip(n2)) < 0
    if (!check("03.killed", "node-2 is down before the restart is measured", down, killed.out.slice(0, 200))) {
        throw new Error("node-2 could not be stopped")
    }
    const others = NODES.filter(n => n !== n2)
    const during = await waitBlocks(4, others, 240_000)
    check("03.liveness", "the other 3 validators keep producing blocks while node-2 is down", during.every(t => t >= killedAt + 4),
        `from ${killedAt} to ${during.join("/")}`)
    const restarted = compose(["start", "node-2"])
    const restartedAt = Math.max(...(await Promise.all(others.map(tip))))
    say(`node-2 started at height ${restartedAt}: ${restarted.out.slice(0, 200)}`)
    const t0 = Date.now()
    let caught = false
    while (Date.now() - t0 < 600_000) {
        const t = await tips()
        if (t[1] >= 0 && t[1] >= Math.min(...others.map((_, k) => t[NODES.indexOf(others[k])]))) {
            caught = true
            break
        }
        await sleep(2000)
    }
    metrics.restartCatchUpSeconds = Math.round((Date.now() - t0) / 1000)
    check("03.caughtup", "node-2 catches up to the others' tip via Sync", caught, `in ${metrics.restartCatchUpSeconds} s, from ${restartedAt}`)

    const settled = await followSettlement(sends, W, SETTLE_MS)
    for (const [k, v] of settled) allSettled.set(k, v)
    record("03-restart-transfers", sends, settled)
    const confirmed = sends.filter(s => settled.get(s.innerHash)?.status === "confirmed")
    check("03.settled", "every transfer, including those node-2 held when it died, settles", confirmed.length === sends.length,
        `${confirmed.length}/${sends.length}; ${sends.filter(s => !confirmed.includes(s)).map(s => `${s.from}@${s.via}=${settled.get(s.innerHash)?.status}`).join(", ")}`)
    await checkBatches("03.batches", settledHashes(settled))
    await waitBlocks(1)
    const after = await quiescentStates()
    agree("03.agree", "after the member restart", after)
    const exp: Expected = new Map()
    for (const s of confirmed) expectTransfer(exp, s)
    checkDeltas("03.deltas", before, after, exp)
})

await step("04-throughput", async () => {
    const before = await quiescentStates()
    const startHeight = before[0].height
    // L1 load beside the subnet traffic, from an account no transfer touches
    const l1 = await client(W.l1, n3)
    let l1Nonce = await nonceOf(W.l1.address)
    const l1Sends: { hash: string; at: number; ok: boolean; message?: string }[] = []
    let loading = L1_TPS > 0
    const l1Loop = (async () => {
        while (loading) {
            const tickAt = Date.now()
            try {
                const to = "0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
                const signed = await l1.pay(to, 1_000_000n, { nonce: l1Nonce + 1 })
                const validity: any = await l1.confirm(signed)
                const res: any = await l1.broadcast(validity)
                const ok = res?.result === 200
                // a refused nonce is sent again, so the load never gaps its own nonces
                if (ok) l1Nonce++
                l1Sends.push({ hash: validity?.response?.data?.transaction?.hash ?? signed.hash, at: tickAt, ok, message: ok ? undefined : json(res).slice(0, 200) })
            } catch (error) {
                l1Sends.push({ hash: "", at: tickAt, ok: false, message: String(error).slice(0, 200) })
            }
            await sleep(Math.max(0, 1000 / L1_TPS - (Date.now() - tickAt)))
        }
    })()

    const t0 = Date.now()
    const sends = await pool(Array.from({ length: throughputTransfers(N) }, (_, i) => i), 8, i =>
        send("throughput", `tp${i}`, i % 2 === 0 ? n1 : n2, { to: W[`tq${i}`].address, amount: BigInt(1 + (i % 7)) * DEM }))
    const submitSeconds = (Date.now() - t0) / 1000
    check("04.admitted", `${sends.length} transfers admitted`, sends.every(s => s.accepted), `submitted in ${submitSeconds.toFixed(1)} s`)
    const settled = await followSettlement(sends, W, SETTLE_MS)
    loading = false
    await l1Loop
    for (const [k, v] of settled) allSettled.set(k, v)
    record("04-throughput-transfers", sends, settled)
    const confirmed = sends.filter(s => settled.get(s.innerHash)?.status === "confirmed")
    check("04.settled", "all throughput transfers settle", confirmed.length === sends.length, `${confirmed.length}/${sends.length}`)
    const batches = settledHashes(settled)
    await checkBatches("04.batches", batches)

    // applied time = timestamp of the block that carries the batch
    const blockTimes = new Map<number, number | null>()
    const timeOf = async (h: number) => {
        if (!blockTimes.has(h)) blockTimes.set(h, blockTimeMs(await blockAt(n3, h)))
        return blockTimes.get(h)!
    }
    const latencies: number[] = []
    let lastApplied = 0
    for (const s of confirmed) {
        const st = settled.get(s.innerHash)!
        const applied = st.l1Block !== null ? await timeOf(st.l1Block) : null
        if (applied !== null) {
            latencies.push(applied - s.submittedAt)
            lastApplied = Math.max(lastApplied, applied)
        }
    }
    const firstSubmit = Math.min(...sends.map(s => s.submittedAt))
    const windowS = (lastApplied - firstSubmit) / 1000
    metrics.settlementProvers = Number(process.env.SETTLEMENT_PROVERS ?? 1)
    metrics.l2psTps = confirmed.length > 0 && windowS > 0 ? Number((confirmed.length / windowS).toFixed(3)) : 0
    metrics.l2psWindowSeconds = Math.round(windowS)
    metrics.l2psTransfers = confirmed.length
    metrics.throughputBatches = batches.length
    metrics.submitToAppliedMs = quantiles(latencies)

    // L1 load inclusion
    await waitBlocks(2)
    const l1Status = await pool(l1Sends.filter(s => s.ok), 8, async s => ({ ...s, st: await txStatus(n3, s.hash) }))
    const included = l1Status.filter(s => s.st?.state === "included")
    let l1Last = 0
    for (const s of included) l1Last = Math.max(l1Last, (await timeOf(s.st.blockNumber)) ?? 0)
    const l1First = l1Sends.length ? Math.min(...l1Sends.map(s => s.at)) : 0
    metrics.l1Load = {
        targetTps: L1_TPS,
        submitted: l1Sends.length,
        accepted: l1Sends.filter(s => s.ok).length,
        included: included.length,
        mainTps: l1Last > l1First ? Number((included.length / ((l1Last - l1First) / 1000)).toFixed(3)) : 0,
        windowSeconds: l1Last > l1First ? Math.round((l1Last - l1First) / 1000) : 0,
        refusals: l1Sends.filter(s => !s.ok).slice(0, 5).map(s => s.message),
    }
    check("04.l1load", "L1 load ran beside settlement and was included", L1_TPS === 0 || included.length > 0, json(metrics.l1Load))

    await waitBlocks(1)
    const after = await quiescentStates()
    agree("04.agree", "after throughput with L1 load", after)
    const exp: Expected = new Map()
    for (const s of confirmed) expectTransfer(exp, s)
    // Settlement accounts are checked exactly; the L1 load's own conservation is judged apart.
    checkDeltas("04.deltas", before, after, exp, [], false)
    const supplyMoves = after.map((s, k) => s.totalSupply - before[k].totalSupply)
    l1SupplyDelta = supplyMoves[0]
    const l1Included = (metrics.l1Load as { included: number }).included
    check("04.l1-supply", `total supply unchanged by the ${l1Included} included L1 native transfers and the settlement batches`,
        supplyMoves.every(d => d === 0n),
        `supply moved ${supplyMoves.join("/")} OS (${l1Included > 0 ? `${supplyMoves[0] / BigInt(l1Included)} OS per L1 tx` : "no L1 tx"}); other movers in evidence/04.deltas-other-movers.json`)

    // block times inside the window
    const endHeight = after[0].height
    const gaps: number[] = []
    let prev: number | null = null
    for (let h = startHeight; h <= endHeight; h++) {
        const t = await timeOf(h)
        if (prev !== null && t !== null) gaps.push(t - prev)
        prev = t
    }
    metrics.throughputBlockTimeMs = quantiles(gaps)
    metrics.throughputHeights = [startHeight, endHeight]
})

await step("05-final", async () => {
    const top = Math.min(...(await tips()))
    const mismatches: number[] = []
    const gaps: number[] = []
    let prev: number | null = null
    for (let h = 1; h <= top; h++) {
        const blocks = await Promise.all(NODES.map(n => blockAt(n, h)))
        if (blocks.some(b => !b) || new Set(blocks.map(b => b.hash)).size !== 1) mismatches.push(h)
        const t = blockTimeMs(blocks[2])
        if (prev !== null && t !== null && h > firstHeight) gaps.push(t - prev)
        prev = t
    }
    check("05.hashes", `every block hash 1..${top} is identical on all 4 validators`, mismatches.length === 0,
        mismatches.length ? `differs at ${mismatches.slice(0, 20).join(",")}` : "")
    metrics.blockTimeMs = quantiles(gaps)
    metrics.heights = top
    const states = await quiescentStates()
    agree("05.agree", "final", states)
    check("05.supply", "total supply equals genesis supply on every validator, apart from what 04.l1-supply reports for the L1 load",
        states.every(s => s.totalSupply === genesisSupply + l1SupplyDelta),
        states.map(s => `${s.node}=${s.totalSupply}`).join(" ") + ` genesis ${genesisSupply}, L1 load ${l1SupplyDelta}`)

    // proof time per batch, from the members' own log line
    const proofs: { node: string; transfers: number; ms: number }[] = []
    for (const m of MEMBERS) {
        const logs = compose(["logs", "--no-color", "--no-log-prefix", m.name], 120_000).out
        for (const line of logs.split("\n")) {
            const hit = line.match(/Proved a (\d+)-transfer batch for (\S+) in (\d+) ms/)
            if (hit && hit[2] === UID) proofs.push({ node: m.name, transfers: Number(hit[1]), ms: Number(hit[3]) })
        }
    }
    evidence("05-proofs", proofs)
    metrics.proofMs = quantiles(proofs.map(p => p.ms))
    metrics.proofs = proofs.length
    metrics.proofTransfers = quantiles(proofs.map(p => p.transfers))
    const stats = docker(["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}} {{.CPUPerc}}", ...compose(["ps", "-q"]).out.split("\n").filter(Boolean)])
    metrics.containerStats = stats.out.split("\n")
})

// ---- report ---------------------------------------------------------------------

const failed = checks.filter(c => !c.pass)
const report = { uid: UID, chainId, batchSize: N, checks, metrics, verdict: failed.length === 0 ? "PASS" : "FAIL" }
writeFileSync(`${RUN_DIR}/report.json`, json(report) + "\n")
const lines = [
    `# L2PS settlement e2e: ${report.verdict}`,
    "",
    `Subnet ${UID}, chain ${chainId}, ${N} transfers per batch proof. Members node-1, node-2; node-3, node-4 not members.`,
    "",
    "## Checks",
    "",
    ...checks.map(c => `- ${c.pass ? "PASS" : "**FAIL**"} \`${c.id}\` ${c.title}${c.detail ? ` (${c.detail.replace(/\n/g, " ").slice(0, 400)})` : ""}`),
    "",
    "## Metrics",
    "",
    "```json",
    json(metrics),
    "```",
    "",
    `Evidence: ${EVIDENCE_DIR}`,
]
writeFileSync(`${RUN_DIR}/report.md`, lines.join("\n") + "\n")
say(`verdict ${report.verdict}: ${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

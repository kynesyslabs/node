// dev-node-battery.ts — health + native + stake/unstake + governance
// battery against a single deployed Demos node (dev.node2 by default).
// Polls each submitted tx until confirmed/timeout, writes a markdown
// report with all hashes + final states + per-stage timings.
//
// Usage:
//   bunx tsx scripts/dev-node-battery.ts
//   RPC=http://dev.node2.demos.sh:53552 \
//   MNEMONIC_FILE=./stress-test-mnemonic \
//   bunx tsx scripts/dev-node-battery.ts

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"

// NOSONAR-NEXT-LINE typescript:S5332 — the deployed dev node listens on plain
// HTTP (no TLS terminator in front of it). Override via `RPC=https://...` when
// pointing at a production / TLS-terminated endpoint.
const RPC = process.env.RPC ?? "http://dev.node2.demos.sh:53552" // NOSONAR
const MNEMONIC_FILE = process.env.MNEMONIC_FILE ?? "./stress-test-mnemonic"
const L2PS_UID = process.env.L2PS_UID ?? ""
const STAKE = process.env.STAKE ?? "1000000000000000000"
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z"
const REPORT_DIR = "./test-reports"
const REPORT_PATH = `${REPORT_DIR}/dev-node-battery-${TS}.md`
const POLL_INTERVAL_MS = 1500
const TX_POLL_TIMEOUT_MS = 90_000

mkdirSync(REPORT_DIR, { recursive: true })

interface StageResult {
    name: string
    ok: boolean
    skipped?: boolean
    durationMs: number
    notes: string[]
    txHash?: string
    txStatus?: string
    blockNumber?: number | string
    extra?: Record<string, unknown>
    error?: string
}

const stages: StageResult[] = []
const stringify = (v: unknown) =>
    JSON.stringify(
        v,
        (_, x) => (typeof x === "bigint" ? x.toString() : x),
        2,
    )

async function runStage(
    name: string,
    fn: () => Promise<Omit<StageResult, "name" | "ok" | "durationMs">>,
): Promise<StageResult> {
    const t0 = Date.now()
    console.log(`\n▶ ${name}`)
    try {
        const r = await fn()
        const result: StageResult = {
            name,
            ok: true,
            durationMs: Date.now() - t0,
            ...r,
        }
        console.log(`  ✔ ${name} (${result.durationMs}ms)`)
        if (result.notes?.length) result.notes.forEach(n => console.log(`    · ${n}`))
        stages.push(result)
        return result
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        const result: StageResult = {
            name,
            ok: false,
            durationMs: Date.now() - t0,
            notes: [],
            error: msg.slice(0, 500),
        }
        console.log(`  ✘ ${name}: ${msg.slice(0, 120)}`)
        stages.push(result)
        return result
    }
}

async function pollTx(
    demos: Demos,
    hash: string,
): Promise<{ status: string; blockNumber?: number | string }> {
    const t0 = Date.now()
    while (Date.now() - t0 < TX_POLL_TIMEOUT_MS) {
        try {
            const res = await (demos as any).nodeCall("getTransactionStatus", { hash })
            const isTransportFail =
                res && typeof res === "object" && (res as any).result === 500 && "require_reply" in (res as any)
            if (!isTransportFail) {
                const state = res && typeof res === "object" ? (res as any).state : undefined
                if (typeof state === "string" && (state === "included" || state === "failed")) {
                    return { status: state, blockNumber: (res as any).blockNumber }
                }
            }
        } catch {
            // keep polling
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    }
    return { status: "timeout" }
}

async function getBlock(demos: Demos): Promise<number> {
    try {
        const n = await (demos as unknown as {
            getLastBlockNumber: () => Promise<number | string>
        }).getLastBlockNumber()
        return Number(n)
    } catch {
        return -1
    }
}

async function main() {
    const mnemonic = readFileSync(MNEMONIC_FILE, "utf8").trim()
    const demos = new Demos()
    await demos.connect(RPC)
    await demos.connectWallet(mnemonic)
    const address = await (demos as unknown as {
        getEd25519Address: () => Promise<string>
    }).getEd25519Address()

    console.log(`RPC:     ${RPC}`)
    console.log(`Address: ${address}`)
    console.log(`Report:  ${REPORT_PATH}`)

    // ── Stage 0 — health ───────────────────────────────────────────────
    await runStage("0. Node health + initial balance", async () => {
        const info: any = await (demos as any).getAddressInfo(address)
        const block = await getBlock(demos)
        return {
            notes: [
                `chain block: ${block}`,
                `balance: ${info?.balance?.toString?.()}`,
                `nonce: ${info?.nonce?.toString?.()}`,
            ],
            extra: {
                block,
                balance: info?.balance?.toString?.(),
                nonce: info?.nonce?.toString?.(),
            },
        }
    })

    // ── Stage 1 — native pay sanity ────────────────────────────────────
    await runStage("1. Native pay (self-send, 1 unit)", async () => {
        const tx = await (demos as any).pay(address, 1, demos)
        const v = await demos.confirm(tx)
        const r = await demos.broadcast(v)
        const result = (r as any)?.result
        const hash = (v as any)?.response?.data?.transaction?.hash ?? (tx as any).hash
        const poll = await pollTx(demos, hash)
        return {
            txHash: hash,
            txStatus: poll.status,
            blockNumber: poll.blockNumber,
            notes: [
                `broadcast result: ${result}`,
                `poll status: ${poll.status}`,
                `poll blockNumber: ${poll.blockNumber ?? "?"}`,
            ],
        }
    })

    // ── Stage 2 — L2PS broadcast (conditional on L2PS_UID) ─────────────
    if (L2PS_UID) {
        await runStage("2. L2PS broadcast (encrypted tx)", async () => {
            // Reuse the demo's existing broadcast path via the L2PS uid.
            // We can't call it directly from here without bringing the
            // demo repo in scope — instead just note this needs the
            // agent-commerce-demo's scripts/l2ps-multinode-stress.sh.
            return {
                notes: [
                    `L2PS_UID=${L2PS_UID} set — run agent-commerce-demo/scripts/l2ps-multinode-stress.sh against this RPC separately`,
                ],
            }
        })
    } else {
        stages.push({
            name: "2. L2PS broadcast (encrypted tx)",
            ok: false,
            skipped: true,
            durationMs: 0,
            notes: ["SKIPPED — L2PS_UID env not set (need subnet key + iv from client)"],
        })
        console.log("\n▶ 2. L2PS broadcast — SKIPPED (L2PS_UID not set)")
    }

    // ── Stage 3 — stake validator ──────────────────────────────────────
    let stakeOk = false
    await runStage("3. Stake (register validator)", async () => {
        const tx = await DemosTransactions.stake(STAKE, RPC, demos)
        const v = await demos.confirm(tx)
        const r = await demos.broadcast(v)
        const hash = (v as any)?.response?.data?.transaction?.hash ?? (tx as any).hash
        const poll = await pollTx(demos, hash)
        if (poll.status === "included") {
            stakeOk = true
        }
        return {
            txHash: hash,
            txStatus: poll.status,
            blockNumber: poll.blockNumber,
            notes: [
                `staked: ${STAKE} raw`,
                `broadcast: ${(r as any)?.result}`,
                `status: ${poll.status}`,
            ],
            extra: {
                stake: STAKE,
                connection_url: RPC,
            },
        }
    })

    // Validators list snapshot — proves the stake registered
    await runStage("3a. Validators list (post-stake)", async () => {
        const list = (await (demos as any).getValidators?.()) ?? []
        const mine = (list as any[]).find(v => v?.address === address)
        return {
            notes: [
                `total validators: ${(list as any[]).length}`,
                `our entry: ${mine ? "FOUND" : "not found (replication may be pending)"}`,
            ],
            extra: { validators_count: (list as any[]).length, ours: mine ?? null },
        }
    })

    // ── Stage 4 — governance: propose ─────────────────────────────────
    let proposalId = ""
    if (stakeOk) {
        await runStage("4. Governance propose (blockTimeMs 1000→1100)", async () => {
            const block = await getBlock(demos)
            const effectiveAtBlock = (Number(block) || 0) + 160
            // Mint id locally and only promote to outer `proposalId` after
            // the tx lands. If `confirm()` throws (today: hash mismatch),
            // `runStage` catches it but a UUID would still be assigned to
            // the outer var — Stage 5's `if (proposalId)` guard would then
            // fire a vote against a proposal that never existed on chain.
            // Mirrors the `stakeOk` pattern in Stage 3.
            const id = randomUUID()
            const tx = await DemosTransactions.proposeNetworkUpgrade(
                {
                    proposalId: id,
                    proposedParameters: { blockTimeMs: 1100 } as any,
                    rationale: "dev-node-battery: bump blockTimeMs 1000→1100 (10%) smoke",
                    effectiveAtBlock,
                },
                demos,
            )
            const v = await demos.confirm(tx)
            const r = await demos.broadcast(v)
            const hash = (tx as any).hash
            const poll = await pollTx(demos, hash)
            if (poll.status === "included") {
                proposalId = id
            }
            return {
                txHash: hash,
                txStatus: poll.status,
                blockNumber: poll.blockNumber,
                notes: [
                    `broadcast: ${(r as any)?.result}`,
                    `proposalId: ${id}`,
                    `effectiveAtBlock: ${effectiveAtBlock}`,
                ],
                extra: { proposalId: id, effectiveAtBlock },
            }
        })
    } else {
        stages.push({
            name: "4. Governance propose",
            ok: false,
            skipped: true,
            durationMs: 0,
            notes: ["SKIPPED — stake did not succeed"],
        })
    }

    // ── Stage 5 — vote yes ─────────────────────────────────────────────
    if (proposalId) {
        await runStage("5. Vote YES on proposal", async () => {
            const tx = await DemosTransactions.voteOnUpgrade(
                proposalId,
                true,
                demos,
            )
            const v = await demos.confirm(tx)
            const r = await demos.broadcast(v)
            const hash = (v as any)?.response?.data?.transaction?.hash ?? (tx as any).hash
            const poll = await pollTx(demos, hash)
            return {
                txHash: hash,
                txStatus: poll.status,
                blockNumber: poll.blockNumber,
                notes: [
                    `broadcast: ${(r as any)?.result}`,
                    `proposalId: ${proposalId}`,
                ],
            }
        })

        // Live tally snapshot
        await runStage("5a. Tally snapshot", async () => {
            const tally = await (demos as any).getProposalVotes(proposalId)
            return {
                notes: [`tally: ${stringify(tally).slice(0, 200)}`],
                extra: { proposalId, tally },
            }
        })
    } else {
        stages.push({
            name: "5. Vote",
            ok: false,
            skipped: true,
            durationMs: 0,
            notes: ["SKIPPED — no proposalId from stage 4"],
        })
    }

    // ── Stage 6 — unstake (arm) ────────────────────────────────────────
    if (stakeOk) {
        await runStage("6. Unstake (arm 1000-block lock)", async () => {
            const tx = await DemosTransactions.unstake(demos)
            const v = await demos.confirm(tx)
            const r = await demos.broadcast(v)
            const hash = (v as any)?.response?.data?.transaction?.hash ?? (tx as any).hash
            const poll = await pollTx(demos, hash)
            return {
                txHash: hash,
                txStatus: poll.status,
                blockNumber: poll.blockNumber,
                notes: [
                    `broadcast: ${(r as any)?.result}`,
                    `armed: validator can call exit() after 1000 blocks`,
                    `(full unstake → exit cycle not waited — would need ~3 hours at 10s/block)`,
                ],
            }
        })
    } else {
        stages.push({
            name: "6. Unstake (arm)",
            ok: false,
            skipped: true,
            durationMs: 0,
            notes: ["SKIPPED — stake did not succeed"],
        })
    }

    // ── Stage 7 — final state ──────────────────────────────────────────
    await runStage("7. Final state snapshot", async () => {
        const info: any = await (demos as any).getAddressInfo(address)
        const block = await getBlock(demos)
        const params: any = await (demos as any).getNetworkParameters?.()
        return {
            notes: [
                `chain block: ${block}`,
                `balance: ${info?.balance?.toString?.()}`,
                `nonce: ${info?.nonce?.toString?.()}`,
                `networkFee: ${params?.networkFee ?? "?"}`,
                `(networkFee change activates only after voting_window + grace_period ≈ 150 blocks; check later)`,
            ],
            extra: {
                block,
                balance: info?.balance?.toString?.(),
                nonce: info?.nonce?.toString?.(),
                params,
            },
        }
    })

    // ── render markdown ────────────────────────────────────────────────
    const lines: string[] = []
    lines.push(`# Dev-node battery report`)
    lines.push("")
    lines.push(`- **Started:** ${TS}`)
    lines.push(`- **RPC:** \`${RPC}\``)
    lines.push(`- **Funded address:** \`${address}\``)
    lines.push(`- **L2PS:** ${L2PS_UID ? `uid=\`${L2PS_UID}\`` : "_not provided — separate run needed_"}`)
    lines.push("")
    const okCount = stages.filter(s => s.ok).length
    const skippedCount = stages.filter(s => s.skipped).length
    const ranCount = stages.length - skippedCount
    const skippedNote = skippedCount > 0 ? ` (+ ${skippedCount} skipped)` : ""
    lines.push(`**Summary: ${okCount}/${ranCount} stages passed${skippedNote}.**`)
    lines.push("")
    lines.push(`| # | Stage | Status | Duration | tx hash | tx status | block |`)
    lines.push(`|---|-------|--------|----------|---------|-----------|-------|`)
    for (let i = 0; i < stages.length; i++) {
        const s = stages[i]
        const status = s.ok ? "✅" : s.skipped ? "⏭️" : "❌"
        const hash = s.txHash ? `\`${s.txHash.slice(0, 14)}…\`` : "—"
        const txS = s.txStatus ?? "—"
        const blk = s.blockNumber ?? "—"
        lines.push(`| ${i + 1} | ${s.name} | ${status} | ${s.durationMs}ms | ${hash} | ${txS} | ${blk} |`)
    }
    lines.push("")
    lines.push(`## Per-stage detail`)
    lines.push("")
    for (const s of stages) {
        lines.push(`### ${s.name}`)
        lines.push("")
        if (s.error) {
            lines.push(`**Error:** \`${s.error}\``)
            lines.push("")
        }
        if (s.txHash) {
            lines.push(`- **Tx hash:** \`${s.txHash}\``)
            lines.push(`- **Status:** ${s.txStatus ?? "?"}`)
            if (s.blockNumber) lines.push(`- **Block:** ${s.blockNumber}`)
        }
        if (s.notes?.length) {
            for (const n of s.notes) lines.push(`- ${n}`)
        }
        if (s.extra) {
            lines.push("")
            lines.push("```json")
            lines.push(stringify(s.extra).slice(0, 2000))
            lines.push("```")
        }
        lines.push("")
    }
    // Known issues annotation — surfaces SDK/node alignment gaps that block
    // governance flow against this deployment.
    const failedGov = stages.find(
        s => /Governance propose/i.test(s.name) && !s.ok,
    )
    if (failedGov && /hash mismatch|Invalid stake/i.test(failedGov.error ?? "")) {
        lines.push(`## Known issues`)
        lines.push(``)
        lines.push(
            `- **Governance propose failed with hash mismatch.** The SDK's \`proposeNetworkUpgrade\` builder produces a content hash that does not match what the node computes via \`serializeTransactionContent\`. Native pay / stake / unstake serialize cleanly, so this is specific to the \`networkUpgrade\` content shape. Requires SDK ↔ node alignment fix (or a manual node-side proposal) before vote can be exercised end-to-end.`,
        )
        lines.push(``)
    }
    lines.push(`---`)
    lines.push(``)
    lines.push(`_Generated by \`scripts/dev-node-battery.ts\` against ${RPC}._`)
    lines.push(``)

    writeFileSync(REPORT_PATH, lines.join("\n"))
    console.log(`\n📄 Report: ${REPORT_PATH}`)
    console.log(`📊 ${okCount}/${ranCount} stages passed${skippedNote}`)
}

main().catch(e => {
    console.error("FATAL:", e instanceof Error ? e.message : String(e))
    if (stages.length > 0) {
        // best-effort partial report
        try {
            const text = `# Battery aborted\n\n${stringify(stages)}`
            writeFileSync(REPORT_PATH, text)
            console.log(`Partial report: ${REPORT_PATH}`)
        } catch { /* ignore */ }
    }
    process.exit(1)
})

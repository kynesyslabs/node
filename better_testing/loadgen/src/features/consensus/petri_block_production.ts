/**
 * Petri Consensus — Devnet Scenario: Block Production
 *
 * Verifies that blocks are produced when PETRI_CONSENSUS=true.
 * Same approach as consensus_block_production but also checks
 * that the node reports Petri-specific behavior.
 *
 * Prerequisites:
 *   - Devnet running with PETRI_CONSENSUS=true
 *   - At least 1 RPC target
 */
import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import { maybeSilenceConsole } from "../../token_shared"
import { getConsensusTargets, waitForBlockAdvance, waitForConsensusTargets } from "./shared"

async function checkPetriEnabled(rpcUrl: string): Promise<boolean> {
    // Try to call getTransactionFinality — it only exists when Petri code is loaded
    // A 400 (missing hash) means the RPC exists, a 404/error means it doesn't
    try {
        const res = await nodeCall(rpcUrl, "getTransactionFinality", { params: ["test_probe"] }, "petri:probe", NO_FALLBACKS)
        // Any response (even error) means the endpoint exists
        return res !== null && res !== undefined
    } catch {
        return false
    }
}

export async function runPetriBlockProduction() {
    maybeSilenceConsole()

    const rpcUrls = getConsensusTargets()
    if (rpcUrls.length === 0) throw new Error("petri_block_production requires at least one RPC target")

    await waitForConsensusTargets(rpcUrls, false)

    // Step 1: Verify Petri is enabled on at least one node
    const petriChecks = await Promise.all(rpcUrls.map(url => checkPetriEnabled(url)))
    const petriEnabledCount = petriChecks.filter(Boolean).length
    console.log(`[petri_block_production] Petri RPC available on ${petriEnabledCount}/${rpcUrls.length} nodes`)

    // Step 2: Wait for block production (same as consensus_block_production)
    const requiredDelta = Math.max(1, envInt("CONSENSUS_REQUIRED_BLOCK_DELTA", 2))
    const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 60)
    const pollMs = envInt("CONSENSUS_POLL_MS", 500)

    const advance = await waitForBlockAdvance({
        rpcUrls,
        requiredDelta,
        timeoutSec,
        pollMs,
    })

    const ok = advance.ok && petriEnabledCount > 0
    const run = getRunConfig()
    const summary = {
        scenario: "petri_block_production",
        ok,
        rpcUrls,
        petriEnabledCount,
        petriChecks,
        requiredDelta,
        timeoutSec,
        pollMs,
        start: advance.start,
        end: advance.end,
        timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/consensus/petri_block_production.summary.json`, summary)
    console.log(JSON.stringify({ petri_block_production_summary: summary }, null, 2))

    if (!ok) {
        const reasons: string[] = []
        if (petriEnabledCount === 0) reasons.push("Petri RPC not available on any node (is PETRI_CONSENSUS=true?)")
        if (!advance.ok) reasons.push("block height did not advance on all targets")
        throw new Error(`petri_block_production failed: ${reasons.join("; ")}`)
    }
}

if (import.meta.main) {
    await runPetriBlockProduction()
}

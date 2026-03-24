import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole } from "../../token_shared"
import { getClusterObservation, getPeerSyncTargets, waitForClusterConvergence, waitForPeerSyncTargets } from "./shared"

export async function runSyncCatchupSmoke() {
  maybeSilenceConsole()

  const rpcUrls = getPeerSyncTargets()
  if (rpcUrls.length === 0) throw new Error("sync_catchup_smoke requires at least one RPC target")
  await waitForPeerSyncTargets(rpcUrls, false)

  const initial = await getClusterObservation(rpcUrls)
  const run = getRunConfig()
  if (initial.healthyNodeCount < 2) {
    const summary = {
      scenario: "sync_catchup_smoke",
      ok: true,
      skipped: true,
      skipReason: "need at least 2 healthy RPC targets to observe catchup behavior",
      rpcUrls,
      initial,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/peersync/sync_catchup_smoke.summary.json`, summary)
    console.log(JSON.stringify({ sync_catchup_smoke_summary: summary }, null, 2))
    return
  }

  const lagObserved =
    initial.distinctBlockNumbers.length > 1 ||
    initial.distinctBlockHashes.length > 1

  const report = await waitForClusterConvergence({
    rpcUrls: initial.healthyRpcUrls,
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 90),
    pollMs: envInt("CONSENSUS_POLL_MS", 1000),
    stableRoundsRequired: Math.max(2, envInt("SYNC_STABLE_ROUNDS", 3)),
    minBlockAdvance: Math.max(1, envInt("SYNC_REQUIRED_BLOCK_DELTA", 1)),
    requirePeerDiscovery: true,
  })

  const finalObservation = report.observations[report.observations.length - 1]!
  const recoveryObserved = lagObserved && report.ok
  const ok = report.ok
  const summary = {
    scenario: "sync_catchup_smoke",
    ok,
    skipped: false,
    inconclusive: !lagObserved,
    note: lagObserved
      ? "Observed lag or divergence and verified convergence within the timeout."
      : "No lag was present at scenario start; this run validates converged catchup readiness without inducing lag.",
    rpcUrls,
    initial,
    lagObserved,
    recoveryObserved,
    report,
    finalObservation,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/peersync/sync_catchup_smoke.summary.json`, summary)
  console.log(JSON.stringify({ sync_catchup_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("sync_catchup_smoke failed: healthy nodes did not converge within the timeout window")
  }
}

if (import.meta.main) {
  await runSyncCatchupSmoke()
}

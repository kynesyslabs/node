import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole } from "../../token_shared"
import { getPeerSyncTargets, waitForClusterConvergence, waitForPeerSyncTargets } from "./shared"

export async function runSyncConsistency() {
  maybeSilenceConsole()

  const rpcUrls = getPeerSyncTargets()
  if (rpcUrls.length === 0) throw new Error("sync_consistency requires at least one RPC target")
  await waitForPeerSyncTargets(rpcUrls, false)

  const report = await waitForClusterConvergence({
    rpcUrls,
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 90),
    pollMs: envInt("CONSENSUS_POLL_MS", 1000),
    stableRoundsRequired: Math.max(2, envInt("SYNC_STABLE_ROUNDS", 3)),
    minBlockAdvance: Math.max(1, envInt("SYNC_REQUIRED_BLOCK_DELTA", 1)),
    requirePeerDiscovery: true,
  })

  const finalObservation = report.observations[report.observations.length - 1]!
  const run = getRunConfig()
  const summary = {
    scenario: "sync_consistency",
    ok: report.ok,
    skipped: false,
    rpcUrls,
    report,
    finalObservation,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/peersync/sync_consistency.summary.json`, summary)
  console.log(JSON.stringify({ sync_consistency_summary: summary }, null, 2))

  if (!report.ok) {
    throw new Error("sync_consistency failed: healthy nodes did not reach stable converged state")
  }
}

if (import.meta.main) {
  await runSyncConsistency()
}

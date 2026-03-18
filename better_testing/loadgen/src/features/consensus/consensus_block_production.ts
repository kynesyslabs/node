import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole } from "../../token_shared"
import { getConsensusTargets, waitForBlockAdvance, waitForConsensusTargets } from "./shared"

export async function runConsensusBlockProduction() {
  maybeSilenceConsole()

  const rpcUrls = getConsensusTargets()
  if (rpcUrls.length === 0) throw new Error("consensus_block_production requires at least one RPC target")

  await waitForConsensusTargets(rpcUrls, false)

  const requiredDelta = Math.max(1, envInt("CONSENSUS_REQUIRED_BLOCK_DELTA", 1))
  const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 60)
  const pollMs = envInt("CONSENSUS_POLL_MS", 500)

  const advance = await waitForBlockAdvance({
    rpcUrls,
    requiredDelta,
    timeoutSec,
    pollMs,
  })

  const ok = advance.ok
  const run = getRunConfig()
  const summary = {
    scenario: "consensus_block_production",
    ok,
    rpcUrls,
    requiredDelta,
    timeoutSec,
    pollMs,
    start: advance.start,
    end: advance.end,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/consensus/consensus_block_production.summary.json`, summary)
  console.log(JSON.stringify({ consensus_block_production_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("consensus_block_production failed: block height did not advance on all targets")
  }
}

if (import.meta.main) {
  await runConsensusBlockProduction()
}


import { getRunConfig, writeJson } from "../../framework/io"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"
import { getSharedState } from "../../../../../src/utilities/sharedState"

export async function runL2psBatchNonceProgressionSmoke() {
  const aggregator = L2PSBatchAggregator.getInstance() as any
  const previousNonce = getSharedState.l2psBatchNonce
  const previousNow = Date.now

  try {
    getSharedState.l2psBatchNonce = 12345000
    Date.now = () => 12345

    const firstNonce = await aggregator.getNextBatchNonce()
    getSharedState.l2psBatchNonce = 12345009
    const secondNonce = await aggregator.getNextBatchNonce()

    const checks = {
      timestampDerivedNonceUsedWhenGreater: firstNonce === 12345001,
      persistedNonceWrittenBack: getSharedState.l2psBatchNonce === secondNonce,
      monotonicNonceGuaranteedAcrossCalls: secondNonce === 12345010,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_batch_nonce_progression_smoke",
      ok,
      checks,
      firstNonce,
      secondNonce,
      persistedNonce: getSharedState.l2psBatchNonce,
      timestampMs: Date.now(),
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_batch_nonce_progression_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_batch_nonce_progression_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_batch_nonce_progression_smoke failed: batch nonce progression drifted")
    }
  } finally {
    getSharedState.l2psBatchNonce = previousNonce
    Date.now = previousNow
  }
}

if (import.meta.main) {
  await runL2psBatchNonceProgressionSmoke()
}

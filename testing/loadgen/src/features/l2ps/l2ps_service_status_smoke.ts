import { getRunConfig, writeJson } from "../../framework/io"
import SharedState, { getSharedState } from "../../../../../src/utilities/sharedState"
import { L2PSHashService } from "../../../../../src/libs/l2ps/L2PSHashService"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"

export async function runL2psServiceStatusSmoke() {
  const sharedState = SharedState.getInstance()
  const previousJoined = [...sharedState.l2psJoinedUids]
  sharedState.l2psJoinedUids = ["uid-a", "uid-b", "uid-c"]

  const hashService = L2PSHashService.getInstance() as any
  const batchAggregator = L2PSBatchAggregator.getInstance() as any

  const previousHashFlags = {
    isRunning: hashService.isRunning,
    isGenerating: hashService.isGenerating,
  }
  const previousBatchFlags = {
    isRunning: batchAggregator.isRunning,
    isAggregating: batchAggregator.isAggregating,
  }

  hashService.isRunning = true
  hashService.isGenerating = false
  batchAggregator.isRunning = false
  batchAggregator.isAggregating = true

  try {
    const hashStatus = hashService.getStatus()
    const batchStatus = batchAggregator.getStatus()

    const checks = {
      hashStatusShape: hashStatus.isRunning === true
        && hashStatus.isGenerating === false
        && typeof hashStatus.intervalMs === "number"
        && hashStatus.joinedL2PSCount === 3,
      batchStatusShape: batchStatus.isRunning === false
        && batchStatus.isAggregating === true
        && typeof batchStatus.intervalMs === "number"
        && batchStatus.joinedL2PSCount === 3,
      sharedGetterConsistent: getSharedState.l2psJoinedUids.length === 3,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_service_status_smoke",
      ok,
      checks,
      hashStatus,
      batchStatus,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_service_status_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_service_status_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_service_status_smoke failed: service status envelopes did not match expectations")
    }
  } finally {
    sharedState.l2psJoinedUids = previousJoined
    hashService.isRunning = previousHashFlags.isRunning
    hashService.isGenerating = previousHashFlags.isGenerating
    batchAggregator.isRunning = previousBatchFlags.isRunning
    batchAggregator.isAggregating = previousBatchFlags.isAggregating
  }
}

if (import.meta.main) {
  await runL2psServiceStatusSmoke()
}

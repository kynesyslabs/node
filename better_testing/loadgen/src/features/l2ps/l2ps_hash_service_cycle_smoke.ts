import { getRunConfig, writeJson } from "../../framework/io"
import { L2PSHashService } from "../../../../../src/libs/l2ps/L2PSHashService"

export async function runL2psHashServiceCycleSmoke() {
  const service = L2PSHashService.getInstance() as any
  const previousStats = service.stats
  const previousIsRunning = service.isRunning
  const previousIsGenerating = service.isGenerating
  const previousGenerateAndRelayHashes = service.generateAndRelayHashes
  const previousUpdateCycleTime = service.updateCycleTime

  const cycleDurations: number[] = []
  let generateCalls = 0

  try {
    service.stats = {
      totalCycles: 0,
      successfulCycles: 0,
      failedCycles: 0,
      skippedCycles: 0,
      totalHashesGenerated: 0,
      successfulRelays: 0,
      failedRelays: 0,
      averageCycleTime: 0,
      lastCycleTime: 0,
    }

    service.isRunning = true
    service.isGenerating = false
    service.generateAndRelayHashes = async () => {
      generateCalls += 1
    }
    service.updateCycleTime = (duration: number) => {
      cycleDurations.push(duration)
      service.stats.lastCycleTime = duration
    }

    await service.safeGenerateAndRelayHashes()
    service.isGenerating = true
    await service.safeGenerateAndRelayHashes()
    service.isGenerating = false
    service.generateAndRelayHashes = async () => {
      generateCalls += 1
      throw new Error("cycle failure")
    }
    await service.safeGenerateAndRelayHashes()

    service.isRunning = false
    service.generateAndRelayHashes = async () => {
      generateCalls += 1
    }
    await service.safeGenerateAndRelayHashes()

    const checks = {
      successfulCycleRanOnce: generateCalls === 2,
      totalCyclesTrackedOnlyWhileRunningAndNotSkipped: service.stats.totalCycles === 2,
      successfulCycleCounted: service.stats.successfulCycles === 1,
      skippedCycleCounted: service.stats.skippedCycles === 1,
      failedCycleCounted: service.stats.failedCycles === 1,
      cycleTimeRecordedForSuccessfulCycleOnly: cycleDurations.length === 1 && cycleDurations[0] >= 0,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_hash_service_cycle_smoke",
      ok,
      checks,
      stats: service.stats,
      generateCalls,
      cycleDurations,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_hash_service_cycle_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_hash_service_cycle_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_hash_service_cycle_smoke failed: cycle accounting or reentrancy behavior drifted")
    }
  } finally {
    service.stats = previousStats
    service.isRunning = previousIsRunning
    service.isGenerating = previousIsGenerating
    service.generateAndRelayHashes = previousGenerateAndRelayHashes
    service.updateCycleTime = previousUpdateCycleTime
  }
}

if (import.meta.main) {
  await runL2psHashServiceCycleSmoke()
}

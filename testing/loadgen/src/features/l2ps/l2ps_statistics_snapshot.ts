import { getRunConfig, writeJson } from "../../framework/io"
import { L2PSHashService } from "../../../../../src/libs/l2ps/L2PSHashService"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"

export async function runL2psStatisticsSnapshot() {
  const hashService = L2PSHashService.getInstance() as any
  const batchAggregator = L2PSBatchAggregator.getInstance() as any

  const previousHashStats = { ...hashService.stats }
  const previousBatchStats = { ...batchAggregator.stats }

  hashService.stats = {
    totalCycles: 11,
    successfulCycles: 7,
    failedCycles: 2,
    skippedCycles: 2,
    totalHashesGenerated: 5,
    successfulRelays: 4,
    lastCycleTime: 120,
    averageCycleTime: 90,
  }
  batchAggregator.stats = {
    totalCycles: 9,
    successfulCycles: 6,
    failedCycles: 1,
    skippedCycles: 2,
    totalBatchesCreated: 3,
    totalTransactionsBatched: 14,
    successfulSubmissions: 2,
    failedSubmissions: 1,
    cleanedUpTransactions: 8,
    lastCycleTime: 210,
    averageCycleTime: 180,
  }

  try {
    const hashStats = hashService.getStatistics()
    const batchStats = batchAggregator.getStatistics()

    hashStats.totalCycles = 999
    batchStats.totalCycles = 999

    const hashStatsAgain = hashService.getStatistics()
    const batchStatsAgain = batchAggregator.getStatistics()

    const checks = {
      hashStatsCopied: hashStatsAgain.totalCycles === 11 && hashStatsAgain.successfulRelays === 4,
      batchStatsCopied: batchStatsAgain.totalCycles === 9 && batchStatsAgain.totalTransactionsBatched === 14,
      hashShapeStable: typeof hashStatsAgain.averageCycleTime === "number" && typeof hashStatsAgain.totalHashesGenerated === "number",
      batchShapeStable: typeof batchStatsAgain.averageCycleTime === "number" && typeof batchStatsAgain.cleanedUpTransactions === "number",
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_statistics_snapshot",
      ok,
      checks,
      hashStats: hashStatsAgain,
      batchStats: batchStatsAgain,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_statistics_snapshot.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_statistics_snapshot_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_statistics_snapshot failed: statistics snapshot behavior did not match expectations")
    }
  } finally {
    hashService.stats = previousHashStats
    batchAggregator.stats = previousBatchStats
  }
}

if (import.meta.main) {
  await runL2psStatisticsSnapshot()
}

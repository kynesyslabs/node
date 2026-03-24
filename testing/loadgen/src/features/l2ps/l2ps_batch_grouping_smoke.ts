import { getRunConfig, writeJson } from "../../framework/io"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"

export async function runL2psBatchGroupingSmoke() {
  const aggregator = L2PSBatchAggregator.getInstance() as any

  const transactions = [
    {
      l2ps_uid: "uid-a",
      hash: "tx-1",
      gcr_edits: [{ op: "add", key: "a" }],
      affected_accounts_count: 2,
    },
    {
      l2ps_uid: "uid-b",
      hash: "tx-2",
      gcr_edits: [{ op: "remove", key: "b" }],
      affected_accounts_count: 1,
    },
    {
      l2ps_uid: "uid-a",
      hash: "tx-3",
      gcr_edits: [{ op: "add", key: "c" }],
      affected_accounts_count: 3,
    },
    {
      l2ps_uid: "uid-b",
      hash: "tx-4",
      gcr_edits: null,
      affected_accounts_count: 0,
    },
  ] as any[]

  const grouped = aggregator.groupTransactionsByUID(transactions)
  const aggregated = aggregator.aggregateGCREdits(transactions)
  const initialStats = aggregator.createInitialStats()

  const checks = {
    groupedByUid: JSON.stringify(Object.keys(grouped).sort()) === JSON.stringify(["uid-a", "uid-b"]),
    groupingPreservesMembership:
      JSON.stringify(grouped["uid-a"].map((tx: any) => tx.hash)) === JSON.stringify(["tx-1", "tx-3"]) &&
      JSON.stringify(grouped["uid-b"].map((tx: any) => tx.hash)) === JSON.stringify(["tx-2", "tx-4"]),
    gcrEditsFlattened: aggregated.aggregatedEdits.length === 3,
    affectedAccountCountsSummed: aggregated.totalAffectedAccountsCount === 6,
    initialStatsZeroed: Object.values(initialStats).every((value) => value === 0),
  }

  const ok = Object.values(checks).every(Boolean)
  const run = getRunConfig()
  const summary = {
    scenario: "l2ps_batch_grouping_smoke",
    ok,
    checks,
    groupedKeys: Object.keys(grouped),
    aggregated,
    initialStats,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/l2ps/l2ps_batch_grouping_smoke.summary.json`, summary)
  console.log(JSON.stringify({ l2ps_batch_grouping_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("l2ps_batch_grouping_smoke failed: grouping or aggregation helpers drifted")
  }
}

if (import.meta.main) {
  await runL2psBatchGroupingSmoke()
}

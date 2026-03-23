import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool, { L2PS_STATUS } from "../../../../../src/libs/blockchain/l2ps_mempool"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"
import L2PSProofManager from "../../../../../src/libs/l2ps/L2PSProofManager"
import L2PSTransactionExecutor from "../../../../../src/libs/l2ps/L2PSTransactionExecutor"

export async function runL2psProcessBatchForUidSmoke() {
  const aggregator = L2PSBatchAggregator.getInstance() as any
  const previousMinBatchSize = aggregator.MIN_BATCH_SIZE
  const previousStats = aggregator.stats
  const previousCreateBatchPayload = aggregator.createBatchPayload
  const previousAggregateGCREdits = aggregator.aggregateGCREdits
  const previousSubmitBatchToMempool = aggregator.submitBatchToMempool
  const previousCreateProof = L2PSProofManager.createProof
  const previousUpdateStatusBatch = L2PSMempool.updateStatusBatch
  const previousUpdateTransactionStatus = L2PSTransactionExecutor.updateTransactionStatus

  const proofCalls: any[] = []
  const mempoolUpdates: any[] = []
  const historyUpdates: any[] = []
  const createdPayloads: any[] = []

  try {
    aggregator.MIN_BATCH_SIZE = 2
    aggregator.stats = aggregator.createInitialStats()
    aggregator.createBatchPayload = async (uid: string, txs: any[]) => {
      createdPayloads.push({ uid, hashes: txs.map((tx) => tx.hash) })
      return {
        l2ps_uid: uid,
        encrypted_batch: "payload",
        transaction_count: txs.length,
        batch_hash: "batch-uid-a",
        transaction_hashes: txs.map((tx) => tx.hash),
        authentication_tag: "1".repeat(64),
      }
    }
    aggregator.aggregateGCREdits = () => ({
      aggregatedEdits: [{ op: "add", key: "g1" }, { op: "remove", key: "g2" }],
      totalAffectedAccountsCount: 5,
    })
    aggregator.submitBatchToMempool = async () => true

    ;(L2PSProofManager as any).createProof = async (...args: any[]) => {
      proofCalls.push(args)
      return { success: true, proof_id: "proof-1" }
    }
    ;(L2PSMempool as any).updateStatusBatch = async (hashes: string[], status: string) => {
      mempoolUpdates.push({ hashes, status })
      return hashes.length
    }
    ;(L2PSTransactionExecutor as any).updateTransactionStatus = async (...args: any[]) => {
      historyUpdates.push(args)
    }

    await aggregator.processBatchForUID("uid-a", [{ hash: "tx-alone" }])
    await aggregator.processBatchForUID("uid-a", [{ hash: "tx-1" }, { hash: "tx-2" }])

    const checks = {
      belowThresholdBatchSkipped: createdPayloads.length === 1,
      payloadCreatedForEligibleBatchOnly:
        JSON.stringify(createdPayloads[0]) === JSON.stringify({ uid: "uid-a", hashes: ["tx-1", "tx-2"] }),
      aggregatedProofCreatedForSuccessfulSubmission:
        proofCalls.length === 1 &&
        JSON.stringify(proofCalls[0][5]) === JSON.stringify(["tx-1", "tx-2"]),
      l2psMempoolStatusUpdatedToBatched:
        mempoolUpdates.length === 1 &&
        mempoolUpdates[0].status === L2PS_STATUS.BATCHED &&
        JSON.stringify(mempoolUpdates[0].hashes) === JSON.stringify(["tx-1", "tx-2"]),
      historyStatusesUpdatedPerTransaction:
        historyUpdates.length === 2 &&
        historyUpdates.every((entry) => entry[1] === "batched"),
      aggregatorStatsIncremented:
        aggregator.stats.totalBatchesCreated === 1 &&
        aggregator.stats.totalTransactionsBatched === 2 &&
        aggregator.stats.successfulSubmissions === 1 &&
        aggregator.stats.failedSubmissions === 0,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_process_batch_for_uid_smoke",
      ok,
      checks,
      createdPayloads,
      proofCalls,
      mempoolUpdates,
      historyUpdates,
      stats: aggregator.stats,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_process_batch_for_uid_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_process_batch_for_uid_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_process_batch_for_uid_smoke failed: processBatchForUID side effects drifted")
    }
  } finally {
    aggregator.MIN_BATCH_SIZE = previousMinBatchSize
    aggregator.stats = previousStats
    aggregator.createBatchPayload = previousCreateBatchPayload
    aggregator.aggregateGCREdits = previousAggregateGCREdits
    aggregator.submitBatchToMempool = previousSubmitBatchToMempool
    ;(L2PSProofManager as any).createProof = previousCreateProof
    ;(L2PSMempool as any).updateStatusBatch = previousUpdateStatusBatch
    ;(L2PSTransactionExecutor as any).updateTransactionStatus = previousUpdateTransactionStatus
  }
}

if (import.meta.main) {
  await runL2psProcessBatchForUidSmoke()
}

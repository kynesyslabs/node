import { getRunConfig, writeJson } from "../../framework/io"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"

export async function runL2psBatchSubmissionZkRejects() {
  const aggregator = L2PSBatchAggregator.getInstance() as any
  const previousZkEnabled = aggregator.zkEnabled
  const previousZkProver = aggregator.zkProver

  try {
    aggregator.zkEnabled = true

    const payloadBase = {
      l2ps_uid: "uid-zk",
      encrypted_batch: "ZW5j",
      transaction_count: 1,
      batch_hash: "batch-zk",
      transaction_hashes: ["tx-1"],
      authentication_tag: "a".repeat(64),
    }

    aggregator.zkProver = null
    const missingProver = await aggregator.submitBatchToMempool({
      ...payloadBase,
      zk_proof: {
        proof: {},
        publicSignals: [],
        batchSize: 1,
        finalStateRoot: "1",
        totalVolume: "1",
      },
    })

    aggregator.zkProver = {
      verifyProof: async () => true,
    }
    const invalidBigInt = await aggregator.submitBatchToMempool({
      ...payloadBase,
      zk_proof: {
        proof: {},
        publicSignals: [],
        batchSize: 1,
        finalStateRoot: "not-a-bigint",
        totalVolume: "2",
      },
    })

    let verifyCalls = 0
    aggregator.zkProver = {
      verifyProof: async () => {
        verifyCalls += 1
        return false
      },
    }
    const invalidProof = await aggregator.submitBatchToMempool({
      ...payloadBase,
      zk_proof: {
        proof: {},
        publicSignals: ["1"],
        batchSize: 1,
        finalStateRoot: "3",
        totalVolume: "4",
      },
    })

    const checks = {
      missingProverRejected: missingProver === false,
      invalidBigIntRejected: invalidBigInt === false,
      proverFailureRejected: invalidProof === false,
      proverUsedOnlyForWellShapedProof: verifyCalls === 1,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_batch_submission_zk_rejects",
      ok,
      checks,
      missingProver,
      invalidBigInt,
      invalidProof,
      verifyCalls,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_batch_submission_zk_rejects.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_batch_submission_zk_rejects_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_batch_submission_zk_rejects failed: ZK submission guardrails drifted")
    }
  } finally {
    aggregator.zkEnabled = previousZkEnabled
    aggregator.zkProver = previousZkProver
  }
}

if (import.meta.main) {
  await runL2psBatchSubmissionZkRejects()
}

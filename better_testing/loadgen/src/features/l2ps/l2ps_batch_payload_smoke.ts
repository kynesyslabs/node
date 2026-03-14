import { Hashing } from "@kynesyslabs/demosdk/encryption"
import { getRunConfig, writeJson } from "../../framework/io"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"
import { getSharedState } from "../../../../../src/utilities/sharedState"

export async function runL2psBatchPayloadSmoke() {
  const aggregator = L2PSBatchAggregator.getInstance() as any
  const previousKeypair = getSharedState.keypair
  const previousGenerateZkProofForBatch = aggregator.generateZkProofForBatch

  const transactions = [
    {
      hash: "tx-b",
      original_hash: "orig-b",
      encrypted_tx: { cipher: "B" },
    },
    {
      hash: "tx-a",
      original_hash: "orig-a",
      encrypted_tx: { cipher: "A" },
    },
  ] as any[]

  try {
    getSharedState.keypair = {
      privateKey: Uint8Array.from(Array.from({ length: 32 }, (_value, index) => index + 1)),
    } as any

    aggregator.generateZkProofForBatch = async (_txs: any[], batchHash: string) => `zk:${batchHash}`

    const payload = await aggregator.createBatchPayload("uid-batch", transactions)
    const decodedBatch = JSON.parse(Buffer.from(payload.encrypted_batch, "base64").toString("utf8"))
    const expectedBatchHash = Hashing.sha256("L2PS_BATCH_uid-batch:2:tx-a,tx-b")

    const checks = {
      deterministicBatchHashUsesSortedTransactionHashes: payload.batch_hash === expectedBatchHash,
      transactionCountMatchesInput: payload.transaction_count === 2,
      originalTransactionOrderPreservedInPayload:
        JSON.stringify(payload.transaction_hashes) === JSON.stringify(["tx-b", "tx-a"]),
      encodedBatchRoundTrips:
        JSON.stringify(decodedBatch.map((entry: any) => entry.hash)) === JSON.stringify(["tx-b", "tx-a"]),
      zkProofAttached: payload.zk_proof === `zk:${expectedBatchHash}`,
      authenticationTagPresent: typeof payload.authentication_tag === "string" && payload.authentication_tag.length === 64,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_batch_payload_smoke",
      ok,
      checks,
      payload: {
        ...payload,
        encrypted_batch_preview: payload.encrypted_batch.slice(0, 32),
      },
      decodedBatch,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_batch_payload_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_batch_payload_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_batch_payload_smoke failed: batch payload construction drifted")
    }
  } finally {
    getSharedState.keypair = previousKeypair
    aggregator.generateZkProofForBatch = previousGenerateZkProofForBatch
  }
}

if (import.meta.main) {
  await runL2psBatchPayloadSmoke()
}

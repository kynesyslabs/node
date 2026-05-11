import { ucrypto } from "@kynesyslabs/demosdk/encryption"
import { getRunConfig, writeJson } from "../../framework/io"
import Mempool from "../../../../../src/libs/blockchain/mempool"
import { L2PSBatchAggregator } from "../../../../../src/libs/l2ps/L2PSBatchAggregator"
import { getSharedState } from "../../../../../src/utilities/sharedState"

export async function runL2psBatchSubmissionSmoke() {
  const aggregator = L2PSBatchAggregator.getInstance() as any
  const previousAddTransaction = Mempool.addTransaction
  const previousEd25519KeyPair = (ucrypto as any).ed25519KeyPair
  const previousMasterSeed = (ucrypto as any).masterSeed
  const previousKeypair = getSharedState.keypair
  const previousSigningAlgorithm = getSharedState.signingAlgorithm
  const previousGetNextBatchNonce = aggregator.getNextBatchNonce
  const previousZkEnabled = aggregator.zkEnabled

  let submittedTx: any = null

  try {
    const masterSeed = Uint8Array.from(Array.from({ length: 128 }, (_value, index) => index + 1))
    await (ucrypto as any).generateIdentity("ed25519", masterSeed)
    const ed25519Identity = await (ucrypto as any).getIdentity("ed25519")

    getSharedState.keypair = ed25519Identity as any
    getSharedState.signingAlgorithm = "ed25519" as any

    aggregator.getNextBatchNonce = async () => 777001
    aggregator.zkEnabled = false

    ;(Mempool as any).addTransaction = async (tx: any) => {
      submittedTx = tx
      return { confirmationBlock: 88 }
    }

    const payload = {
      l2ps_uid: "uid-submit",
      encrypted_batch: "ZW5jcnlwdGVk",
      transaction_count: 2,
      batch_hash: "batch-hash-1",
      transaction_hashes: ["a", "b"],
      authentication_tag: "f".repeat(64),
    }

    const success = await aggregator.submitBatchToMempool(payload)
    const checks = {
      submissionSucceeded: success === true,
      mempoolCalledOnce: submittedTx !== null,
      selfDirectedContentUsesNodeIdentity:
        submittedTx?.content?.from === submittedTx?.content?.to &&
        submittedTx?.content?.from === submittedTx?.content?.from_ed25519_address &&
        typeof submittedTx?.content?.from === "string" &&
        submittedTx?.content?.from.startsWith("0x") &&
        submittedTx?.content?.from.length === 66,
      nonceComesFromBatchNonceGenerator: submittedTx?.content?.nonce === 777001,
      batchPayloadWrappedUnderL2psBatchOpcode:
        submittedTx?.content?.data?.[0] === "l2psBatch" &&
        submittedTx?.content?.data?.[1]?.batch_hash === "batch-hash-1",
      signatureDomainAttached: submittedTx?.signature?.domain === aggregator.SIGNATURE_DOMAIN,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_batch_submission_smoke",
      ok,
      checks,
      submittedTx,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_batch_submission_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_batch_submission_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_batch_submission_smoke failed: batch submission shape drifted")
    }
  } finally {
    (Mempool as any).addTransaction = previousAddTransaction
    ;(ucrypto as any).ed25519KeyPair = previousEd25519KeyPair
    ;(ucrypto as any).masterSeed = previousMasterSeed
    getSharedState.keypair = previousKeypair
    getSharedState.signingAlgorithm = previousSigningAlgorithm
    aggregator.getNextBatchNonce = previousGetNextBatchNonce
    aggregator.zkEnabled = previousZkEnabled
  }
}

if (import.meta.main) {
  await runL2psBatchSubmissionSmoke()
}

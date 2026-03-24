import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool from "../../../../../src/libs/blockchain/l2ps_mempool"
import { manageNodeCall } from "../../../../../src/libs/network/manageNodeCall"
import { getSharedState } from "../../../../../src/utilities/sharedState"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

export async function runL2psNodecallQueriesSmoke() {
  const previousJoinedUids = getSharedState.l2psJoinedUids
  const previousKeypair = getSharedState.keypair
  const previousGetByUID = L2PSMempool.getByUID

  try {
    getSharedState.l2psJoinedUids = ["uid-a"]
    getSharedState.keypair = {
      publicKey: Uint8Array.from(Array.from({ length: 32 }, (_value, index) => index + 1)),
      privateKey: Uint8Array.from(Array.from({ length: 32 }, (_value, index) => 255 - index)),
    } as any

    ;(L2PSMempool as any).getByUID = async (uid: string) => {
      if (uid === "uid-empty") return []
      return [
        {
          hash: "tx-1",
          l2ps_uid: uid,
          original_hash: "orig-1",
          encrypted_tx: { cipher: "one" },
          timestamp: "100",
          block_number: 5,
        },
        {
          hash: "tx-2",
          l2ps_uid: uid,
          original_hash: "orig-2",
          encrypted_tx: { cipher: "two" },
          timestamp: "200",
          block_number: 6,
        },
      ]
    }

    const participation = await manageNodeCall({ message: "getL2PSParticipationById", data: { l2psUid: "uid-a" } } as any)
    const participationMissing = await manageNodeCall({ message: "getL2PSParticipationById", data: {} } as any)
    const mempoolInfo = await manageNodeCall({ message: "getL2PSMempoolInfo", data: { l2psUid: "uid-a" } } as any)
    const txsFiltered = await manageNodeCall({
      message: "getL2PSTransactions",
      data: { l2psUid: "uid-a", since_timestamp: "150" },
    } as any)

    const checks = {
      participationReflectsJoinedUid:
        participation.result === 200 &&
        participation.response.participating === true &&
        participation.response.nodeIdentity === uint8ArrayToHex(getSharedState.keypair!.publicKey as Uint8Array),
      missingParticipationUidRejected: participationMissing.result === 400,
      mempoolInfoSummarizesTimestamps:
        mempoolInfo.result === 200 &&
        mempoolInfo.response.transactionCount === 2 &&
        mempoolInfo.response.oldestTimestamp === "100" &&
        mempoolInfo.response.lastTimestamp === "200",
      incrementalTransactionQueryFiltersByTimestamp:
        txsFiltered.result === 200 &&
        txsFiltered.response.count === 1 &&
        txsFiltered.response.transactions[0].hash === "tx-2",
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_nodecall_queries_smoke",
      ok,
      checks,
      participation,
      participationMissing,
      mempoolInfo,
      txsFiltered,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_nodecall_queries_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_nodecall_queries_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_nodecall_queries_smoke failed: L2PS NodeCall query behavior drifted")
    }
  } finally {
    getSharedState.l2psJoinedUids = previousJoinedUids
    getSharedState.keypair = previousKeypair
    ;(L2PSMempool as any).getByUID = previousGetByUID
  }
}

if (import.meta.main) {
  await runL2psNodecallQueriesSmoke()
}

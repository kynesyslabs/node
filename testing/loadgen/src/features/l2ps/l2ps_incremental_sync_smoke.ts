import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool from "../../../../../src/libs/blockchain/l2ps_mempool"
import { syncL2PSWithPeer } from "../../../../../src/libs/l2ps/L2PSConcurrentSync"

export async function runL2psIncrementalSyncSmoke() {
  const previousGetLastTransaction = L2PSMempool.getLastTransaction
  const previousAddTransaction = L2PSMempool.addTransaction

  const addCalls: Array<{ uid: string; hash: string; originalHash: string; status: string }> = []
  let capturedSinceTimestamp: number | null = null
  let peerCalls = 0

  ;(L2PSMempool as any).getLastTransaction = async () => ({ timestamp: "424242" })
  ;(L2PSMempool as any).addTransaction = async (
    uid: string,
    encryptedTx: any,
    originalHash: string,
    status: string,
  ) => {
    addCalls.push({ uid, hash: encryptedTx.hash, originalHash, status })
    if (encryptedTx.hash === "enc-duplicate") {
      return { success: false, error: "Encrypted transaction already in L2PS mempool" }
    }
    if (encryptedTx.hash === "enc-throws") {
      throw new Error("insertion failure")
    }
    return { success: true }
  }

  try {
    const peer = {
      identity: "peer-sync",
      call: async ({ params }: any) => {
        peerCalls += 1
        const payload = params?.[0]
        const message = payload?.message
        if (message !== "getL2PSTransactions") {
          throw new Error(`unexpected message: ${message}`)
        }
        capturedSinceTimestamp = payload?.data?.since_timestamp ?? null
        return {
          result: 200,
          response: {
            transactions: [
              { encrypted_tx: null, original_hash: "bad-1" },
              {
                encrypted_tx: { hash: "enc-good", content: { amount: "1" } },
                original_hash: "orig-good",
              },
              {
                encrypted_tx: { hash: "enc-duplicate", content: { amount: "2" } },
                original_hash: "orig-duplicate",
              },
              {
                encrypted_tx: { hash: "enc-throws", content: { amount: "3" } },
                original_hash: "orig-throws",
              },
            ],
          },
        }
      },
    } as any

    await syncL2PSWithPeer(peer, "uid-sync")

    const checks = {
      peerWasQueried: peerCalls === 1,
      sinceTimestampDerivedFromLatestTransaction: capturedSinceTimestamp === 424242,
      onlyStructurallyValidTransactionsAttempted: addCalls.length === 3,
      statusForcedToProcessed: addCalls.every((call) => call.status === "processed"),
      uidPreservedOnInsert: addCalls.every((call) => call.uid === "uid-sync"),
      duplicateAndInsertErrorsDidNotAbortSync:
        JSON.stringify(addCalls.map((call) => call.hash)) ===
        JSON.stringify(["enc-good", "enc-duplicate", "enc-throws"]),
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_incremental_sync_smoke",
      ok,
      checks,
      peerCalls,
      capturedSinceTimestamp,
      addCalls,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_incremental_sync_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_incremental_sync_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_incremental_sync_smoke failed: sync request or transaction processing behavior drifted")
    }
  } finally {
    ;(L2PSMempool as any).getLastTransaction = previousGetLastTransaction
    ;(L2PSMempool as any).addTransaction = previousAddTransaction
  }
}

if (import.meta.main) {
  await runL2psIncrementalSyncSmoke()
}

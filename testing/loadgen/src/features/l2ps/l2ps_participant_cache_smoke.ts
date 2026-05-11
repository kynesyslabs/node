import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool from "../../../../../src/libs/blockchain/l2ps_mempool"
import {
  addL2PSParticipant,
  clearL2PSCache,
  discoverL2PSParticipants,
} from "../../../../../src/libs/l2ps/L2PSConcurrentSync"

export async function runL2psParticipantCacheSmoke() {
  const previousGetLastTransaction = L2PSMempool.getLastTransaction
  let cachedPeerCalls = 0
  let livePeerCalls = 0

  ;(L2PSMempool as any).getLastTransaction = async () => null
  clearL2PSCache()

  try {
    addL2PSParticipant("uid-cache", "peer-cached")

    const cachedPeer = {
      identity: "peer-cached",
      call: async () => {
        cachedPeerCalls += 1
        return { result: 500 }
      },
    } as any

    const livePeer = {
      identity: "peer-live",
      call: async ({ params }: any) => {
        livePeerCalls += 1
        const message = params?.[0]?.message
        if (message === "getL2PSParticipationById") {
          return { result: 200, response: { participating: true } }
        }
        if (message === "getL2PSTransactions") {
          return { result: 200, response: { transactions: [] } }
        }
        throw new Error(`unexpected message: ${message}`)
      },
    } as any

    const discovered = await discoverL2PSParticipants([cachedPeer, livePeer], ["uid-cache"])
    const participants = (discovered.get("uid-cache") ?? []).slice().sort()

    const checks = {
      cachedPeerSkippedRpcCall: cachedPeerCalls === 0,
      livePeerQueriedAndAdded: livePeerCalls >= 1,
      bothParticipantsReturned:
        JSON.stringify(participants) === JSON.stringify(["peer-cached", "peer-live"]),
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_participant_cache_smoke",
      ok,
      checks,
      participants,
      cachedPeerCalls,
      livePeerCalls,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_participant_cache_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_participant_cache_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_participant_cache_smoke failed: cache-backed discovery behavior did not match expectations")
    }
  } finally {
    (L2PSMempool as any).getLastTransaction = previousGetLastTransaction
    clearL2PSCache()
  }
}

if (import.meta.main) {
  await runL2psParticipantCacheSmoke()
}

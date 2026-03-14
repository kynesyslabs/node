import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool from "../../../../../src/libs/blockchain/l2ps_mempool"
import {
  clearL2PSCache,
  discoverL2PSParticipants,
  exchangeL2PSParticipation,
} from "../../../../../src/libs/l2ps/L2PSConcurrentSync"
import { getSharedState } from "../../../../../src/utilities/sharedState"

export async function runL2psExchangeParticipationSmoke() {
  const previousGetLastTransaction = L2PSMempool.getLastTransaction
  const previousJoinedUids = getSharedState.l2psJoinedUids

  let peerCalls = 0
  ;(L2PSMempool as any).getLastTransaction = async () => null
  getSharedState.l2psJoinedUids = ["uid-exchange"]
  clearL2PSCache()

  try {
    const peer = {
      identity: "peer-exchange",
      call: async ({ params }: any) => {
        peerCalls += 1
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

    await exchangeL2PSParticipation([peer])
    const callsAfterExchange = peerCalls
    const discovered = await discoverL2PSParticipants([peer], ["uid-exchange"])
    const participants = discovered.get("uid-exchange") ?? []

    const checks = {
      exchangeTriggeredInitialDiscovery: callsAfterExchange >= 1,
      exchangeSeededCacheForSamePeerIdentity: peerCalls === callsAfterExchange,
      participantReturnedAfterExchange: JSON.stringify(participants) === JSON.stringify(["peer-exchange"]),
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_exchange_participation_smoke",
      ok,
      checks,
      peerCalls,
      callsAfterExchange,
      participants,
      joinedUidsUsed: getSharedState.l2psJoinedUids,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_exchange_participation_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_exchange_participation_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_exchange_participation_smoke failed: exchange did not delegate through discovery as expected")
    }
  } finally {
    ;(L2PSMempool as any).getLastTransaction = previousGetLastTransaction
    getSharedState.l2psJoinedUids = previousJoinedUids
    clearL2PSCache()
  }
}

if (import.meta.main) {
  await runL2psExchangeParticipationSmoke()
}

import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool from "../../../../../src/libs/blockchain/l2ps_mempool"
import {
  clearL2PSCache,
  discoverL2PSParticipants,
} from "../../../../../src/libs/l2ps/L2PSConcurrentSync"

export async function runL2psParticipantDiscoveryResilience() {
  const previousGetLastTransaction = L2PSMempool.getLastTransaction
  const calls: Record<string, number> = {
    "peer-yes": 0,
    "peer-no": 0,
    "peer-err": 0,
  }

  ;(L2PSMempool as any).getLastTransaction = async () => null
  clearL2PSCache()

  try {
    const peers = [
      {
        identity: "peer-yes",
        call: async ({ params }: any) => {
          calls["peer-yes"] += 1
          const message = params?.[0]?.message
          if (message === "getL2PSParticipationById") {
            return { result: 200, response: { participating: true } }
          }
          if (message === "getL2PSTransactions") {
            return { result: 200, response: { transactions: [] } }
          }
          throw new Error(`unexpected message: ${message}`)
        },
      },
      {
        identity: "peer-no",
        call: async ({ params }: any) => {
          calls["peer-no"] += 1
          const message = params?.[0]?.message
          if (message === "getL2PSParticipationById") {
            return { result: 200, response: { participating: false } }
          }
          throw new Error(`unexpected message: ${message}`)
        },
      },
      {
        identity: "peer-err",
        call: async () => {
          calls["peer-err"] += 1
          throw new Error("peer unreachable")
        },
      },
    ] as any[]

    const discovered = await discoverL2PSParticipants(peers, ["uid-resilience"])
    const participants = discovered.get("uid-resilience") ?? []

    const checks = {
      successfulPeerIncluded: JSON.stringify(participants) === JSON.stringify(["peer-yes"]),
      nonParticipatingPeerExcluded: !participants.includes("peer-no"),
      throwingPeerDidNotBreakDiscovery: calls["peer-err"] === 1,
      allPeersAttempted: calls["peer-yes"] >= 1 && calls["peer-no"] === 1,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_participant_discovery_resilience",
      ok,
      checks,
      participants,
      calls,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_participant_discovery_resilience.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_participant_discovery_resilience_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_participant_discovery_resilience failed: discovery did not tolerate mixed peer outcomes")
    }
  } finally {
    (L2PSMempool as any).getLastTransaction = previousGetLastTransaction
    clearL2PSCache()
  }
}

if (import.meta.main) {
  await runL2psParticipantDiscoveryResilience()
}

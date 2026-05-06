import { DemosTransactions } from "@kynesyslabs/demosdk/websdk"
import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool from "../../../../../src/libs/blockchain/l2ps_mempool"
import { L2PSHashService } from "../../../../../src/libs/l2ps/L2PSHashService"

export async function runL2psHashProcessNetworkSmoke() {
  const service = L2PSHashService.getInstance() as any
  const previousGetHashForL2PS = L2PSMempool.getHashForL2PS
  const previousGetByUID = L2PSMempool.getByUID
  const previousCreateL2PSHashUpdate = DemosTransactions.createL2PSHashUpdate
  const previousRelayToValidators = service.relayToValidators
  const previousDemos = service.demos
  const previousStats = service.stats

  const createCalls: any[] = []
  const relayCalls: any[] = []

  try {
    service.demos = { sentinel: "demos" }
    service.stats = {
      totalCycles: 0,
      successfulCycles: 0,
      failedCycles: 0,
      skippedCycles: 0,
      totalHashesGenerated: 0,
      successfulRelays: 0,
      lastCycleTime: 0,
      averageCycleTime: 0,
    }

    ;(L2PSMempool as any).getHashForL2PS = async (uid: string) => {
      if (uid === "uid-empty-hash") return ""
      if (uid === "uid-zero") return "hash-zero"
      return "hash-live"
    }
    ;(L2PSMempool as any).getByUID = async (uid: string) => {
      if (uid === "uid-zero") return []
      return [{ hash: "tx-1" }, { hash: "tx-2" }]
    }
    ;(DemosTransactions as any).createL2PSHashUpdate = async (...args: any[]) => {
      createCalls.push(args)
      return { kind: "hash-update", args }
    }
    service.relayToValidators = async (tx: any) => {
      relayCalls.push(tx)
    }

    await service.processL2PSNetwork("uid-empty-hash")
    await service.processL2PSNetwork("uid-zero")
    await service.processL2PSNetwork("uid-live")

    const checks = {
      emptyHashSkipped: createCalls.length === 1,
      zeroTransactionUidSkipped: relayCalls.length === 1,
      hashUpdateCreatedForLiveUid:
        createCalls.length === 1 &&
        createCalls[0][0] === "uid-live" &&
        createCalls[0][1] === "hash-live" &&
        createCalls[0][2] === 2,
      relayInvokedForLiveUidOnly: relayCalls.length === 1 && relayCalls[0].kind === "hash-update",
      statsIncrementedOnSuccessfulLivePath:
        service.stats.totalHashesGenerated === 1 && service.stats.successfulRelays === 1,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_hash_process_network_smoke",
      ok,
      checks,
      createCalls,
      relayCalls,
      stats: service.stats,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_hash_process_network_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_hash_process_network_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_hash_process_network_smoke failed: processL2PSNetwork live-path behavior drifted")
    }
  } finally {
    (L2PSMempool as any).getHashForL2PS = previousGetHashForL2PS
    ;(L2PSMempool as any).getByUID = previousGetByUID
    ;(DemosTransactions as any).createL2PSHashUpdate = previousCreateL2PSHashUpdate
    service.relayToValidators = previousRelayToValidators
    service.demos = previousDemos
    service.stats = previousStats
  }
}

if (import.meta.main) {
  await runL2psHashProcessNetworkSmoke()
}

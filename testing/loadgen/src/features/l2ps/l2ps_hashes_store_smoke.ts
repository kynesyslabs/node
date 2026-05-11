import { getRunConfig, writeJson } from "../../framework/io"
import L2PSHashes from "../../../../../src/libs/blockchain/l2ps_hashes"

export async function runL2psHashesStoreSmoke() {
  const previousRepo = (L2PSHashes as any).repo

  const stored = new Map<string, any>()
  const saveCalls: any[] = []

  try {
    (L2PSHashes as any).repo = {
      save: async (entry: any) => {
        saveCalls.push(entry)
        stored.set(entry.l2ps_uid, entry)
        return entry
      },
      findOne: async ({ where }: any) => stored.get(where.l2ps_uid),
      find: async ({ order, take, skip }: any) => {
        const entries = Array.from(stored.values()).sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
        const sliced = entries.slice(skip ?? 0, take ? (skip ?? 0) + take : undefined)
        return order ? sliced : entries
      },
    }

    await L2PSHashes.updateHash("uid-a", "hash-a1", 2, BigInt(11))
    await L2PSHashes.updateHash("uid-b", "hash-b1", 5, BigInt(12))
    await L2PSHashes.updateHash("uid-a", "hash-a2", 7, BigInt(13))

    const currentA = await L2PSHashes.getHash("uid-a")
    const currentMissing = await L2PSHashes.getHash("uid-missing")
    const page = await L2PSHashes.getAll(1, 1)
    const stats = await L2PSHashes.getStats()

    const checks = {
      upsertReplacedExistingUid: currentA?.hash === "hash-a2" && currentA?.transaction_count === 7,
      missingUidReturnsNull: currentMissing === null,
      paginationWorks: page.length === 1,
      statsReflectUniqueNetworkCount: stats.totalNetworks === 2,
      statsAggregateTransactions: stats.totalTransactions === 12,
      saveCalledForEachUpdate: saveCalls.length === 3,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_hashes_store_smoke",
      ok,
      checks,
      saveCalls,
      currentA,
      currentMissing,
      page,
      stats: {
        ...stats,
        lastUpdateTime: stats.lastUpdateTime.toString(),
        oldestUpdateTime: stats.oldestUpdateTime.toString(),
      },
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_hashes_store_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_hashes_store_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_hashes_store_smoke failed: validator hash storage behavior drifted")
    }
  } finally {
    (L2PSHashes as any).repo = previousRepo
  }
}

if (import.meta.main) {
  await runL2psHashesStoreSmoke()
}

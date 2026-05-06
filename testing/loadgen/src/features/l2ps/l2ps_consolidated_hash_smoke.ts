import { Hashing } from "@kynesyslabs/demosdk/encryption"
import { getRunConfig, writeJson } from "../../framework/io"
import L2PSMempool from "../../../../../src/libs/blockchain/l2ps_mempool"

export async function runL2psConsolidatedHashSmoke() {
  const previousRepo = (L2PSMempool as any).repo
  const seenOptions: any[] = []

  try {
    (L2PSMempool as any).repo = {
      find: async (options: any) => {
        seenOptions.push(options)
        if (options?.where?.l2ps_uid === "uid-hash" && options?.where?.block_number === 7) {
          return [{ hash: "tx-b" }, { hash: "tx-a" }, { hash: "tx-c" }]
        }
        if (options?.where?.l2ps_uid === "uid-empty") {
          return []
        }
        throw new Error("repo exploded")
      },
    }

    const blockHash = await L2PSMempool.getHashForL2PS("uid-hash", 7)
    const emptyHash = await L2PSMempool.getHashForL2PS("uid-empty")
    const errorHash = await L2PSMempool.getHashForL2PS("uid-error")

    const expectedBlockHash = Hashing.sha256("L2PS_uid-hash_BLOCK_7:3:tx-a,tx-b,tx-c")
    const expectedEmptyHash = Hashing.sha256("L2PS_EMPTY_uid-empty_ALL")
    const expectedErrorHash = Hashing.sha256("L2PS_ERROR_uid-error_ALL")

    const checks = {
      sortedHashInputIsDeterministic: blockHash === expectedBlockHash,
      emptyHashPathIsDeterministic: emptyHash === expectedEmptyHash,
      errorHashPathIsDeterministic: errorHash === expectedErrorHash,
      processedStatusFilterUsed: seenOptions.every((options) => options?.where?.status === "processed"),
      blockFilterPropagated: seenOptions[0]?.where?.block_number === 7,
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_consolidated_hash_smoke",
      ok,
      checks,
      blockHash,
      emptyHash,
      errorHash,
      seenOptions,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_consolidated_hash_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_consolidated_hash_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_consolidated_hash_smoke failed: consolidated hash behavior drifted")
    }
  } finally {
    (L2PSMempool as any).repo = previousRepo
  }
}

if (import.meta.main) {
  await runL2psConsolidatedHashSmoke()
}

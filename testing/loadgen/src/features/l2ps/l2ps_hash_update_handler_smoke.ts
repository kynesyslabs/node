import { getRunConfig, writeJson } from "../../framework/io"
import L2PSHashes from "../../../../../src/libs/blockchain/l2ps_hashes"
import ParallelNetworks from "../../../../../src/libs/l2ps/parallelNetworks"
import ServerHandlers from "../../../../../src/libs/network/endpointHandlers"

export async function runL2psHashUpdateHandlerSmoke() {
  const previousUpdateHash = L2PSHashes.updateHash
  const parallelNetworks = ParallelNetworks.getInstance() as any
  const previousGetL2PS = parallelNetworks.getL2PS

  const storedCalls: any[] = []

  try {
    ;(L2PSHashes as any).updateHash = async (...args: any[]) => {
      storedCalls.push(args)
    }
    parallelNetworks.getL2PS = async (uid: string) => (uid === "uid-joined" ? { uid } : undefined)

    const invalidStructure = await ServerHandlers.handleL2PSHashUpdate({
      content: { data: ["l2ps_hash_update"] },
    } as any)

    const missingBlock = await ServerHandlers.handleL2PSHashUpdate({
      content: {
        data: ["l2ps_hash_update", { l2ps_uid: "uid-joined", consolidated_hash: "hash-1", transaction_count: 2 }],
      },
    } as any)

    const missingNetwork = await ServerHandlers.handleL2PSHashUpdate({
      blockNumber: 42,
      content: {
        data: ["l2ps_hash_update", { l2ps_uid: "uid-missing", consolidated_hash: "hash-2", transaction_count: 3 }],
      },
    } as any)

    const success = await ServerHandlers.handleL2PSHashUpdate({
      blockNumber: 44,
      content: {
        data: ["l2ps_hash_update", { l2ps_uid: "uid-joined", consolidated_hash: "hash-3", transaction_count: 5 }],
      },
    } as any)

    const checks = {
      invalidStructureRejected: invalidStructure.result === 400,
      missingBlockRejected: missingBlock.result === 400,
      unknownNetworkRejected: missingNetwork.result === 403,
      successfulUpdateStoredHash:
        success.result === 200 &&
        storedCalls.length === 1 &&
        storedCalls[0][0] === "uid-joined" &&
        storedCalls[0][1] === "hash-3" &&
        storedCalls[0][2] === 5 &&
        storedCalls[0][3] === BigInt(44),
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "l2ps_hash_update_handler_smoke",
      ok,
      checks,
      invalidStructure,
      missingBlock,
      missingNetwork,
      success,
      storedCalls: storedCalls.map((call) => [call[0], call[1], call[2], call[3].toString()]),
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/l2ps/l2ps_hash_update_handler_smoke.summary.json`, summary)
    console.log(JSON.stringify({ l2ps_hash_update_handler_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("l2ps_hash_update_handler_smoke failed: validator hash update handler behavior drifted")
    }
  } finally {
    ;(L2PSHashes as any).updateHash = previousUpdateHash
    parallelNetworks.getL2PS = previousGetL2PS
  }
}

if (import.meta.main) {
  await runL2psHashUpdateHandlerSmoke()
}

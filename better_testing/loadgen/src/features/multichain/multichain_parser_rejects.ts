import { getRunConfig, writeJson } from "../../framework/io"
import XMParser from "../../../../../src/features/multichain/routines/XMParser"

export async function runMultichainParserRejects() {
  let invalidChain: any
  try {
    invalidChain = await XMParser.executeOperation({
      chain: "not-a-chain",
      subchain: "unknown",
      is_evm: true,
      task: { type: "pay", params: {} },
    } as any)
  } catch (error) {
    invalidChain = {
      result: "threw",
      error: (error as Error).message,
    }
  }

  const unknownTask = await XMParser.executeOperation({
    chain: "ethereum",
    subchain: "1",
    is_evm: true,
    task: { type: "mystery_task", params: {} },
  } as any)

  const checks = {
    invalidChainRejected: invalidChain.result === "error" && invalidChain.error === "Invalid chain or subchain",
    unknownTaskRejected: unknownTask.result === "error" && unknownTask.error === "Unknown task type: mystery_task",
  }

  const ok = Object.values(checks).every(Boolean)
  const run = getRunConfig()
  const summary = {
    scenario: "multichain_parser_rejects",
    ok,
    checks,
    invalidChain,
    unknownTask,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/multichain/multichain_parser_rejects.summary.json`, summary)
  console.log(JSON.stringify({ multichain_parser_rejects_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("multichain_parser_rejects failed: XM parser reject behavior did not match expectations")
  }
}

if (import.meta.main) {
  await runMultichainParserRejects()
}

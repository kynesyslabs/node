import { getRunConfig, writeJson } from "../../framework/io"
import XMParser from "../../../../../src/features/multichain/routines/XMParser"

export async function runMultichainParserExecuteSmoke() {
  const originalExecuteOperation = XMParser.executeOperation

  ;(XMParser as any).executeOperation = async (operation: any) => {
    if (operation.behavior === "throw") {
      throw new Error("synthetic parser failure")
    }

    return {
      result: operation.behavior === "error" ? "error" : "ok",
      error: operation.behavior === "error" ? "synthetic operation error" : undefined,
    }
  }

  try {
    const results = await XMParser.execute({
      operations: {
        alpha: { behavior: "ok" },
        beta: { behavior: "throw" },
        gamma: { behavior: "error" },
      },
    } as any)

    const checks = {
      alphaOk: results.alpha?.result === "ok",
      betaCaughtAsError: results.beta?.result === "error" && String(results.beta?.error).includes("synthetic parser failure"),
      gammaPreserved: results.gamma?.result === "error" && results.gamma?.error === "synthetic operation error",
      allKeysPresent: JSON.stringify(Object.keys(results)) === JSON.stringify(["alpha", "beta", "gamma"]),
    }

    const ok = Object.values(checks).every(Boolean)
    const run = getRunConfig()
    const summary = {
      scenario: "multichain_parser_execute_smoke",
      ok,
      checks,
      results,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/multichain/multichain_parser_execute_smoke.summary.json`, summary)
    console.log(JSON.stringify({ multichain_parser_execute_smoke_summary: summary }, null, 2))

    if (!ok) {
      throw new Error("multichain_parser_execute_smoke failed: XM parser execute aggregation did not match expectations")
    }
  } finally {
    (XMParser as any).executeOperation = originalExecuteOperation
  }
}

if (import.meta.main) {
  await runMultichainParserExecuteSmoke()
}

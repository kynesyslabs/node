import { getRunConfig, writeJson } from "../../framework/io"
import MultichainDispatcher from "../../../../../src/features/multichain/XMDispatcher"
import XMParser from "../../../../../src/features/multichain/routines/XMParser"

export async function runMultichainDispatcherAggregation() {
  const originalExecute = XMParser.execute

  const cases = [
    {
      label: "all_failed",
      fakeResults: {
        alpha: { result: "error", error: "boom" },
        beta: { result: "error", error: "boom2" },
      },
      expected: { success: false, message: "all_ops_failed" },
    },
    {
      label: "partial_success",
      fakeResults: {
        alpha: { result: "ok" },
        beta: { result: "error", error: "boom" },
      },
      expected: { success: true, message: "partial_success" },
    },
    {
      label: "all_ok",
      fakeResults: {
        alpha: { result: "ok" },
        beta: { result: "ok" },
      },
      expected: { success: true, message: "all_ops_ok" },
    },
  ]

  const results = []

  try {
    for (const testCase of cases) {
      ;(XMParser as any).execute = async () => testCase.fakeResults
      const actual = await MultichainDispatcher.execute({ operations: {} } as any)
      results.push({
        label: testCase.label,
        actual,
        expected: testCase.expected,
        ok: actual.success === testCase.expected.success
          && actual.message === testCase.expected.message
          && JSON.stringify(actual.results) === JSON.stringify(testCase.fakeResults),
      })
    }
  } finally {
    ;(XMParser as any).execute = originalExecute
  }

  const ok = results.every(result => result.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "multichain_dispatcher_aggregation",
    ok,
    cases: results,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/multichain/multichain_dispatcher_aggregation.summary.json`, summary)
  console.log(JSON.stringify({ multichain_dispatcher_aggregation_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("multichain_dispatcher_aggregation failed: dispatcher result envelope did not match expectations")
  }
}

if (import.meta.main) {
  await runMultichainDispatcherAggregation()
}

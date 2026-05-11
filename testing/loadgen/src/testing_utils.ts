export * from "./framework/common"
export * from "./framework/metrics"

// ── Test assertions ──────────────────────────────────────────────────

export interface AssertionResult {
  passed: boolean
  failures: string[]
}

export function assertLoadgenResults(opts: {
  label: string
  totalOps: number
  errorCount: number
  maxErrorRate?: number // default 0.05 (5%)
  minOps?: number // default 1
}): AssertionResult {
  const maxErrorRate = opts.maxErrorRate ?? 0.05
  const minOps = opts.minOps ?? 1
  const failures: string[] = []

  if (opts.totalOps < minOps) {
    failures.push(`[${opts.label}] Too few operations: ${opts.totalOps} < ${minOps}`)
  }

  const errorRate = opts.totalOps > 0 ? opts.errorCount / opts.totalOps : 1
  if (errorRate > maxErrorRate) {
    failures.push(
      `[${opts.label}] Error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold ${(maxErrorRate * 100).toFixed(1)}%`,
    )
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`ASSERTION FAILED: ${f}`)
  }

  return { passed: failures.length === 0, failures }
}

/**
 * Call at the end of a test to exit with appropriate code.
 * Pass all assertion results; exits 1 if any failed.
 */
export function exitWithAssertions(...results: AssertionResult[]): never {
  const allFailures = results.flatMap(r => r.failures)
  if (allFailures.length > 0) {
    console.error(`\n=== TEST FAILED (${allFailures.length} assertion(s)) ===`)
    for (const f of allFailures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.log("\n=== TEST PASSED ===")
  process.exit(0)
}

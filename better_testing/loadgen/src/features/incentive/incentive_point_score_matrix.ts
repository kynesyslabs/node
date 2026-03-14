import { getRunConfig, writeJson } from "../../framework/io"
import { PointSystem } from "../../../../../src/features/incentive/PointSystem"

export async function runIncentivePointScoreMatrix() {
  const pointSystem = PointSystem.getInstance() as any

  const nomisCases = [
    { score: 0.19, expected: 1 },
    { score: 0.2, expected: 2 },
    { score: 0.4, expected: 3 },
    { score: 0.6, expected: 4 },
    { score: 0.8, expected: 5 },
  ].map(testCase => {
    const actual = pointSystem.getNomisPointsByScore(testCase.score)
    return { ...testCase, actual, ok: actual === testCase.expected }
  })

  const ethosCases = [
    { score: 799, expected: 1 },
    { score: 800, expected: 2 },
    { score: 1200, expected: 3 },
    { score: 1600, expected: 4 },
    { score: 2000, expected: 5 },
  ].map(testCase => {
    const actual = pointSystem.getEthosPointsByScore(testCase.score)
    return { ...testCase, actual, ok: actual === testCase.expected }
  })

  const ok = [...nomisCases, ...ethosCases].every(testCase => testCase.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "incentive_point_score_matrix",
    ok,
    nomisCases,
    ethosCases,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/incentive/incentive_point_score_matrix.summary.json`, summary)
  console.log(JSON.stringify({ incentive_point_score_matrix_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("incentive_point_score_matrix failed: score bucketing did not match expectations")
  }
}

if (import.meta.main) {
  await runIncentivePointScoreMatrix()
}

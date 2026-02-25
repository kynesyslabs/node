import { runTokenBurnLoadgen } from "./token_burn_loadgen"
import { getRunConfig, writeJson } from "./run_io"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function runTokenBurnRamp() {
  const ramp = splitCsv(process.env.RAMP_CONCURRENCY)
    .map(s => Number.parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n > 0)
  const stepDurationSec = envInt("STEP_DURATION_SEC", 15)
  const cooldownSec = envInt("COOLDOWN_SEC", 3)

  if (ramp.length === 0) throw new Error("RAMP_CONCURRENCY must be a comma-separated list of positive ints")

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_burn_ramp`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
  }

  const results: any[] = []

  for (const conc of ramp) {
    process.env.SCENARIO = "token_burn"
    process.env.DURATION_SEC = String(stepDurationSec)
    process.env.CONCURRENCY = String(conc)

    let stepSummary: any = null
    let stepError: any = null

    const originalLog = console.log
    const capture: any[] = []
    console.log = (...args: any[]) => {
      capture.push(args)
      originalLog(...args)
    }

    try {
      await runTokenBurnLoadgen()
      for (const row of capture) {
        const payload = row?.[0]
        if (payload && typeof payload === "string") {
          try {
            const parsed = JSON.parse(payload)
            if (parsed?.token_burn_summary) stepSummary = parsed.token_burn_summary
          } catch {
            // ignore
          }
        } else if (payload?.token_burn_summary) {
          stepSummary = payload.token_burn_summary
        }
      }
    } catch (err: any) {
      stepError = { message: err?.message ?? String(err) }
    } finally {
      console.log = originalLog
    }

    results.push({
      concurrency: conc,
      stepDurationSec,
      cooldownSec,
      summary: stepSummary,
      error: stepError,
    })

    if (cooldownSec > 0) await sleep(cooldownSec * 1000)
  }

  const okSteps = results
    .map(r => ({ concurrency: r.concurrency, okTps: r.summary?.okTps }))
    .filter(r => typeof r.okTps === "number")

  const best = okSteps.sort((a, b) => (b.okTps ?? 0) - (a.okTps ?? 0))[0] ?? null

  const rampSummary = {
    scenario: "token_burn_ramp",
    bestByOkTps: best,
    steps: results,
    config: {
      rampConcurrency: ramp,
      stepDurationSec,
      cooldownSec,
      inflightPerWallet: envInt("INFLIGHT_PER_WALLET", 1),
      tokenBurnAmount: process.env.TOKEN_BURN_AMOUNT ?? process.env.AMOUNT ?? "1",
    },
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, rampSummary)
  console.log(JSON.stringify({ token_burn_ramp_summary: rampSummary }, null, 2))
}


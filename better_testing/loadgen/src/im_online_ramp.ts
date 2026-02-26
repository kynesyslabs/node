import { runImOnlineLoadgen } from "./im_online_loadgen"
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

export async function runImOnlineRamp() {
  const rampPairs = splitCsv(process.env.RAMP_PAIRS ?? "1,2,4,8,16")
    .map(s => Number.parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n > 0)
  const stepDurationSec = envInt("STEP_DURATION_SEC", 15)
  const cooldownSec = envInt("COOLDOWN_SEC", 3)

  if (rampPairs.length === 0) throw new Error("RAMP_PAIRS must be a comma-separated list of positive ints")

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/im_online_ramp`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
  }

  const results: any[] = []

  for (const pairs of rampPairs) {
    process.env.SCENARIO = "im_online"
    process.env.DURATION_SEC = String(stepDurationSec)
    process.env.IM_PAIRS = String(pairs)

    let stepSummary: any = null
    let stepError: any = null

    const originalLog = console.log
    const capture: any[] = []
    console.log = (...args: any[]) => {
      capture.push(args)
      originalLog(...args)
    }

    try {
      await runImOnlineLoadgen()
      for (const row of capture) {
        const payload = row?.[0]
        if (payload && typeof payload === "string") {
          try {
            const parsed = JSON.parse(payload)
            if (parsed?.im_online_summary) stepSummary = parsed.im_online_summary
          } catch {
            // ignore
          }
        } else if (payload?.im_online_summary) {
          stepSummary = payload.im_online_summary
        }
      }
    } catch (err: any) {
      stepError = { message: err?.message ?? String(err) }
    } finally {
      console.log = originalLog
    }

    results.push({
      pairs,
      stepDurationSec,
      cooldownSec,
      summary: stepSummary,
      error: stepError,
    })

    if (cooldownSec > 0) await sleep(cooldownSec * 1000)
  }

  const okSteps = results
    .map(r => ({ pairs: r.pairs, okTps: r.summary?.okTps, p95: r.summary?.latencyMs?.p95 }))
    .filter(r => typeof r.okTps === "number")

  const best = okSteps.sort((a, b) => (b.okTps ?? 0) - (a.okTps ?? 0))[0] ?? null

  const rampSummary = {
    scenario: "im_online_ramp",
    bestByOkTps: best,
    steps: results,
    config: {
      rampPairs,
      stepDurationSec,
      cooldownSec,
      inflightPerSender: envInt("INFLIGHT_PER_SENDER", envInt("INFLIGHT_PER_WALLET", 1)),
      messageBytes: envInt("IM_MESSAGE_BYTES", 128),
      rateLimitRps: envInt("RATE_LIMIT_RPS", 0),
    },
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, rampSummary)
  console.log(JSON.stringify({ im_online_ramp_summary: rampSummary }, null, 2))
}


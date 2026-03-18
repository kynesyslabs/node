import { runRpcLoadgen } from "./rpc_loadgen"

type RampStepResult = {
  concurrency: number
  durationSec: number
  report?: any
  error?: { message: string }
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function parseRampSteps(): number[] {
  const raw = process.env.RAMP_CONCURRENCY ?? "10,50,100"
  return splitCsv(raw)
    .map(n => Number.parseInt(n, 10))
    .filter(n => Number.isFinite(n) && n > 0)
}

export async function runRpcRamp() {
  const steps = parseRampSteps()
  const durationSec = envInt("STEP_DURATION_SEC", envInt("DURATION_SEC", 15))
  const cooldownSec = envInt("COOLDOWN_SEC", 2)

  const results: RampStepResult[] = []

  for (const concurrency of steps) {
    process.env.CONCURRENCY = String(concurrency)
    process.env.DURATION_SEC = String(durationSec)

    try {
      const report = await runRpcLoadgen()
      results.push({ concurrency, durationSec, report })
    } catch (err: any) {
      results.push({
        concurrency,
        durationSec,
        error: { message: String(err?.message ?? err) },
      })
    }

    if (cooldownSec > 0) {
      await sleep(cooldownSec * 1000)
    }
  }

  const best = results
    .slice()
    .filter(r => !r.error)
    .sort((a, b) => (b.report?.okRps ?? 0) - (a.report?.okRps ?? 0))[0]

  const rampReport = {
    kind: "rpc_ramp_summary",
    config: {
      rampConcurrency: steps,
      stepDurationSec: durationSec,
      cooldownSec,
      rpcMethod: process.env.RPC_METHOD ?? "ping",
      rpcPath: process.env.RPC_PATH ?? "/",
      rateLimitRps: Number(process.env.RATE_LIMIT_RPS ?? "0") || 0,
    },
    best: best
      ? {
          concurrency: best.concurrency,
          okRps: best.report?.okRps ?? null,
          latencyMs: best.report?.latencyMs ?? null,
        }
      : null,
    steps: results.map(r => ({
      concurrency: r.concurrency,
      durationSec: r.durationSec,
      error: r.error ?? null,
      rps: r.report?.rps ?? null,
      okRps: r.report?.okRps ?? null,
      latencyMs: r.report?.latencyMs ?? null,
      totals: r.report?.totals ?? null,
      timestamp: r.report?.timestamp ?? null,
      artifacts: r.report?.artifacts ?? null,
    })),
    timestamp: new Date().toISOString(),
  }

  console.log(JSON.stringify(rampReport, null, 2))
}

if (import.meta.main) {
  await runRpcRamp()
}

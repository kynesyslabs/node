import { runTransferLoadgen } from "./transfer_loadgen"

type RampStepResult = {
  concurrency: number
  inflightPerWallet: number
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
  const raw = process.env.RAMP_CONCURRENCY ?? "1,2,4"
  return splitCsv(raw)
    .map(n => Number.parseInt(n, 10))
    .filter(n => Number.isFinite(n) && n > 0)
}

export async function runTransferRamp() {
  const steps = parseRampSteps()
  const durationSec = envInt("STEP_DURATION_SEC", envInt("DURATION_SEC", 15))
  const cooldownSec = envInt("COOLDOWN_SEC", 3)
  const inflightPerWallet = envInt("INFLIGHT_PER_WALLET", 1)

  const results: RampStepResult[] = []

  for (const concurrency of steps) {
    process.env.CONCURRENCY = String(concurrency)
    process.env.DURATION_SEC = String(durationSec)
    process.env.INFLIGHT_PER_WALLET = String(inflightPerWallet)

    try {
      const report = await runTransferLoadgen()
      results.push({ concurrency, inflightPerWallet, durationSec, report })
    } catch (err: any) {
      results.push({
        concurrency,
        inflightPerWallet,
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
    .sort((a, b) => (b.report?.tps ?? 0) - (a.report?.tps ?? 0))[0]

  const rampReport = {
    kind: "transfer_ramp_summary",
    config: {
      rampConcurrency: steps,
      stepDurationSec: durationSec,
      cooldownSec,
      inflightPerWallet,
    },
    best: best
      ? {
          concurrency: best.concurrency,
          inflightPerWallet: best.inflightPerWallet,
          tps: best.report?.tps ?? null,
          latencyMs: best.report?.latencyMs ?? null,
        }
      : null,
    steps: results.map(r => ({
      concurrency: r.concurrency,
      inflightPerWallet: r.inflightPerWallet,
      durationSec: r.durationSec,
      error: r.error ?? null,
      tps: r.report?.tps ?? null,
      latencyMs: r.report?.latencyMs ?? null,
      totals: r.report?.totals ?? null,
      timestamp: r.report?.timestamp ?? null,
    })),
    timestamp: new Date().toISOString(),
  }

  console.log(JSON.stringify(rampReport, null, 2))
}

if (import.meta.main) {
  await runTransferRamp()
}

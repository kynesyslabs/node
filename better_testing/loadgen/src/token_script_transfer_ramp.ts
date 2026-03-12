import { runTokenScriptTransferLoadgen } from "./token_script_transfer_loadgen"
import { getRunConfig, writeJson } from "./framework/io"
import { splitCsv, sleep, envInt, logNonCriticalError } from "./testing_utils"

export async function runTokenScriptTransferRamp() {
  const rampConcurrency = splitCsv(process.env.RAMP_CONCURRENCY)
    .map(s => Number.parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n > 0)

  const rampInflight = splitCsv(process.env.RAMP_INFLIGHT_PER_WALLET)
    .map(s => Number.parseInt(s, 10))
    .filter(n => Number.isFinite(n) && n > 0)

  const mode: "concurrency" | "inflight" = rampInflight.length > 0 ? "inflight" : "concurrency"
  const stepDurationSec = envInt("STEP_DURATION_SEC", 15)
  const cooldownSec = envInt("COOLDOWN_SEC", 3)

  if (mode === "concurrency" && rampConcurrency.length === 0) {
    throw new Error("RAMP_CONCURRENCY must be a comma-separated list of positive ints")
  }
  if (mode === "inflight" && rampInflight.length === 0) {
    throw new Error("RAMP_INFLIGHT_PER_WALLET must be a comma-separated list of positive ints")
  }

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_transfer_ramp`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
  }

  const results: any[] = []
  let reuseTokenAddress: string | null = null

  const fixedConcurrency = envInt("CONCURRENCY", 4)
  const fixedInflight = envInt("INFLIGHT_PER_WALLET", 1)

  const steps =
    mode === "inflight"
      ? rampInflight.map(inflight => ({ concurrency: fixedConcurrency, inflightPerWallet: inflight }))
      : rampConcurrency.map(concurrency => ({ concurrency, inflightPerWallet: fixedInflight }))

  for (const step of steps) {
    process.env.SCENARIO = "token_script_transfer"
    process.env.DURATION_SEC = String(stepDurationSec)
    process.env.CONCURRENCY = String(step.concurrency)
    process.env.INFLIGHT_PER_WALLET = String(step.inflightPerWallet)

    if (reuseTokenAddress) {
      process.env.TOKEN_ADDRESS = reuseTokenAddress
      process.env.TOKEN_BOOTSTRAP = "false"
      process.env.TOKEN_DISTRIBUTE = "false"
      process.env.TOKEN_WAIT_DISTRIBUTION = "false"
      process.env.TOKEN_SCRIPT_UPGRADE = "false"
    } else {
      if (!process.env.TOKEN_BOOTSTRAP) process.env.TOKEN_BOOTSTRAP = "true"
      if (!process.env.TOKEN_SCRIPT_UPGRADE) process.env.TOKEN_SCRIPT_UPGRADE = "true"
    }

    let stepSummary: any = null
    let stepError: any = null

    const originalLog = console.log
    const capture: any[] = []
    console.log = (...args: any[]) => {
      capture.push(args)
      originalLog(...args)
    }

    try {
      await runTokenScriptTransferLoadgen()
      for (const row of capture) {
        const payload = row?.[0]
        if (payload && typeof payload === "string") {
          try {
            const parsed = JSON.parse(payload)
            if (parsed?.token_script_transfer_summary) stepSummary = parsed.token_script_transfer_summary
          } catch (error) {
            logNonCriticalError("token_script_transfer_ramp.captureSummary", error, step)
          }
        } else if (payload?.token_script_transfer_summary) {
          stepSummary = payload.token_script_transfer_summary
        }
      }
      if (!reuseTokenAddress && stepSummary?.tokenAddress) {
        reuseTokenAddress = String(stepSummary.tokenAddress)
      }
    } catch (err: any) {
      stepError = { message: err?.message ?? String(err) }
    } finally {
      console.log = originalLog
    }

    results.push({
      concurrency: step.concurrency,
      inflightPerWallet: step.inflightPerWallet,
      stepDurationSec,
      cooldownSec,
      summary: stepSummary,
      error: stepError,
    })

    if (cooldownSec > 0) await sleep(cooldownSec * 1000)
  }

  const okSteps = results
    .map(r => ({ concurrency: r.concurrency, inflightPerWallet: r.inflightPerWallet, okTps: r.summary?.okTps }))
    .filter(r => typeof r.okTps === "number")

  const best = okSteps.sort((a, b) => (b.okTps ?? 0) - (a.okTps ?? 0))[0] ?? null

  const rampSummary = {
    scenario: "token_script_transfer_ramp",
    mode,
    bestByOkTps: best,
    steps: results,
    config: {
      rampConcurrency: rampConcurrency.length > 0 ? rampConcurrency : null,
      rampInflightPerWallet: rampInflight.length > 0 ? rampInflight : null,
      fixedConcurrency,
      fixedInflightPerWallet: fixedInflight,
      stepDurationSec,
      cooldownSec,
      tokenTransferAmount: process.env.TOKEN_TRANSFER_AMOUNT ?? process.env.AMOUNT ?? "1",
      scriptWorkIters: process.env.SCRIPT_WORK_ITERS ?? "0",
      scriptSetStorage: process.env.SCRIPT_SET_STORAGE ?? "false",
    },
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, rampSummary)
  console.log(JSON.stringify({ token_script_transfer_ramp_summary: rampSummary }, null, 2))
}

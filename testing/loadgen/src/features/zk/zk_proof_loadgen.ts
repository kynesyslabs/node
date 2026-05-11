import { appendJsonl, getRunConfig, writeJson } from "../../framework/io"
import { ReservoirSampler, summarizeLatency } from "../../framework/metrics"
import { envBool, envFloat, envInt, nowMs } from "../../framework/common"
import { startProgressReporter } from "../../framework/progress"
import { maybeSilenceConsole } from "../../token_shared"
import { buildUniqueHex64, getHealthyZkTargets, getZkTargets, INVALID_GROTH16_PROOF, verifyProofRpc } from "./shared"

type Counters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  error: number
}

type WorkerReport = {
  workerId: number
  target: string
  ok: number
  error: number
}

type ErrorSample = {
  at: string
  workerId: number
  target: string
  error: string
}

async function worker(params: {
  workerId: number
  target: string
  stopAtMs: number
  rootHash: string
  context: string
  counters: Counters
  sampler: ReservoirSampler
  errors: ErrorSample[]
  errorSampleLimit: number
  sharedStop: { value: boolean }
}) {
  let ok = 0
  let error = 0
  while (nowMs() < params.stopAtMs && !params.sharedStop.value) {
    const startedAt = performance.now()
    params.counters.total++
    const publicSignals = [
      buildUniqueHex64(`proof${params.workerId}`),
      params.rootHash,
      params.context,
    ]

    try {
      const result = await verifyProofRpc(params.target, INVALID_GROTH16_PROOF, publicSignals)
      const latencyMs = Number((performance.now() - startedAt).toFixed(1))
      params.sampler.add(latencyMs)
      if (result.json?.result === 400 && result.json?.response?.valid === false) {
        params.counters.ok++
        ok++
      } else {
        params.counters.error++
        error++
        const message = JSON.stringify(result.json ?? { status: result.status })
        if (params.errors.length < params.errorSampleLimit) {
          params.errors.push({
            at: new Date().toISOString(),
            workerId: params.workerId,
            target: params.target,
            error: message,
          })
        }
        if (/rate limit|too many|max requests|ip blocked/i.test(message)) {
          params.sharedStop.value = true
        }
      }
    } catch (err) {
      const latencyMs = Number((performance.now() - startedAt).toFixed(1))
      params.sampler.add(latencyMs)
      params.counters.error++
      error++
      const message = err instanceof Error ? err.message : String(err)
      if (params.errors.length < params.errorSampleLimit) {
        params.errors.push({
          at: new Date().toISOString(),
          workerId: params.workerId,
          target: params.target,
          error: message,
        })
      }
      if (/rate limit|too many|max requests|ip blocked/i.test(message)) {
        params.sharedStop.value = true
      }
    }
  }

  return {
    workerId: params.workerId,
    target: params.target,
    ok,
    error,
  } satisfies WorkerReport
}

export async function runZkProofLoadgen() {
  maybeSilenceConsole()

  const rpcUrls = getZkTargets()
  if (rpcUrls.length === 0) throw new Error("zk_proof_loadgen requires at least one RPC target")

  const health = await getHealthyZkTargets(rpcUrls)
  const run = getRunConfig()
  if (health.healthyRpcUrls.length === 0) {
    const summary = {
      scenario: "zk_proof_loadgen",
      ok: true,
      skipped: true,
      skipReason: "no healthy ZK RPC targets available",
      rpcUrls,
      probes: health.probes,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/zk/zk_proof_loadgen.summary.json`, summary)
    console.log(JSON.stringify({ zk_proof_loadgen_summary: summary }, null, 2))
    return
  }

  const durationSec = Math.max(1, envInt("DURATION_SEC", 5))
  const concurrency = Math.max(1, envInt("CONCURRENCY", 2))
  const maxErrorRate = Math.max(0, envFloat("MAX_ERROR_RATE", 0.05))
  const emitTimeseries = envBool("EMIT_TIMESERIES", true)
  const timeseriesIntervalMs = Math.max(250, envInt("TIMESERIES_INTERVAL_MS", 1000))
  const errorSampleLimit = Math.max(1, envInt("ERROR_SAMPLE_LIMIT", 20))
  const rootHash = health.probes.find(probe => probe.rpcUrl === health.healthyRpcUrls[0])?.merkleRoot?.rootHash ?? "0"
  const context = process.env.ZK_CONTEXT ?? "loadgen"
  const counters: Counters = {
    startedAtMs: nowMs(),
    endedAtMs: 0,
    total: 0,
    ok: 0,
    error: 0,
  }
  const sampler = new ReservoirSampler(Math.max(100, envInt("SAMPLE_LIMIT", 5000)))
  const errors: ErrorSample[] = []
  const sharedStop = { value: false }
  const stopAtMs = nowMs() + durationSec * 1000
  const workerTargets = Array.from(
    { length: concurrency },
    (_, index) => health.healthyRpcUrls[index % health.healthyRpcUrls.length]!,
  )
  const timeseriesPath = `${run.runDir}/features/zk/zk_proof_loadgen.timeseries.jsonl`
  const stopProgress = startProgressReporter({
    label: "zk_proof_loadgen",
    getSnapshot: () => ({
      startedAtMs: counters.startedAtMs,
      total: counters.total,
      ok: counters.ok,
      error: counters.error,
      stopTriggered: sharedStop.value,
    }),
  })

  const reporter = emitTimeseries ? setInterval(() => {
    const elapsedSec = Math.max(0.001, (nowMs() - counters.startedAtMs) / 1000)
    appendJsonl(timeseriesPath, {
      tSec: Number(elapsedSec.toFixed(3)),
      ok: counters.ok,
      total: counters.total,
      error: counters.error,
      tps: Number((counters.total / elapsedSec).toFixed(3)),
      okTps: Number((counters.ok / elapsedSec).toFixed(3)),
      latencyMs: summarizeLatency(sampler.snapshotSorted()),
      timestamp: new Date().toISOString(),
    })
  }, timeseriesIntervalMs) : null

  try {
    const workerReports = await Promise.all(
      workerTargets.map((target, index) =>
        worker({
          workerId: index + 1,
          target,
          stopAtMs,
          rootHash,
          context,
          counters,
          sampler,
          errors,
          errorSampleLimit,
          sharedStop,
        })),
    )

    counters.endedAtMs = nowMs()
    const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
    const errorRate = counters.total > 0 ? counters.error / counters.total : 0
    const summary = {
      scenario: "zk_proof_loadgen",
      ok: counters.total > 0 && errorRate <= maxErrorRate && !sharedStop.value,
      skipped: false,
      rpcUrls,
      healthyRpcUrls: health.healthyRpcUrls,
      unhealthyRpcUrls: health.unhealthyRpcUrls,
      probes: health.probes,
      durationSec,
      concurrency,
      maxErrorRate,
      rootHash,
      context,
      counters,
      errorRate: Number(errorRate.toFixed(4)),
      throughput: {
        tps: Number((counters.total / elapsedSec).toFixed(3)),
        okTps: Number((counters.ok / elapsedSec).toFixed(3)),
      },
      latencyMs: summarizeLatency(sampler.snapshotSorted()),
      workerReports,
      errorSamples: errors,
      timeseriesPath: emitTimeseries ? timeseriesPath : null,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/zk/zk_proof_loadgen.summary.json`, summary)
    console.log(JSON.stringify({ zk_proof_loadgen_summary: summary }, null, 2))

    if (!summary.ok) {
      throw new Error(`zk_proof_loadgen failed: errorRate=${summary.errorRate} stopTriggered=${sharedStop.value}`)
    }
  } finally {
    stopProgress()
    if (reporter) clearInterval(reporter)
  }
}

if (import.meta.main) {
  await runZkProofLoadgen()
}

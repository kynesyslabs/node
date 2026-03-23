import { appendJsonl, getRunConfig, writeJson } from "../../framework/io"
import { ReservoirSampler, summarizeLatency } from "../../framework/metrics"
import { envBool, envFloat, envInt, nowMs, sleep } from "../../framework/common"
import { startProgressReporter } from "../../framework/progress"
import { maybeSilenceConsole } from "../../token_shared"
import { PeerConnection } from "src/libs/omniprotocol/transport/PeerConnection"
import { OmniOpcode } from "src/libs/omniprotocol/protocol/opcodes"
import { decodePeerlistResponse } from "src/libs/omniprotocol/serialization/control"
import { getOmniTargets } from "./shared"

type ThroughputCounters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  error: number
}

type ThroughputSample = {
  at: string
  workerId: number
  target: string
  error: string
}

type ThroughputWorkerReport = {
  workerId: number
  target: string
  ok: number
  error: number
}

function buildTargets(targets: string[], concurrency: number): string[] {
  return Array.from({ length: Math.max(1, concurrency) }, (_, index) => targets[index % targets.length]!)
}

async function worker(params: {
  workerId: number
  target: string
  stopAtMs: number
  connectTimeoutMs: number
  requestTimeoutMs: number
  minPeers: number
  minLoopDelayMs: number
  counters: ThroughputCounters
  sampler: ReservoirSampler
  sharedStop: { value: boolean }
  errorSamples: ThroughputSample[]
  errorSampleLimit: number
}): Promise<ThroughputWorkerReport> {
  const connection = new PeerConnection(`loadgen:${params.target}:worker:${params.workerId}`, params.target)
  let ok = 0
  let error = 0
  try {
    await connection.connect({ timeout: params.connectTimeoutMs })
    while (nowMs() < params.stopAtMs && !params.sharedStop.value) {
      const startedAt = performance.now()
      params.counters.total++
      try {
        const response = await connection.send(OmniOpcode.GET_PEERLIST, Buffer.alloc(0), { timeout: params.requestTimeoutMs })
        const decoded = decodePeerlistResponse(response)
        if (decoded.status !== 200 || decoded.peers.length < params.minPeers) {
          throw new Error(`unexpected peerlist response status=${decoded.status} peers=${decoded.peers.length}`)
        }
        const latencyMs = Number((performance.now() - startedAt).toFixed(1))
        params.sampler.add(latencyMs)
        params.counters.ok++
        ok++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        params.counters.error++
        error++
        if (params.errorSamples.length < params.errorSampleLimit) {
          params.errorSamples.push({
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

      if (params.minLoopDelayMs > 0) {
        await sleep(params.minLoopDelayMs)
      }
    }
  } finally {
    await connection.close().catch(() => {})
  }

  return {
    workerId: params.workerId,
    target: params.target,
    ok,
    error,
  }
}

export async function runOmniThroughput() {
  maybeSilenceConsole()

  const targets = getOmniTargets()
  if (targets.length === 0) throw new Error("omni_throughput requires at least one Omni target")

  const durationSec = Math.max(1, envInt("DURATION_SEC", 5))
  const concurrency = Math.max(1, envInt("CONCURRENCY", 2))
  const connectTimeoutMs = envInt("OMNI_CONNECT_TIMEOUT_MS", 5000)
  const requestTimeoutMs = envInt("OMNI_REQUEST_TIMEOUT_MS", 5000)
  const minPeers = Math.max(1, envInt("OMNI_MIN_PEERS", 1))
  const minLoopDelayMs = Math.max(0, envInt("MIN_LOOP_DELAY_MS", 25))
  const maxErrorRate = Math.max(0, envFloat("MAX_ERROR_RATE", 0.05))
  const emitTimeseries = envBool("EMIT_TIMESERIES", true)
  const timeseriesIntervalMs = Math.max(250, envInt("TIMESERIES_INTERVAL_MS", 1000))
  const errorSampleLimit = Math.max(1, envInt("ERROR_SAMPLE_LIMIT", 20))
  const latencySampler = new ReservoirSampler(Math.max(100, envInt("SAMPLE_LIMIT", 5000)))
  const workerTargets = buildTargets(targets, concurrency)
  const stopAtMs = nowMs() + durationSec * 1000
  const counters: ThroughputCounters = {
    startedAtMs: nowMs(),
    endedAtMs: 0,
    total: 0,
    ok: 0,
    error: 0,
  }
  const sharedStop = { value: false }
  const errorSamples: ThroughputSample[] = []
  const run = getRunConfig()
  const timeseriesPath = `${run.runDir}/features/omni/omni_throughput.timeseries.jsonl`
  const stopProgress = startProgressReporter({
    label: "omni_throughput",
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
      timestamp: new Date().toISOString(),
      latencyMs: summarizeLatency(latencySampler.snapshotSorted()),
    })
  }, timeseriesIntervalMs) : null

  try {
    const reports = await Promise.all(workerTargets.map((target, index) => worker({
      workerId: index + 1,
      target,
      stopAtMs,
      connectTimeoutMs,
      requestTimeoutMs,
      minPeers,
      minLoopDelayMs,
      counters,
      sampler: latencySampler,
      sharedStop,
      errorSamples,
      errorSampleLimit,
    })))

    counters.endedAtMs = nowMs()
    const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
    const errorRate = counters.total > 0 ? counters.error / counters.total : 0
    const summary = {
      scenario: "omni_throughput",
      ok: counters.total > 0 && errorRate <= maxErrorRate && !sharedStop.value,
      durationSec,
      concurrency,
      connectTimeoutMs,
      requestTimeoutMs,
      minPeers,
      minLoopDelayMs,
      maxErrorRate,
      workerTargets,
      elapsedSec: Number(elapsedSec.toFixed(3)),
      counters,
      errorRate: Number(errorRate.toFixed(4)),
      throughput: {
        tps: Number((counters.total / elapsedSec).toFixed(3)),
        okTps: Number((counters.ok / elapsedSec).toFixed(3)),
      },
      latencyMs: summarizeLatency(latencySampler.snapshotSorted()),
      workerReports: reports,
      errorSamples,
      timeseriesPath: emitTimeseries ? timeseriesPath : null,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/omni/omni_throughput.summary.json`, summary)
    console.log(JSON.stringify({ omni_throughput_summary: summary }, null, 2))

    if (!summary.ok) {
      throw new Error(`omni_throughput failed: errorRate=${summary.errorRate} stopTriggered=${sharedStop.value}`)
    }
  } finally {
    stopProgress()
    if (reporter) clearInterval(reporter)
  }
}

if (import.meta.main) {
  await runOmniThroughput()
}

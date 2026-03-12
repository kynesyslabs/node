import { ReservoirSampler, summarizeLatency } from "../../framework/metrics"
import { appendJsonl, getRunConfig, writeJson } from "../../framework/io"
import { envBool, envFloat, envInt, nowMs, sleep } from "../../framework/common"
import { startProgressReporter } from "../../framework/progress"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import { maybeSilenceConsole } from "../../token_shared"
import { getClusterObservation, getPeerSyncTargets, waitForClusterConvergence, waitForPeerSyncTargets } from "./shared"

type LoadCounters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  error: number
}

type ErrorSample = {
  at: string
  workerId: number
  target: string
  error: string
}

type WorkerReport = {
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
  minPeers: number
  minLoopDelayMs: number
  counters: LoadCounters
  sampler: ReservoirSampler
  sharedStop: { value: boolean }
  errorSamples: ErrorSample[]
  errorSampleLimit: number
}) {
  let ok = 0
  let error = 0
  while (nowMs() < params.stopAtMs && !params.sharedStop.value) {
    const startedAt = performance.now()
    params.counters.total++
    try {
      const [numberRes, hashRes, peerRes] = await Promise.all([
        nodeCall(params.target, "getLastBlockNumber", {}, `peersync:load:number:${params.workerId}`, NO_FALLBACKS),
        nodeCall(params.target, "getLastBlockHash", {}, `peersync:load:hash:${params.workerId}`, NO_FALLBACKS),
        nodeCall(params.target, "getPeerlist", {}, `peersync:load:peerlist:${params.workerId}`, NO_FALLBACKS),
      ])
      const peerCount = Array.isArray(peerRes?.response) ? peerRes.response.length : 0
      if (numberRes?.result !== 200 || hashRes?.result !== 200 || peerRes?.result !== 200 || peerCount < params.minPeers) {
        throw new Error(`unexpected response number=${numberRes?.result} hash=${hashRes?.result} peerlist=${peerRes?.result} peers=${peerCount}`)
      }
      params.sampler.add(Number((performance.now() - startedAt).toFixed(1)))
      params.counters.ok++
      ok++
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue)
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
    if (params.minLoopDelayMs > 0) await sleep(params.minLoopDelayMs)
  }

  return {
    workerId: params.workerId,
    target: params.target,
    ok,
    error,
  } satisfies WorkerReport
}

export async function runSyncUnderLoad() {
  maybeSilenceConsole()

  const rpcUrls = getPeerSyncTargets()
  if (rpcUrls.length === 0) throw new Error("sync_under_load requires at least one RPC target")
  await waitForPeerSyncTargets(rpcUrls, false)

  const initial = await getClusterObservation(rpcUrls)
  if (initial.healthyNodeCount < 2) {
    throw new Error("sync_under_load requires at least 2 healthy RPC targets")
  }

  const durationSec = Math.max(1, envInt("DURATION_SEC", 8))
  const concurrency = Math.max(1, envInt("CONCURRENCY", initial.healthyNodeCount))
  const minLoopDelayMs = Math.max(0, envInt("MIN_LOOP_DELAY_MS", 25))
  const maxErrorRate = Math.max(0, envFloat("MAX_ERROR_RATE", 0.05))
  const timeseriesIntervalMs = Math.max(250, envInt("TIMESERIES_INTERVAL_MS", 1000))
  const emitTimeseries = envBool("EMIT_TIMESERIES", true)
  const errorSampleLimit = Math.max(1, envInt("ERROR_SAMPLE_LIMIT", 20))
  const minPeers = Math.max(1, envInt("PEER_DISCOVERY_MIN_PEERS", initial.healthyNodeCount))
  const workerTargets = buildTargets(initial.healthyRpcUrls, concurrency)
  const stopAtMs = nowMs() + durationSec * 1000
  const counters: LoadCounters = { startedAtMs: nowMs(), endedAtMs: 0, total: 0, ok: 0, error: 0 }
  const sampler = new ReservoirSampler(Math.max(100, envInt("SAMPLE_LIMIT", 5000)))
  const sharedStop = { value: false }
  const errorSamples: ErrorSample[] = []
  const run = getRunConfig()
  const timeseriesPath = `${run.runDir}/features/peersync/sync_under_load.timeseries.jsonl`
  const stopProgress = startProgressReporter({
    label: "sync_under_load",
    getSnapshot: () => ({
      startedAtMs: counters.startedAtMs,
      total: counters.total,
      ok: counters.ok,
      error: counters.error,
      stopTriggered: sharedStop.value,
    }),
  })

  const reporter = emitTimeseries ? setInterval(async () => {
    const observation = await getClusterObservation(initial.healthyRpcUrls).catch(() => null)
    const elapsedSec = Math.max(0.001, (nowMs() - counters.startedAtMs) / 1000)
    appendJsonl(timeseriesPath, {
      tSec: Number(elapsedSec.toFixed(3)),
      total: counters.total,
      ok: counters.ok,
      error: counters.error,
      tps: Number((counters.total / elapsedSec).toFixed(3)),
      okTps: Number((counters.ok / elapsedSec).toFixed(3)),
      latencyMs: summarizeLatency(sampler.snapshotSorted()),
      converged: observation?.converged ?? null,
      healthyNodeCount: observation?.healthyNodeCount ?? null,
      minBlockNumber: observation?.minBlockNumber ?? null,
      maxBlockNumber: observation?.maxBlockNumber ?? null,
      timestamp: new Date().toISOString(),
    })
  }, timeseriesIntervalMs) : null

  try {
    const workerReports = await Promise.all(workerTargets.map((target, index) => worker({
      workerId: index + 1,
      target,
      stopAtMs,
      minPeers,
      minLoopDelayMs,
      counters,
      sampler,
      sharedStop,
      errorSamples,
      errorSampleLimit,
    })))
    counters.endedAtMs = nowMs()

    const convergence = await waitForClusterConvergence({
      rpcUrls: initial.healthyRpcUrls,
      timeoutSec: Math.max(15, envInt("SYNC_RECOVERY_TIMEOUT_SEC", 30)),
      pollMs: envInt("CONSENSUS_POLL_MS", 1000),
      stableRoundsRequired: Math.max(2, envInt("SYNC_STABLE_ROUNDS", 3)),
      minBlockAdvance: Math.max(1, envInt("SYNC_REQUIRED_BLOCK_DELTA", 1)),
      requirePeerDiscovery: true,
    })
    const finalObservation = convergence.observations[convergence.observations.length - 1]!
    const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
    const errorRate = counters.total > 0 ? counters.error / counters.total : 1
    const ok = counters.total > 0 && errorRate <= maxErrorRate && !sharedStop.value && convergence.ok
    const summary = {
      scenario: "sync_under_load",
      ok,
      durationSec,
      concurrency,
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
      initial,
      convergence,
      finalObservation,
      latencyMs: summarizeLatency(sampler.snapshotSorted()),
      workerReports,
      errorSamples,
      timeseriesPath: emitTimeseries ? timeseriesPath : null,
      timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/peersync/sync_under_load.summary.json`, summary)
    console.log(JSON.stringify({ sync_under_load_summary: summary }, null, 2))

    if (!ok) {
      throw new Error(`sync_under_load failed: errorRate=${summary.errorRate} stopTriggered=${sharedStop.value} converged=${convergence.ok}`)
    }
  } finally {
    stopProgress()
    if (reporter) clearInterval(reporter)
  }
}

if (import.meta.main) {
  await runSyncUnderLoad()
}

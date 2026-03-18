import { appendJsonl, getRunConfig, writeJson } from "./framework/io"
import { type Counters, ReservoirSampler, summarizeLatency } from "./framework/metrics"
import { envBool, envFloat, envInt, nowMs, sleep, splitCsv } from "./framework/common"
import { HttpStatusError, NetworkError, RpcRequestError, normalizeLoadgenError } from "./framework/errors"
import { startProgressReporter } from "./framework/progress"

type LoadgenConfig = {
  targets: string[]
  rpcPath: string
  rpcMethod: string
  durationSec: number
  concurrency: number
  rateLimitRps: number
  sampleLimit: number
  emitTimeseries: boolean
  waitForRpcSec: number
}

type RpcCounters = Counters & {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  httpError: number
  rpcError: number
  networkError: number
  errorSamples: Record<string, number>
}

type TimeseriesPoint = {
  tSec: number
  ok: number
  total: number
  httpError: number
  rpcError: number
  networkError: number
  rps: number
  okRps: number
  latencyMs: ReturnType<typeof summarizeLatency>
  timestamp: string
}

function getConfig(): LoadgenConfig {
  return {
    targets: splitCsv(process.env.TARGETS ?? "http://localhost:53551"),
    rpcPath: process.env.RPC_PATH ?? "/",
    rpcMethod: process.env.RPC_METHOD ?? "ping",
    durationSec: envInt("DURATION_SEC", 15),
    concurrency: envInt("CONCURRENCY", 20),
    rateLimitRps: envFloat("RATE_LIMIT_RPS", 0),
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
    waitForRpcSec: envInt("WAIT_FOR_RPC_SEC", 60),
  }
}

async function isRpcReady(baseUrl: string, rpcPath: string): Promise<boolean> {
  const url = baseUrl.replace(/\/+$/, "") + rpcPath
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "ping", params: [] }),
    })
    if (!res.ok) return false
    const data = (await res.json().catch(() => null)) as any
    return typeof data?.result === "number" && data.result >= 200 && data.result < 300
  } catch {
    return false
  }
}

async function waitForRpcReady(baseUrl: string, rpcPath: string, timeoutSec: number) {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  while (nowMs() < deadlineMs) {
    if (await isRpcReady(baseUrl, rpcPath)) return
    attempt++
    await sleep(Math.min(2000, 100 + attempt * 100))
  }
  throw new Error(`RPC not ready at ${baseUrl}${rpcPath} after ${timeoutSec}s`)
}

async function rpcCall(baseUrl: string, rpcPath: string, method: string) {
  const url = baseUrl.replace(/\/+$/, "") + rpcPath
  const body = JSON.stringify({ method, params: [] })

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })

  if (!res.ok) {
    return { ok: false as const, kind: "http" as const, error: new HttpStatusError(url, res.status) }
  }

  const data = (await res.json()) as any
  if (typeof data?.result === "number" && data.result >= 200 && data.result < 300) {
    return { ok: true as const }
  }

  return {
    ok: false as const,
    kind: "rpc" as const,
    error: new RpcRequestError(`RPC call returned non-2xx result for ${method} at ${url}`, { url, method, data }),
  }
}

function createRateLimiter(rateLimitRps: number) {
  if (!rateLimitRps || rateLimitRps <= 0) {
    return async () => {}
  }

  const intervalMs = 1000 / rateLimitRps
  let nextAllowed = nowMs()

  return async () => {
    const current = nowMs()
    if (current < nextAllowed) {
      await sleep(nextAllowed - current)
    }
    nextAllowed = Math.max(nextAllowed + intervalMs, nowMs())
  }
}

async function worker(
  config: LoadgenConfig,
  counters: RpcCounters,
  sampler: ReservoirSampler,
  timeseriesSampler: ReservoirSampler,
  stopAtMs: number,
  workerId: number,
) {
  const waitForSlot = createRateLimiter(config.rateLimitRps)
  let iteration = 0

  while (nowMs() < stopAtMs) {
    await waitForSlot()
    const target = config.targets[(workerId + iteration) % config.targets.length]!
    iteration++

    const start = performance.now()
    counters.total++
    try {
      const result = await rpcCall(target, config.rpcPath, config.rpcMethod)
      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)

      if (result.ok) counters.ok++
      else if (result.kind === "http") {
        counters.httpError++
        const info = normalizeLoadgenError(result.error)
        const key = `${info.code}:${info.message}`.slice(0, 400)
        counters.errorSamples[key] = (counters.errorSamples[key] ?? 0) + 1
      } else {
        counters.rpcError++
        const info = normalizeLoadgenError(result.error)
        const key = `${info.code}:${info.message}`.slice(0, 400)
        counters.errorSamples[key] = (counters.errorSamples[key] ?? 0) + 1
      }
    } catch (error) {
      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)
      counters.networkError++
      const info = normalizeLoadgenError(new NetworkError(error instanceof Error ? error.message : String(error), {
        target,
        method: config.rpcMethod,
      }))
      const key = `${info.code}:${info.message}`.slice(0, 400)
      counters.errorSamples[key] = (counters.errorSamples[key] ?? 0) + 1
    }
  }
}

async function main() {
  const config = getConfig()
  const startedAtMs = nowMs()
  const stopAtMs = startedAtMs + config.durationSec * 1000

  const counters: RpcCounters = {
    startedAtMs,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    httpError: 0,
    rpcError: 0,
    networkError: 0,
    errorSamples: {},
  }

  const sampler = new ReservoirSampler(config.sampleLimit)
  const timeseriesSampler = new ReservoirSampler(50_000)
  const stopProgress = startProgressReporter({
    label: "rpc_loadgen",
    getSnapshot: () => ({
      startedAtMs: counters.startedAtMs,
      total: counters.total,
      ok: counters.ok,
      httpError: counters.httpError,
      rpcError: counters.rpcError,
      networkError: counters.networkError,
    }),
  })

  try {
    await Promise.all(config.targets.map(target => waitForRpcReady(target, config.rpcPath, config.waitForRpcSec)))

    const run = getRunConfig()
    const artifactBase = `${run.runDir}/rpc`
    const artifacts = {
      runId: run.runId,
      runDir: run.runDir,
      summaryPath: `${artifactBase}.summary.json`,
      timeseriesPath: `${artifactBase}.timeseries.jsonl`,
    }

    let lastPointAtMs = startedAtMs
    let lastOk = 0
    let lastTotal = 0
    let lastHttp = 0
    let lastRpc = 0
    let lastNet = 0

    async function timeseriesLoop() {
      if (!config.emitTimeseries) return
      while (nowMs() < stopAtMs) {
        await sleep(1000)
        const now = nowMs()
        const elapsedSinceLast = Math.max(0.001, (now - lastPointAtMs) / 1000)
        lastPointAtMs = now

        const okDelta = counters.ok - lastOk
        const totalDelta = counters.total - lastTotal
        const httpDelta = counters.httpError - lastHttp
        const rpcDelta = counters.rpcError - lastRpc
        const netDelta = counters.networkError - lastNet

        lastOk = counters.ok
        lastTotal = counters.total
        lastHttp = counters.httpError
        lastRpc = counters.rpcError
        lastNet = counters.networkError

        const point: TimeseriesPoint = {
          tSec: (now - startedAtMs) / 1000,
          ok: okDelta,
          total: totalDelta,
          httpError: httpDelta,
          rpcError: rpcDelta,
          networkError: netDelta,
          rps: totalDelta / elapsedSinceLast,
          okRps: okDelta / elapsedSinceLast,
          latencyMs: summarizeLatency(timeseriesSampler.snapshotSorted()),
          timestamp: new Date().toISOString(),
        }
        appendJsonl(artifacts.timeseriesPath, point)
      }
    }

    const workers = Array.from({ length: config.concurrency }, (_, index) =>
      worker(config, counters, sampler, timeseriesSampler, stopAtMs, index),
    )

    await Promise.all([...workers, timeseriesLoop()])
    counters.endedAtMs = nowMs()

    const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
    const report = {
      kind: "rpc_loadgen_summary",
      config,
      elapsedSec,
      totals: counters,
      rps: counters.total / elapsedSec,
      okRps: counters.ok / elapsedSec,
      latencyMs: summarizeLatency(sampler.snapshotSorted()),
      errorSamples: counters.errorSamples,
      timestamp: new Date().toISOString(),
      artifacts,
    }

    console.log(JSON.stringify(report, null, 2))
    writeJson(artifacts.summaryPath, report)
    return report
  } finally {
    stopProgress()
  }
}

export async function runRpcLoadgen() {
  return await main()
}

if (import.meta.main) {
  await runRpcLoadgen()
}

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

type Counters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  httpError: number
  rpcError: number
  networkError: number
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
  latencyMs: { sampleCount: number; p50: number; p95: number; p99: number }
  timestamp: string
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true
    case "0":
    case "false":
    case "no":
    case "n":
    case "off":
      return false
    default:
      return fallback
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

function getConfig(): LoadgenConfig {
  const targets = (process.env.TARGETS ?? "http://localhost:53551")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)

  return {
    targets,
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

function nowMs(): number {
  return Date.now()
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * (sorted.length - 1))),
  )
  return sorted[idx]!
}

class ReservoirSampler {
  private seen = 0
  private readonly max: number
  private readonly samples: number[] = []

  constructor(maxSamples: number) {
    this.max = Math.max(1, Math.floor(maxSamples))
  }

  add(value: number) {
    this.seen++
    if (this.samples.length < this.max) {
      this.samples.push(value)
      return
    }
    const j = Math.floor(Math.random() * this.seen)
    if (j < this.max) this.samples[j] = value
  }

  snapshotSorted(): number[] {
    const copy = this.samples.slice()
    copy.sort((a, b) => a - b)
    return copy
  }

  size(): number {
    return this.samples.length
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
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
    return { ok: false as const, kind: "http" as const, status: res.status }
  }

  const data = (await res.json()) as any
  // Expected: { result: number, response: any, ... }
  if (typeof data?.result === "number" && data.result >= 200 && data.result < 300) {
    return { ok: true as const }
  }

  return { ok: false as const, kind: "rpc" as const }
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
      await new Promise(r => setTimeout(r, nextAllowed - current))
    }
    nextAllowed = Math.max(nextAllowed + intervalMs, nowMs())
  }
}

async function worker(
  config: LoadgenConfig,
  counters: Counters,
  sampler: ReservoirSampler,
  timeseriesSampler: ReservoirSampler,
  stopAtMs: number,
  workerId: number,
) {
  const waitForSlot = createRateLimiter(config.rateLimitRps)
  let i = 0

  while (nowMs() < stopAtMs) {
    await waitForSlot()
    const target = config.targets[(workerId + i) % config.targets.length]!
    i++

    const start = performance.now()
    counters.total++
    try {
      const result = await rpcCall(target, config.rpcPath, config.rpcMethod)
      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)

      if (result.ok) {
        counters.ok++
      } else if (result.kind === "http") {
        counters.httpError++
      } else {
        counters.rpcError++
      }
    } catch {
      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)
      counters.networkError++
    }
  }
}

async function main() {
  const config = getConfig()
  const startedAtMs = nowMs()
  const stopAtMs = startedAtMs + config.durationSec * 1000

  const counters: Counters = {
    startedAtMs,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    httpError: 0,
    rpcError: 0,
    networkError: 0,
  }

  const sampler = new ReservoirSampler(config.sampleLimit)
  const timeseriesSampler = new ReservoirSampler(50_000)

  // Avoid ramp skew from early-start transient errors.
  await Promise.all(
    config.targets.map(t => waitForRpcReady(t, config.rpcPath, config.waitForRpcSec)),
  )

  const { getRunConfig, appendJsonl, writeJson } = await import("./run_io")
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

      const samples = timeseriesSampler.snapshotSorted()
      const point: TimeseriesPoint = {
        tSec: (now - startedAtMs) / 1000,
        ok: okDelta,
        total: totalDelta,
        httpError: httpDelta,
        rpcError: rpcDelta,
        networkError: netDelta,
        rps: totalDelta / elapsedSinceLast,
        okRps: okDelta / elapsedSinceLast,
        latencyMs: {
          sampleCount: timeseriesSampler.size(),
          p50: percentile(samples, 50),
          p95: percentile(samples, 95),
          p99: percentile(samples, 99),
        },
        timestamp: new Date().toISOString(),
      }
      appendJsonl(artifacts.timeseriesPath, point)
    }
  }

  const workers = Array.from({ length: config.concurrency }, (_, idx) =>
    worker(config, counters, sampler, timeseriesSampler, stopAtMs, idx),
  )

  await Promise.all([...workers, timeseriesLoop()])
  counters.endedAtMs = nowMs()

  const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
  const rps = counters.total / elapsedSec
  const okRps = counters.ok / elapsedSec

  const samples = sampler.snapshotSorted()
  const report = {
    kind: "rpc_loadgen_summary",
    config,
    elapsedSec,
    totals: counters,
    rps,
    okRps,
    latencyMs: {
      sampleCount: sampler.size(),
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
    },
    timestamp: new Date().toISOString(),
    artifacts,
  }

  console.log(JSON.stringify(report, null, 2))
  writeJson(artifacts.summaryPath, report)
  return report
}

export async function runRpcLoadgen() {
  return await main()
}

if (import.meta.main) {
  await runRpcLoadgen()
}

type LoadgenConfig = {
  targets: string[]
  rpcPath: string
  rpcMethod: string
  durationSec: number
  concurrency: number
  rateLimitRps: number
  sampleLimit: number
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

  const workers = Array.from({ length: config.concurrency }, (_, idx) =>
    worker(config, counters, sampler, stopAtMs, idx),
  )

  await Promise.all(workers)
  counters.endedAtMs = nowMs()

  const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
  const rps = counters.total / elapsedSec

  const samples = sampler.snapshotSorted()
  const report = {
    kind: "rpc_loadgen_summary",
    config,
    elapsedSec,
    totals: counters,
    rps,
    latencyMs: {
      sampleCount: sampler.size(),
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
    },
    timestamp: new Date().toISOString(),
  }

  console.log(JSON.stringify(report, null, 2))
}

export async function runRpcLoadgen() {
  await main()
}

if (import.meta.main) {
  await runRpcLoadgen()
}

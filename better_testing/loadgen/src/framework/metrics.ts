export type Counters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  httpError: number
  rpcError: number
  networkError: number
}

export class ReservoirSampler {
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
    const index = Math.floor(Math.random() * this.seen)
    if (index < this.max) this.samples[index] = value
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

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))))
  return sorted[index]!
}

export function summarizeLatency(samples: number[]) {
  return {
    sampleCount: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  }
}

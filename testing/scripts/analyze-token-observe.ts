#!/usr/bin/env bun
import { readFileSync } from "node:fs"

type Point = {
  ticks?: number
  timestamp?: string
  crossNode?: {
    stateHashes?: Record<string, string | null>
    hookCountsHashes?: Record<string, string | null>
    mempoolCounts?: Record<string, number | null>
    blockNumbers?: Record<string, number | null>
    blockHashes?: Record<string, string | null>
  }
}

function usage(): never {
  // eslint-disable-next-line no-console
  console.error(
    [
      "Usage:",
      "  analyze-token-observe.ts <token_observe.timeseries.jsonl> [--tail <n>]",
      "",
      "Checks:",
      "  - For any tick where hashes are non-null, they never diverge across nodes.",
      "  - The last N ticks converge (all nodes return non-null hashes and match).",
    ].join("\n"),
  )
  process.exit(2)
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  if (args.length === 0) usage()
  const path = args[0]
  if (!path || path.startsWith("-")) usage()
  let tail = 5
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === "--tail") {
      const v = Number.parseInt(args[i + 1] ?? "", 10)
      if (!Number.isFinite(v) || v <= 0) usage()
      tail = v
      i++
      continue
    }
    usage()
  }
  return { path, tail }
}

function nonNull<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined
}

function allEqual(values: string[]): boolean {
  if (values.length <= 1) return true
  const first = values[0]!
  return values.every(v => v === first)
}

function assertNoDivergence(points: Point[], field: "stateHashes" | "hookCountsHashes") {
  const divergences: Array<{ tick: number; timestamp?: string; values: Record<string, string | null> }> = []
  let nonNullTicks = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i] ?? {}
    const values = (p.crossNode?.[field] ?? {}) as Record<string, string | null>
    const nonNullValues = Object.values(values).filter(nonNull)
    if (nonNullValues.length > 0) nonNullTicks++
    const uniq = Array.from(new Set(nonNullValues))
    if (uniq.length > 1) {
      divergences.push({ tick: p.ticks ?? i + 1, timestamp: p.timestamp, values })
      if (divergences.length >= 3) break
    }
  }
  return { divergences, nonNullTicks }
}

function assertTailConverges(points: Point[], tail: number, field: "stateHashes" | "hookCountsHashes") {
  if (points.length === 0) return { ok: false, reason: "no points" }
  const slice = points.slice(Math.max(0, points.length - tail))
  for (const p of slice) {
    const values = (p.crossNode?.[field] ?? {}) as Record<string, string | null>
    const entries = Object.entries(values)
    if (entries.length === 0) return { ok: false, reason: `${field}: missing per-node map` }
    const nonNullValues = entries.map(([, v]) => v).filter(nonNull)
    if (nonNullValues.length !== entries.length) {
      return { ok: false, reason: `${field}: tail contains null (inFlux)`, tick: p.ticks, timestamp: p.timestamp, values }
    }
    if (!allEqual(nonNullValues)) {
      return { ok: false, reason: `${field}: tail diverged`, tick: p.ticks, timestamp: p.timestamp, values }
    }
  }
  return { ok: true as const }
}

function main() {
  const { path, tail } = parseArgs(process.argv)
  const raw = readFileSync(path, "utf8")
  const lines = raw
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
  const points: Point[] = []
  for (const line of lines) {
    try {
      points.push(JSON.parse(line))
    } catch {
      // eslint-disable-next-line no-console
      console.error(`Invalid JSONL line in ${path}`)
      process.exit(1)
    }
  }

  const state = assertNoDivergence(points, "stateHashes")
  const hooks = assertNoDivergence(points, "hookCountsHashes")

  const stateTail = assertTailConverges(points, tail, "stateHashes")
  const hooksTail = assertTailConverges(points, tail, "hookCountsHashes")

  const ok =
    state.divergences.length === 0 &&
    hooks.divergences.length === 0 &&
    stateTail.ok &&
    hooksTail.ok

  const summary = {
    ok,
    points: points.length,
    nonNullTicks: { stateHashes: state.nonNullTicks, hookCountsHashes: hooks.nonNullTicks },
    tail,
    failures: {
      state: state.divergences,
      hooks: hooks.divergences,
      stateTail: stateTail.ok ? null : stateTail,
      hooksTail: hooksTail.ok ? null : hooksTail,
    },
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ token_observe_analysis: summary }, null, 2))

  if (!ok) process.exit(1)
}

main()


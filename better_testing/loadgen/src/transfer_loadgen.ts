import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { appendJsonl, getRunConfig, writeJson } from "./run_io"

type LoadgenConfig = {
  targets: string[]
  durationSec: number
  wallets: string[]
  amount: number
  sampleLimit: number
  inflightPerWallet: number
  avoidSelfRecipient: boolean
  emitTimeseries: boolean
}

type Counters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  confirmError: number
  broadcastError: number
  unexpectedError: number
}

type TimeseriesPoint = {
  tSec: number
  ok: number
  total: number
  confirmError: number
  broadcastError: number
  unexpectedError: number
  tpsOk: number
  latencyMs: { sampleCount: number; p50: number; p95: number; p99: number }
  timestamp: string
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
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

async function readWalletMnemonics(): Promise<string[]> {
  const explicit = splitCsv(process.env.WALLETS)
  if (explicit.length > 0) return explicit

  const dir = process.env.MNEMONICS_DIR ?? "devnet/identities"
  const names = splitCsv(process.env.WALLET_FILES)
  const defaultFiles = names.length > 0 ? names : ["node1.identity", "node2.identity", "node3.identity", "node4.identity"]

  const mnemonics: string[] = []
  for (const file of defaultFiles) {
    const path = dir.replace(/\/+$/, "") + "/" + file
    const text = await Bun.file(path).text()
    const mnemonic = text.trim()
    if (mnemonic.length > 0) mnemonics.push(mnemonic)
  }

  return mnemonics
}

function maybeSilenceConsole() {
  if (!envBool("QUIET", true)) return

  const allowedPrefixes = ["{", "["]
  const originalLog = console.log.bind(console)
  const originalWarn = console.warn.bind(console)
  const originalInfo = console.info.bind(console)
  const originalDebug = console.debug.bind(console)

  const filter = (...args: any[]) => {
    if (args.length === 0) return
    const first = args[0]
    if (typeof first === "string") {
      const trimmed = first.trim()
      for (const p of allowedPrefixes) {
        if (trimmed.startsWith(p)) return originalLog(...args)
      }
      return
    }
    return originalLog(...args)
  }

  console.log = filter as any
  console.info = filter as any
  console.debug = () => {}
  console.warn = (...args: any[]) => originalWarn(...args)

  // Keep original methods accessible if needed during debugging.
  ;(globalThis as any).__loadgenConsole = { originalLog, originalWarn, originalInfo, originalDebug }
}

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

async function isRpcReady(rpcUrl: string): Promise<boolean> {
  const url = normalizeRpcUrl(rpcUrl)
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

async function waitForRpcReady(rpcUrl: string, timeoutSec: number): Promise<void> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  while (nowMs() < deadlineMs) {
    if (await isRpcReady(rpcUrl)) return
    attempt++
    const backoffMs = Math.min(2000, 100 + attempt * 100)
    await sleep(backoffMs)
  }
  throw new Error(`RPC not ready at ${rpcUrl} after ${timeoutSec}s`)
}

function getConfig(wallets: string[]): LoadgenConfig {
  const targets = splitCsv(process.env.TARGETS).length > 0
    ? splitCsv(process.env.TARGETS)
    : ["http://node-1:53551"]

  const amount = envFloat("AMOUNT", 1)

  return {
    targets: targets.map(normalizeRpcUrl),
    durationSec: envInt("DURATION_SEC", 30),
    wallets,
    amount,
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    inflightPerWallet: Math.max(1, envInt("INFLIGHT_PER_WALLET", 1)),
    avoidSelfRecipient: envBool("AVOID_SELF_RECIPIENT", true),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
  }
}

function pickRecipient(recipients: string[], senderHex: string, workerId: number, avoidSelf: boolean): string {
  if (!avoidSelf) return recipients[workerId % recipients.length]!
  for (let i = 0; i < recipients.length; i++) {
    const candidate = recipients[(workerId + i) % recipients.length]!
    if (candidate !== senderHex) return candidate
  }
  throw new Error("RECIPIENTS only contains the sender address (self-send avoided). Provide a different recipient.")
}

async function worker(
  cfg: LoadgenConfig,
  counters: Counters,
  sampler: ReservoirSampler,
  timeseriesSampler: ReservoirSampler,
  stopAtMs: number,
  walletMnemonic: string,
  workerId: number,
) {
  const rpcUrl = cfg.targets[workerId % cfg.targets.length]!

  const demos = new Demos()
  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await demos.connect(rpcUrl)
  await demos.connectWallet(walletMnemonic, { algorithm: "ed25519" })

  const sender = (await demos.crypto.getIdentity("ed25519")).publicKey
  const senderHex = uint8ArrayToHex(sender)

  const recipients = splitCsv(process.env.RECIPIENTS)
  if (recipients.length === 0) {
    throw new Error("RECIPIENTS is required for transfer loadgen (comma-separated 0x... addresses)")
  }

  const to = pickRecipient(recipients, senderHex, workerId, cfg.avoidSelfRecipient)

  const currentNonce = await demos.getAddressNonce(senderHex)
  let nextNonce = Number(currentNonce) + 1

  async function sendOne() {
    const start = performance.now()
    counters.total++
    try {
      const tx = demos.tx.empty()
      tx.content.to = to
      tx.content.nonce = nextNonce++
      tx.content.amount = cfg.amount
      tx.content.type = "native"
      tx.content.timestamp = Date.now()
      tx.content.data = ["native", { nativeOperation: "send", args: [to, cfg.amount] }]

      const signedTx = await demos.sign(tx)
      const validity = await demos.confirm(signedTx).catch((err: any) => {
        counters.confirmError++
        throw err
      })
      const broadcastRes = await demos.broadcast(validity).catch((err: any) => {
        counters.broadcastError++
        throw err
      })

      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)

      if (broadcastRes?.result === 200) {
        counters.ok++
      } else {
        counters.broadcastError++
      }
    } catch {
      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)
      counters.unexpectedError++
    }
  }

  const inflight = Math.max(1, cfg.inflightPerWallet)
  const active = new Set<Promise<void>>()

  function launchOne() {
    const p = sendOne().finally(() => {
      active.delete(p)
    })
    active.add(p)
  }

  while (nowMs() < stopAtMs) {
    while (active.size < inflight && nowMs() < stopAtMs) {
      launchOne()
    }
    if (active.size === 0) break
    await Promise.race(Array.from(active))
  }

  await Promise.allSettled(Array.from(active))
}

export async function runTransferLoadgen() {
  maybeSilenceConsole()
  const wallets = await readWalletMnemonics()
  const cfg = getConfig(wallets)

  const maxWallets = envInt("CONCURRENCY", wallets.length || 1)
  const usedWallets = wallets.slice(0, Math.max(1, Math.min(maxWallets, wallets.length)))

  if (wallets.length === 0) {
    throw new Error("No wallets found. Set WALLETS or MNEMONICS_DIR/WALLET_FILES.")
  }

  const startedAtMs = nowMs()
  const stopAtMs = startedAtMs + cfg.durationSec * 1000

  const counters: Counters = {
    startedAtMs,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    confirmError: 0,
    broadcastError: 0,
    unexpectedError: 0,
  }

  const sampler = new ReservoirSampler(cfg.sampleLimit)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/transfer`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
    timeseriesPath: `${artifactBase}.timeseries.jsonl`,
  }

  const timeseriesSampler = new ReservoirSampler(50_000)
  let lastPointAtMs = startedAtMs
  let lastOk = 0
  let lastTotal = 0
  let lastConfirmError = 0
  let lastBroadcastError = 0
  let lastUnexpectedError = 0

  async function timeseriesLoop() {
    if (!cfg.emitTimeseries) return
    while (nowMs() < stopAtMs) {
      await sleep(1000)
      const now = nowMs()
      const elapsedSinceLast = Math.max(0.001, (now - lastPointAtMs) / 1000)
      lastPointAtMs = now

      const okDelta = counters.ok - lastOk
      const totalDelta = counters.total - lastTotal
      const confirmDelta = counters.confirmError - lastConfirmError
      const broadcastDelta = counters.broadcastError - lastBroadcastError
      const unexpectedDelta = counters.unexpectedError - lastUnexpectedError

      lastOk = counters.ok
      lastTotal = counters.total
      lastConfirmError = counters.confirmError
      lastBroadcastError = counters.broadcastError
      lastUnexpectedError = counters.unexpectedError

      const samples = timeseriesSampler.snapshotSorted()
      const point: TimeseriesPoint = {
        tSec: (now - startedAtMs) / 1000,
        ok: okDelta,
        total: totalDelta,
        confirmError: confirmDelta,
        broadcastError: broadcastDelta,
        unexpectedError: unexpectedDelta,
        tpsOk: okDelta / elapsedSinceLast,
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

  await Promise.all(
    [
      ...usedWallets.map((mnemonic, idx) =>
        worker(cfg, counters, sampler, timeseriesSampler, stopAtMs, mnemonic, idx),
      ),
      timeseriesLoop(),
    ],
  )

  counters.endedAtMs = nowMs()

  const elapsedSec = Math.max(0.001, (counters.endedAtMs - counters.startedAtMs) / 1000)
  const tps = counters.ok / elapsedSec

  const samples = sampler.snapshotSorted()
  const report = {
    kind: "transfer_loadgen_summary",
    config: {
      ...cfg,
      concurrency: usedWallets.length,
      recipients: splitCsv(process.env.RECIPIENTS),
    },
    elapsedSec,
    totals: counters,
    tps,
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

if (import.meta.main) {
  await runTransferLoadgen()
}

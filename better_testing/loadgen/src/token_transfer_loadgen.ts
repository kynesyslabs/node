import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { appendJsonl, getRunConfig, writeJson } from "./run_io"
import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  pickRecipient,
  readWalletMnemonics,
  sendTokenTransferTxWithDemos,
  waitForCrossNodeHolderPointersMatchBalances,
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"

type LoadgenConfig = {
  targets: string[]
  durationSec: number
  wallets: string[]
  concurrency: number
  amount: bigint
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
  error: number
  errorSamples: Record<string, number>
}

type TimeseriesPoint = {
  tSec: number
  ok: number
  total: number
  error: number
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

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
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

function unique(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
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

function getConfig(wallets: string[]): LoadgenConfig {
  return {
    targets: getTokenTargets(),
    durationSec: envInt("DURATION_SEC", 30),
    wallets,
    concurrency: envInt("CONCURRENCY", wallets.length || 1),
    amount: BigInt(process.env.TOKEN_TRANSFER_AMOUNT ?? process.env.AMOUNT ?? "1"),
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    inflightPerWallet: Math.max(1, envInt("INFLIGHT_PER_WALLET", 1)),
    avoidSelfRecipient: envBool("AVOID_SELF_RECIPIENT", true),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
  }
}

async function worker(
  cfg: LoadgenConfig,
  counters: Counters,
  sampler: ReservoirSampler,
  timeseriesSampler: ReservoirSampler,
  stopAtMs: number,
  walletMnemonic: string,
  workerId: number,
  tokenAddress: string,
  recipientAddresses: string[],
) {
  const rpcUrl = cfg.targets[workerId % cfg.targets.length]!
  const demos = new Demos()
  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(rpcUrl)
  await demos.connectWallet(walletMnemonic, { algorithm: "ed25519" })

  const sender = (await demos.crypto.getIdentity("ed25519")).publicKey
  const senderHex = uint8ArrayToHex(sender)

  const to = pickRecipient(recipientAddresses, senderHex, workerId, cfg.avoidSelfRecipient)

  // Fetch nonce once and manage locally (required for high-throughput, multi-inflight).
  const currentNonce = await demos.getAddressNonce(senderHex)
  let nextNonce = Number(currentNonce) + 1

  async function sendOne() {
    const start = performance.now()
    counters.total++
    try {
      const nonce = nextNonce++
      const { res } = await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to,
        amount: cfg.amount,
        nonce,
      })
      if (res?.result !== 200) {
        throw new Error(`tx rejected: ${JSON.stringify(res)}`)
      }
      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)
      counters.ok++
    } catch (err: any) {
      const elapsed = performance.now() - start
      sampler.add(elapsed)
      timeseriesSampler.add(elapsed)
      counters.error++
      const key = String(err?.message ?? err ?? "unknown").slice(0, 400)
      counters.errorSamples[key] = (counters.errorSamples[key] ?? 0) + 1
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

export async function runTokenTransferLoadgen() {
  maybeSilenceConsole()
  const wallets = await readWalletMnemonics()
  const cfg = getConfig(wallets)

  if (wallets.length === 0) throw new Error("No wallets found. Set WALLETS or MNEMONICS_DIR/WALLET_FILES.")

  const usedWallets = wallets.slice(0, Math.max(1, Math.min(cfg.concurrency, wallets.length)))

  const bootstrapRpc = cfg.targets[0]!
  const recipientWallets = wallets.length >= 2 ? wallets : usedWallets
  const recipientAddresses = await getWalletAddresses(bootstrapRpc, recipientWallets)
  const usedWalletAddresses = await getWalletAddresses(bootstrapRpc, usedWallets)
  const { tokenAddress } = await ensureTokenAndBalances(bootstrapRpc, wallets[0]!, recipientAddresses)
  const explicitRecipients = splitCsv(process.env.RECIPIENTS)
  const recipients = explicitRecipients.length > 0 ? explicitRecipients : recipientAddresses

  const startedAtMs = nowMs()
  const stopAtMs = startedAtMs + cfg.durationSec * 1000

  const counters: Counters = {
    startedAtMs,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    error: 0,
    errorSamples: {},
  }

  const sampler = new ReservoirSampler(cfg.sampleLimit)
  const timeseriesSampler = new ReservoirSampler(50_000)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_transfer`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
    timeseriesPath: `${artifactBase}.timeseries.jsonl`,
  }

  let lastPointAtMs = startedAtMs
  let lastOk = 0
  let lastTotal = 0
  let lastError = 0

  async function timeseriesLoop() {
    if (!cfg.emitTimeseries) return
    while (nowMs() < stopAtMs) {
      await sleep(1000)
      const now = nowMs()
      const elapsedSinceLast = Math.max(0.001, (now - lastPointAtMs) / 1000)
      lastPointAtMs = now

      const okDelta = counters.ok - lastOk
      const totalDelta = counters.total - lastTotal
      const errorDelta = counters.error - lastError

      lastOk = counters.ok
      lastTotal = counters.total
      lastError = counters.error

      const samples = timeseriesSampler.snapshotSorted()
      const point: TimeseriesPoint = {
        tSec: (now - startedAtMs) / 1000,
        ok: okDelta,
        total: totalDelta,
        error: errorDelta,
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
        worker(cfg, counters, sampler, timeseriesSampler, stopAtMs, mnemonic, idx, tokenAddress, recipients),
      ),
      timeseriesLoop(),
    ],
  )

  counters.endedAtMs = nowMs()

  const postRunSettleCheck = envBool("POST_RUN_SETTLE_CHECK", true)
  const settleSample = unique([
    ...usedWalletAddresses,
    ...recipients.slice(0, Math.min(4, recipients.length)),
  ]).slice(0, envInt("POST_RUN_SETTLE_SAMPLE_ADDRESSES", 8))

  const postRunSettle = postRunSettleCheck
    ? await waitForCrossNodeTokenConsistency({
      rpcUrls: cfg.targets,
      tokenAddress,
      addresses: settleSample,
      timeoutSec: envInt("POST_RUN_SETTLE_TIMEOUT_SEC", 120),
      pollMs: envInt("POST_RUN_SETTLE_POLL_MS", 500),
    })
    : null

  const holderPointerSettleCheck = envBool("POST_RUN_HOLDER_POINTER_CHECK", true)
  const expectedPresent: Record<string, boolean> = {}
  if (postRunSettle?.ok && postRunSettle.perNode?.[0]?.snapshot?.balances) {
    const b = postRunSettle.perNode[0].snapshot.balances
    for (const addr of settleSample) {
      try {
        expectedPresent[addr] = BigInt(b[addr] ?? "0") > 0n
      } catch {
        expectedPresent[addr] = false
      }
    }
  }

  const holderPointerSettle =
    holderPointerSettleCheck && Object.keys(expectedPresent).length > 0
      ? await waitForCrossNodeHolderPointersMatchBalances({
        rpcUrls: cfg.targets,
        tokenAddress,
        expectedPresent,
        timeoutSec: envInt("POST_RUN_HOLDER_POINTER_TIMEOUT_SEC", 120),
        pollMs: envInt("POST_RUN_HOLDER_POINTER_POLL_MS", 500),
      })
      : null

  const durationSec = (counters.endedAtMs - counters.startedAtMs) / 1000
  const samples = sampler.snapshotSorted()
  const summary = {
    scenario: "token_transfer",
    tokenAddress,
    ok: counters.ok,
    total: counters.total,
    error: counters.error,
    errorSamples: counters.errorSamples,
    durationSec,
    okTps: counters.ok / Math.max(0.001, durationSec),
    latencyMs: {
      sampleCount: sampler.size(),
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
    },
    config: {
      targets: cfg.targets,
      concurrency: usedWallets.length,
      inflightPerWallet: cfg.inflightPerWallet,
      amount: cfg.amount.toString(),
      waitForRpcSec: envInt("WAIT_FOR_RPC_SEC", 120),
      tokenBootstrap: envBool("TOKEN_BOOTSTRAP", true),
      tokenDistribute: envBool("TOKEN_DISTRIBUTE", true),
    },
    postRun: {
      settleSample,
      settle: postRunSettle,
      holderPointers: holderPointerSettle,
    },
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, summary)
  console.log(JSON.stringify({ token_transfer_summary: summary }, null, 2))

  const strict = envBool("POST_RUN_SETTLE_STRICT", false)
  if (strict && postRunSettleCheck && postRunSettle && !postRunSettle.ok) {
    throw new Error("Post-run settle check failed (token_transfer)")
  }
  const strictPointers = envBool("POST_RUN_HOLDER_POINTER_STRICT", false)
  if (strictPointers && holderPointerSettleCheck && holderPointerSettle && !holderPointerSettle.ok) {
    throw new Error("Post-run holder-pointer check failed (token_transfer)")
  }
}

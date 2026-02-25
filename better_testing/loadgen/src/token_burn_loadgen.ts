import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { appendJsonl, getRunConfig, writeJson } from "./run_io"
import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  readWalletMnemonics,
  sendTokenBurnTxWithDemos,
  waitForCrossNodeHolderPointersMatchBalances,
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"

type LoadgenConfig = {
  targets: string[]
  durationSec: number
  concurrency: number
  amount: bigint
  sampleLimit: number
  inflightPerWallet: number
  emitTimeseries: boolean
}

type Counters = {
  startedAtMs: number
  endedAtMs: number
  total: number
  ok: number
  error: number
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

function nowMs(): number {
  return Date.now()
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
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

function getConfig(): LoadgenConfig {
  const targets = getTokenTargets()
  return {
    targets,
    durationSec: envInt("DURATION_SEC", 30),
    concurrency: envInt("CONCURRENCY", Math.max(1, targets.length)),
    amount: BigInt(process.env.TOKEN_BURN_AMOUNT ?? process.env.AMOUNT ?? "1"),
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    inflightPerWallet: Math.max(1, envInt("INFLIGHT_PER_WALLET", 1)),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
  }
}

async function worker(params: {
  cfg: LoadgenConfig
  counters: Counters
  sampler: ReservoirSampler
  timeseriesSampler: ReservoirSampler
  stopAtMs: number
  ownerMnemonic: string
  workerId: number
  tokenAddress: string
  fromAddress: string
  allocateNonce: () => number
}) {
  const { cfg } = params
  const rpcUrl = cfg.targets[params.workerId % cfg.targets.length]!
  const demos = new Demos()
  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(rpcUrl)
  await demos.connectWallet(params.ownerMnemonic, { algorithm: "ed25519" })

  async function sendOne() {
    const start = performance.now()
    params.counters.total++
    try {
      const nonce = params.allocateNonce()
      await sendTokenBurnTxWithDemos({
        demos,
        tokenAddress: params.tokenAddress,
        from: params.fromAddress,
        amount: cfg.amount,
        nonce,
      })
      const elapsed = performance.now() - start
      params.sampler.add(elapsed)
      params.timeseriesSampler.add(elapsed)
      params.counters.ok++
    } catch {
      const elapsed = performance.now() - start
      params.sampler.add(elapsed)
      params.timeseriesSampler.add(elapsed)
      params.counters.error++
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

  while (nowMs() < params.stopAtMs) {
    while (active.size < inflight && nowMs() < params.stopAtMs) {
      launchOne()
    }
    if (active.size === 0) break
    await Promise.race(Array.from(active))
  }

  await Promise.allSettled(Array.from(active))
}

export async function runTokenBurnLoadgen() {
  maybeSilenceConsole()
  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("No wallets found. Set WALLETS or MNEMONICS_DIR/WALLET_FILES.")

  const ownerMnemonic = wallets[0]!
  const cfg = getConfig()

  const bootstrapRpc = cfg.targets[0]!
  const allWalletAddresses = await getWalletAddresses(bootstrapRpc, wallets)
  const { tokenAddress } = await ensureTokenAndBalances(bootstrapRpc, ownerMnemonic, allWalletAddresses)

  const nonceDemos = new Demos()
  await waitForRpcReady(bootstrapRpc, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(bootstrapRpc, envInt("WAIT_FOR_TX_SEC", 120))
  await nonceDemos.connect(bootstrapRpc)
  await nonceDemos.connectWallet(ownerMnemonic, { algorithm: "ed25519" })
  const sender = (await nonceDemos.crypto.getIdentity("ed25519")).publicKey
  const ownerAddress = uint8ArrayToHex(sender)
  const currentNonce = await nonceDemos.getAddressNonce(ownerAddress)
  let nextNonce = Number(currentNonce) + 1
  const allocateNonce = () => nextNonce++

  const startedAtMs = nowMs()
  const stopAtMs = startedAtMs + cfg.durationSec * 1000

  const counters: Counters = {
    startedAtMs,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    error: 0,
  }

  const sampler = new ReservoirSampler(cfg.sampleLimit)
  const timeseriesSampler = new ReservoirSampler(50_000)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_burn`
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

  const effectiveConc = Math.max(1, cfg.concurrency)

  await Promise.all(
    [
      ...Array.from({ length: effectiveConc }).map((_, idx) =>
        worker({
          cfg,
          counters,
          sampler,
          timeseriesSampler,
          stopAtMs,
          ownerMnemonic,
          workerId: idx,
          tokenAddress,
          fromAddress: ownerAddress,
          allocateNonce,
        }),
      ),
      timeseriesLoop(),
    ],
  )

  counters.endedAtMs = nowMs()

  const postRunSettleCheck = envBool("POST_RUN_SETTLE_CHECK", true)
  const settleSample = unique([ownerAddress]).slice(0, envInt("POST_RUN_SETTLE_SAMPLE_ADDRESSES", 8))

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
    for (const [addr, balRaw] of Object.entries(postRunSettle.perNode[0].snapshot.balances)) {
      try {
        expectedPresent[addr] = BigInt(balRaw ?? "0") > 0n
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
    scenario: "token_burn",
    tokenAddress,
    ok: counters.ok,
    total: counters.total,
    error: counters.error,
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
      concurrency: effectiveConc,
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
  console.log(JSON.stringify({ token_burn_summary: summary }, null, 2))

  const strict = envBool("POST_RUN_SETTLE_STRICT", false)
  if (strict && postRunSettleCheck && postRunSettle && !postRunSettle.ok) {
    throw new Error("Post-run settle check failed (token_burn)")
  }
  const strictPointers = envBool("POST_RUN_HOLDER_POINTER_STRICT", false)
  if (strictPointers && holderPointerSettleCheck && holderPointerSettle && !holderPointerSettle.ok) {
    throw new Error("Post-run holder-pointer check failed (token_burn)")
  }
}

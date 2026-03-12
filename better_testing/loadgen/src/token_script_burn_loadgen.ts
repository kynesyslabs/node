import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { normalizeLoadgenError } from "./framework/errors"
import { appendJsonl, getRunConfig, writeJson } from "./framework/io"
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
import { maybeUpgradeScript } from "./token_script_perf_shared"
import { sleep, envInt, envBool, nowMs, unique, percentile, ReservoirSampler } from "./testing_utils"

type LoadgenConfig = {
  targets: string[]
  durationSec: number
  concurrency: number
  amount: bigint
  sampleLimit: number
  inflightPerWallet: number
  emitTimeseries: boolean
  scriptWorkIters: number
  scriptSetStorage: boolean
  scriptUpgrade: boolean
  scriptForceUpgrade: boolean
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
    scriptWorkIters: Math.max(0, envInt("SCRIPT_WORK_ITERS", 0)),
    scriptSetStorage: envBool("SCRIPT_SET_STORAGE", false),
    scriptUpgrade: envBool("TOKEN_SCRIPT_UPGRADE", true),
    scriptForceUpgrade: envBool("TOKEN_SCRIPT_FORCE_UPGRADE", false),
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
      const { res } = await sendTokenBurnTxWithDemos({
        demos,
        tokenAddress: params.tokenAddress,
        from: params.fromAddress,
        amount: cfg.amount,
        nonce,
      })
      if (res?.result !== 200) {
        throw new Error(`tx rejected: ${JSON.stringify(res)}`)
      }
      const elapsed = performance.now() - start
      params.sampler.add(elapsed)
      params.timeseriesSampler.add(elapsed)
      params.counters.ok++
    } catch (err: any) {
      const elapsed = performance.now() - start
      params.sampler.add(elapsed)
      params.timeseriesSampler.add(elapsed)
      params.counters.error++
      const info = normalizeLoadgenError(err)
      const key = `${info.code}: ${info.message}`.slice(0, 400)
      params.counters.errorSamples[key] = (params.counters.errorSamples[key] ?? 0) + 1
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

export async function runTokenScriptBurnLoadgen() {
  maybeSilenceConsole()
  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("No wallets found. Set WALLETS or MNEMONICS_DIR/WALLET_FILES.")

  const ownerMnemonic = wallets[0]!
  const cfg = getConfig()

  const bootstrapRpc = cfg.targets[0]!
  const allWalletAddresses = await getWalletAddresses(bootstrapRpc, wallets)
  const ownerAddress = allWalletAddresses[0]!

  const { tokenAddress } = await ensureTokenAndBalances(bootstrapRpc, ownerMnemonic, allWalletAddresses)

  const script = await maybeUpgradeScript({
    rpcUrl: bootstrapRpc,
    rpcUrls: cfg.targets,
    ownerMnemonic,
    ownerAddress,
    tokenAddress,
    workIters: cfg.scriptWorkIters,
    setStorage: cfg.scriptSetStorage,
    upgrade: cfg.scriptUpgrade,
    force: cfg.scriptForceUpgrade,
  })

  const nonceDemos = new Demos()
  await waitForRpcReady(bootstrapRpc, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(bootstrapRpc, envInt("WAIT_FOR_TX_SEC", 120))
  await nonceDemos.connect(bootstrapRpc)
  await nonceDemos.connectWallet(ownerMnemonic, { algorithm: "ed25519" })
  const sender = (await nonceDemos.crypto.getIdentity("ed25519")).publicKey
  const senderHex = uint8ArrayToHex(sender)
  const currentNonce = await nonceDemos.getAddressNonce(senderHex)
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
    errorSamples: {},
  }

  const sampler = new ReservoirSampler(cfg.sampleLimit)
  const timeseriesSampler = new ReservoirSampler(50_000)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_burn`
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
          fromAddress: senderHex,
          allocateNonce,
        }),
      ),
      timeseriesLoop(),
    ],
  )

  counters.endedAtMs = nowMs()

  const postRunSettleCheck = envBool("POST_RUN_SETTLE_CHECK", true)
  const settleSample = unique([senderHex, ...allWalletAddresses]).slice(0, envInt("POST_RUN_SETTLE_SAMPLE_ADDRESSES", 8))

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
    scenario: "token_script_burn",
    tokenAddress,
    script: {
      tokenScriptUpgrade: cfg.scriptUpgrade,
      tokenScriptForceUpgrade: cfg.scriptForceUpgrade,
      workIters: cfg.scriptWorkIters,
      setStorage: cfg.scriptSetStorage,
      upgrade: script,
    },
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
  console.log(JSON.stringify({ token_script_burn_summary: summary }, null, 2))

  const strict = envBool("POST_RUN_SETTLE_STRICT", true)
  if (strict && postRunSettleCheck && postRunSettle && !postRunSettle.ok) {
    throw new Error("Post-run settle check failed (token_script_burn)")
  }
  const strictPointers = envBool("POST_RUN_HOLDER_POINTER_STRICT", false)
  if (strictPointers && holderPointerSettleCheck && holderPointerSettle && !holderPointerSettle.ok) {
    throw new Error("Post-run holder-pointer check failed (token_script_burn)")
  }
}

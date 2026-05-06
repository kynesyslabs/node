import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { normalizeLoadgenError } from "./framework/errors"
import { appendJsonl, getRunConfig, writeJson } from "./framework/io"
import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  pickRecipient,
  readWalletMnemonics,
  sendTokenTransferTxWithDemos,
  sendTokenUpgradeScriptTxWithDemos,
  waitForCrossNodeHolderPointersMatchBalances,
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
  withDemosWallet,
} from "./token_shared"
import { sleep, envInt, envBool, splitCsv, normalizeRpcUrl, nowMs, unique, percentile, ReservoirSampler } from "./testing_utils"

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

function getConfig(wallets: string[]): LoadgenConfig {
  return {
    targets: getTokenTargets().map(normalizeRpcUrl),
    durationSec: envInt("DURATION_SEC", 30),
    wallets,
    concurrency: envInt("CONCURRENCY", wallets.length || 1),
    amount: BigInt(process.env.TOKEN_TRANSFER_AMOUNT ?? process.env.AMOUNT ?? "1"),
    sampleLimit: envInt("SAMPLE_LIMIT", 200_000),
    inflightPerWallet: Math.max(1, envInt("INFLIGHT_PER_WALLET", 1)),
    avoidSelfRecipient: envBool("AVOID_SELF_RECIPIENT", true),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
    scriptWorkIters: Math.max(0, envInt("SCRIPT_WORK_ITERS", 0)),
    scriptSetStorage: envBool("SCRIPT_SET_STORAGE", false),
    scriptUpgrade: envBool("TOKEN_SCRIPT_UPGRADE", true),
    scriptForceUpgrade: envBool("TOKEN_SCRIPT_FORCE_UPGRADE", false),
  }
}

async function callView(rpcUrl: string, tokenAddress: string, method: string, args: any[]) {
  return await nodeCall(rpcUrl, "token.callView", { tokenAddress, method, args }, `token.callView:${method}`)
}

async function waitForConsensusRounds(params: { rpcUrls: string[]; rounds: number; timeoutSec: number; pollMs: number }) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const start: Record<string, number | null> = {}

  for (const rpcUrl of params.rpcUrls) {
    const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, `getLastBlockNumber:start:${rpcUrl}`)
    start[rpcUrl] = typeof res?.response === "number" ? res.response : null
  }

  while (Date.now() < deadlineMs) {
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      const base = start[rpcUrl]
      const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, `getLastBlockNumber:poll:${rpcUrl}`)
      const current = typeof res?.response === "number" ? res.response : null
      const ok = typeof base === "number" && typeof current === "number" && current >= base + params.rounds
      if (!ok) allOk = false
    }
    if (allOk) return { ok: true, start }
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }

  return { ok: false, start }
}

async function waitForScriptReadyOnAllNodes(params: {
  rpcUrls: string[]
  tokenAddress: string
  timeoutSec: number
  viewMethod: string
  viewArgs: any[]
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let last: any = null

  while (Date.now() < deadline) {
    let allOk = true
    const perNode: Record<string, any> = {}
    for (const url of params.rpcUrls) {
      const token = await nodeCall(url, "token.get", { tokenAddress: params.tokenAddress }, `token.get:scriptReady:${url}`)
      perNode[url] = { token }
      if (token?.result !== 200 || !token?.response?.metadata?.hasScript) {
        allOk = false
        continue
      }
      const view = await callView(url, params.tokenAddress, params.viewMethod, params.viewArgs)
      perNode[url].view = view
      if (view?.result !== 200) {
        allOk = false
        continue
      }
    }
    last = perNode
    if (allOk) return { ok: true, perNode }
    await sleep(500)
  }

  return { ok: false, perNode: last }
}

function buildPerfScript(params: { workIters: number; setStorage: boolean }) {
  const work = Math.max(0, Math.floor(params.workIters))
  const setStorage = !!params.setStorage

  return [
    "function spin(n) {",
    "  let x = 0;",
    "  for (let i = 0; i < n; i++) x = (x + i) % 1000003;",
    "  return x;",
    "}",
    "",
    "function inc(storage, key) {",
    "  const base = storage && typeof storage === 'object' ? storage : {};",
    "  const cur = base[key] || 0;",
    "  const next = Number(cur) + 1;",
    "  return { ...base, [key]: next };",
    "}",
    "",
    "module.exports = {",
    "  hooks: {",
    `    beforeTransfer: (ctx) => (spin(${work}), ${setStorage ? "({ setStorage: inc(ctx.token.storage, 'beforeTransferCount') })" : "({})"}),`,
    `    afterTransfer:  (ctx) => (spin(${work}), ${setStorage ? "({ setStorage: inc(ctx.token.storage, 'afterTransferCount') })" : "({})"}),`,
    `    beforeMint:     (ctx) => (spin(${work}), ${setStorage ? "({ setStorage: inc(ctx.token.storage, 'beforeMintCount') })" : "({})"}),`,
    `    afterMint:      (ctx) => (spin(${work}), ${setStorage ? "({ setStorage: inc(ctx.token.storage, 'afterMintCount') })" : "({})"}),`,
    `    beforeBurn:     (ctx) => (spin(${work}), ${setStorage ? "({ setStorage: inc(ctx.token.storage, 'beforeBurnCount') })" : "({})"}),`,
    `    afterBurn:      (ctx) => (spin(${work}), ${setStorage ? "({ setStorage: inc(ctx.token.storage, 'afterBurnCount') })" : "({})"}),`,
    "  },",
    "  views: {",
    "    ping: (token) => ({ ok: true, address: token.address, ticker: token.ticker, hasScript: true }),",
    "    getHookCounts: (token) => token.storage || {},",
    "  },",
    "}",
    "",
  ].join("\n")
}

async function maybeUpgradeScript(params: {
  rpcUrl: string
  rpcUrls: string[]
  ownerMnemonic: string
  ownerAddress: string
  tokenAddress: string
  workIters: number
  setStorage: boolean
  upgrade: boolean
  force: boolean
}) {
  const token = await nodeCall(params.rpcUrl, "token.get", { tokenAddress: params.tokenAddress }, `token.get:maybeUpgrade:${params.tokenAddress}`)
  if (token?.result !== 200) throw new Error(`token.get failed before script upgrade: ${JSON.stringify(token)}`)
  const hasScript = !!token?.response?.metadata?.hasScript

  if (!params.upgrade) {
    if (!hasScript) throw new Error("TOKEN_SCRIPT_UPGRADE=false but token has no script (metadata.hasScript=false)")
    return { upgraded: false, tokenGet: token, upgradeTx: null, ready: null }
  }

  if (hasScript && !params.force) {
    const ready = await waitForScriptReadyOnAllNodes({
      rpcUrls: params.rpcUrls,
      tokenAddress: params.tokenAddress,
      timeoutSec: envInt("TOKEN_WAIT_APPLY_SEC", 60),
      viewMethod: process.env.TOKEN_VIEW_METHOD ?? "ping",
      viewArgs: [],
    })
    if (!ready.ok) throw new Error(`Script present but ping not ready in time: ${JSON.stringify(ready)}`)
    return { upgraded: false, tokenGet: token, upgradeTx: null, ready }
  }

  const viewMethod = process.env.TOKEN_VIEW_METHOD ?? "ping"
  const scriptCode = process.env.TOKEN_SCRIPT_CODE ?? buildPerfScript({ workIters: params.workIters, setStorage: params.setStorage })

  const upgradeTx = await withDemosWallet({
    rpcUrl: params.rpcUrl,
    mnemonic: params.ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (fromHex.toLowerCase() !== params.ownerAddress.toLowerCase()) {
        throw new Error(`owner identity mismatch: ${fromHex} !== ${params.ownerAddress}`)
      }
      const nonce = Number(await demos.getAddressNonce(params.ownerAddress)) + 1
      return await sendTokenUpgradeScriptTxWithDemos({
        demos,
        tokenAddress: params.tokenAddress,
        scriptCode,
        methodNames: [viewMethod, "getHookCounts"],
        nonce,
      })
    },
  })

  const waitConsensus = await waitForConsensusRounds({
    rpcUrls: params.rpcUrls,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitConsensus.ok) throw new Error("Consensus wait failed after upgradeScript")

  const ready = await waitForScriptReadyOnAllNodes({
    rpcUrls: params.rpcUrls,
    tokenAddress: params.tokenAddress,
    timeoutSec: envInt("TOKEN_WAIT_APPLY_SEC", 120),
    viewMethod,
    viewArgs: [],
  })
  if (!ready.ok) throw new Error(`upgradeScript not visible in time: ${JSON.stringify(ready)}`)

  return { upgraded: true, tokenGet: token, upgradeTx, ready }
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
  const senderHex = uint8ArrayToHex(sender as Uint8Array)

  const to = pickRecipient(recipientAddresses, senderHex, workerId, cfg.avoidSelfRecipient)

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
      const info = normalizeLoadgenError(err)
      const key = `${info.code}: ${info.message}`.slice(0, 400)
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

export async function runTokenScriptTransferLoadgen() {
  maybeSilenceConsole()
  const wallets = await readWalletMnemonics()
  const cfg = getConfig(wallets)

  if (wallets.length === 0) throw new Error("No wallets found. Set WALLETS or MNEMONICS_DIR/WALLET_FILES.")

  const usedWallets = wallets.slice(0, Math.max(1, Math.min(cfg.concurrency, wallets.length)))

  const bootstrapRpc = cfg.targets[0]!
  const recipientWallets = wallets.length >= 2 ? wallets : usedWallets
  const recipientAddresses = await getWalletAddresses(bootstrapRpc, recipientWallets)
  const usedWalletAddresses = await getWalletAddresses(bootstrapRpc, usedWallets)

  const ownerMnemonic = wallets[0]!
  const owner = recipientAddresses[0]!

  const { tokenAddress } = await ensureTokenAndBalances(bootstrapRpc, ownerMnemonic, recipientAddresses)
  const explicitRecipients = splitCsv(process.env.RECIPIENTS)
  const recipients = explicitRecipients.length > 0 ? explicitRecipients : recipientAddresses

  const script = await maybeUpgradeScript({
    rpcUrl: bootstrapRpc,
    rpcUrls: cfg.targets,
    ownerMnemonic,
    ownerAddress: owner,
    tokenAddress,
    workIters: cfg.scriptWorkIters,
    setStorage: cfg.scriptSetStorage,
    upgrade: cfg.scriptUpgrade,
    force: cfg.scriptForceUpgrade,
  })

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
  const artifactBase = `${run.runDir}/token_script_transfer`
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
    scenario: "token_script_transfer",
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
  console.log(JSON.stringify({ token_script_transfer_summary: summary }, null, 2))

  const strict = envBool("POST_RUN_SETTLE_STRICT", true)
  if (strict && postRunSettleCheck && postRunSettle && !postRunSettle.ok) {
    throw new Error("Post-run settle check failed (token_script_transfer)")
  }
  const strictPointers = envBool("POST_RUN_HOLDER_POINTER_STRICT", false)
  if (strictPointers && holderPointerSettleCheck && holderPointerSettle && !holderPointerSettle.ok) {
    throw new Error("Post-run holder-pointer check failed (token_script_transfer)")
  }
}

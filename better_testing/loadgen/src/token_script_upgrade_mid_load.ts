import { appendJsonl, getRunConfig, writeJson } from "./run_io"
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
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
  withDemosWallet,
} from "./token_shared"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"

type Config = {
  targets: string[]
  durationSec: number
  upgradeAtSec: number
  wallets: string[]
  concurrency: number
  inflightPerWallet: number
  amount: bigint
  emitTimeseries: boolean
  scriptWorkItersA: number
  scriptWorkItersB: number
  scriptSetStorage: boolean
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

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

function stableJson(value: any): string {
  const sort = (v: any): any => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === "object") {
      const out: any = {}
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

function buildUpgradableScript(params: { tag: "A" | "B"; workIters: number; setStorage: boolean }) {
  const tag = params.tag
  const work = Math.max(0, Math.floor(params.workIters))
  const setStorage = !!params.setStorage

  return [
    `const TAG = ${JSON.stringify(tag)};`,
    `const WORK = ${JSON.stringify(work)};`,
    "",
    `function spin(n) {`,
    `  let x = 0;`,
    `  for (let i = 0; i < n; i++) x = (x + i) % 1000003;`,
    `  return x;`,
    `}`,
    "",
    `function inc(storage, key) {`,
    `  const base = storage && typeof storage === 'object' ? storage : {};`,
    `  const cur = base[key] || 0;`,
    `  const next = Number(cur) + 1;`,
    `  return { ...base, [key]: next };`,
    `}`,
    "",
    `module.exports = {`,
    `  hooks: {`,
    `    beforeTransfer: (ctx) => (spin(WORK), ${setStorage ? "({ setStorage: { ...inc(ctx.token.storage, 'beforeTransferCount'), scriptTag: TAG } })" : "({})"}),`,
    `    afterTransfer:  (ctx) => (spin(WORK), ${setStorage ? "({ setStorage: { ...inc(ctx.token.storage, 'afterTransferCount'), scriptTag: TAG } })" : "({})"}),`,
    `  },`,
    `  views: {`,
    `    ping: (_token) => ({ ok: true, tag: TAG }),`,
    `    getScriptTag: (_token) => ({ tag: TAG }),`,
    `    getHookCounts: (token) => token.storage || {},`,
    `  },`,
    `}`,
    "",
  ].join("\n")
}

async function callView(rpcUrl: string, tokenAddress: string, method: string, args: any[]) {
  return await nodeCall(rpcUrl, "token.callView", { tokenAddress, method, args }, `token.callView:${method}`)
}

async function waitForViewTagOnAllNodes(params: {
  rpcUrls: string[]
  tokenAddress: string
  method: string
  args: any[]
  expectedTag: "A" | "B"
  timeoutSec: number
  pollMs: number
}) {
  const deadline = nowMs() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  let last: any = null
  while (nowMs() < deadline) {
    attempts++
    const perNode: Record<string, any> = {}
    let allOk = true
    for (const url of params.rpcUrls) {
      const res = await callView(url, params.tokenAddress, params.method, params.args)
      perNode[url] = res
      if (res?.result !== 200) {
        allOk = false
        continue
      }
      const tag = res?.response?.value?.tag
      if (tag !== params.expectedTag) allOk = false
    }
    last = perNode
    if (allOk) return { ok: true, attempts, perNode }
    await sleep(Math.max(50, Math.floor(params.pollMs)))
  }
  return { ok: false, attempts, perNode: last }
}

async function waitForCrossNodeHookCountsStable(params: {
  rpcUrls: string[]
  tokenAddress: string
  timeoutSec: number
  pollMs: number
  stablePolls: number
}) {
  const deadline = nowMs() + Math.max(1, params.timeoutSec) * 1000
  const required = Math.max(1, Math.floor(params.stablePolls))
  let stable = 0
  let attempts = 0
  let last: any = null

  while (nowMs() < deadline) {
    attempts++
    const perNode: Record<string, any> = {}
    let allOk = true
    let stableValue: string | null = null

    for (const url of params.rpcUrls) {
      const res = await callView(url, params.tokenAddress, "getHookCounts", [])
      perNode[url] = res
      if (res?.result !== 200) {
        allOk = false
        continue
      }
      const v = stableJson(res?.response?.value ?? {})
      if (stableValue == null) stableValue = v
      else if (v !== stableValue) allOk = false
    }

    last = perNode
    if (allOk) stable++
    else stable = 0

    if (stable >= required) return { ok: true, attempts, stablePolls: stable, perNode: last }
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }

  return { ok: false, attempts, stablePolls: stable, perNode: last }
}

function getConfig(wallets: string[]): Config {
  const targets = getTokenTargets().map(normalizeRpcUrl)
  const durationSec = envInt("DURATION_SEC", 45)
  const upgradeAt = envInt("UPGRADE_AT_SEC", Math.max(3, Math.floor(durationSec / 2)))

  return {
    targets,
    durationSec,
    upgradeAtSec: Math.max(1, Math.min(durationSec - 1, upgradeAt)),
    wallets,
    concurrency: envInt("CONCURRENCY", Math.max(1, wallets.length - 1)),
    inflightPerWallet: Math.max(1, envInt("INFLIGHT_PER_WALLET", 1)),
    amount: BigInt(process.env.TOKEN_TRANSFER_AMOUNT ?? process.env.AMOUNT ?? "1"),
    emitTimeseries: envBool("EMIT_TIMESERIES", true),
    scriptWorkItersA: Math.max(0, envInt("SCRIPT_WORK_ITERS_A", envInt("SCRIPT_WORK_ITERS", 0))),
    scriptWorkItersB: Math.max(0, envInt("SCRIPT_WORK_ITERS_B", Math.max(0, envInt("SCRIPT_WORK_ITERS", 0) + 1000))),
    scriptSetStorage: envBool("SCRIPT_SET_STORAGE", true),
    scriptForceUpgrade: envBool("TOKEN_SCRIPT_FORCE_UPGRADE", true),
  }
}

async function worker(
  cfg: Config,
  counters: Counters,
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

  const currentNonce = await demos.getAddressNonce(senderHex)
  let nextNonce = Number(currentNonce) + 1

  async function sendOne() {
    counters.total++
    const nonce = nextNonce++
    const to = pickRecipient(recipientAddresses, senderHex, counters.total + workerId, true)
    const res = await sendTokenTransferTxWithDemos({ demos, tokenAddress, to, amount: cfg.amount, nonce })
    if (res?.res?.result !== 200) throw new Error(`tx rejected: ${JSON.stringify(res?.res)}`)
    counters.ok++
  }

  const inflight = Math.max(1, cfg.inflightPerWallet)
  const active = new Set<Promise<void>>()

  function launchOne() {
    const p = sendOne().catch((err: any) => {
      counters.error++
      const key = String(err?.message ?? err ?? "unknown").slice(0, 400)
      counters.errorSamples[key] = (counters.errorSamples[key] ?? 0) + 1
    }).finally(() => {
      active.delete(p)
    })
    active.add(p)
  }

  while (nowMs() < stopAtMs) {
    while (active.size < inflight && nowMs() < stopAtMs) launchOne()
    if (active.size === 0) break
    await Promise.race(Array.from(active))
  }

  await Promise.allSettled(Array.from(active))
}

export async function runTokenScriptUpgradeMidLoad() {
  maybeSilenceConsole()

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_script_upgrade_mid_load requires at least 2 wallets (owner + worker)")

  const cfg = getConfig(wallets)

  const ownerMnemonic = wallets[0]!
  const bootstrapRpc = cfg.targets[0]!

  const addresses = await getWalletAddresses(bootstrapRpc, wallets.slice(0, Math.min(wallets.length, Math.max(4, cfg.concurrency + 1))))
  const ownerAddress = addresses[0]!
  const { tokenAddress } = await ensureTokenAndBalances(bootstrapRpc, ownerMnemonic, addresses)

  const tokenBefore = await nodeCall(bootstrapRpc, "token.get", { tokenAddress }, `token.get:before:${tokenAddress}`)
  if (tokenBefore?.result !== 200) throw new Error(`token.get failed before upgrade: ${JSON.stringify(tokenBefore)}`)
  const hasScriptBefore = !!tokenBefore?.response?.metadata?.hasScript

  const scriptA = buildUpgradableScript({ tag: "A", workIters: cfg.scriptWorkItersA, setStorage: cfg.scriptSetStorage })
  const scriptB = buildUpgradableScript({ tag: "B", workIters: cfg.scriptWorkItersB, setStorage: cfg.scriptSetStorage })

  const methodNames = ["ping", "getScriptTag", "getHookCounts"]

  const upgradeA = await withDemosWallet({
    rpcUrl: bootstrapRpc,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (fromHex.toLowerCase() !== ownerAddress.toLowerCase()) throw new Error(`owner identity mismatch: ${fromHex} !== ${ownerAddress}`)
      const nonce = Number(await demos.getAddressNonce(ownerAddress)) + 1
      const out = await sendTokenUpgradeScriptTxWithDemos({ demos, tokenAddress, scriptCode: scriptA, methodNames, nonce })
      return out
    },
  })

  const tagAReady = await waitForViewTagOnAllNodes({
    rpcUrls: cfg.targets,
    tokenAddress,
    method: "ping",
    args: [],
    expectedTag: "A",
    timeoutSec: envInt("SCRIPT_READY_TIMEOUT_SEC", 120),
    pollMs: envInt("SCRIPT_READY_POLL_MS", 500),
  })
  if (!tagAReady.ok) throw new Error(`Script tag A not visible across nodes: ${JSON.stringify(tagAReady)}`)

  const startedAtMs = nowMs()
  const stopAtMs = startedAtMs + cfg.durationSec * 1000
  const upgradeAtMs = startedAtMs + cfg.upgradeAtSec * 1000

  const usedWallets = wallets.slice(1, Math.min(wallets.length, 1 + Math.max(1, cfg.concurrency)))

  const counters: Counters = {
    startedAtMs,
    endedAtMs: 0,
    total: 0,
    ok: 0,
    error: 0,
    errorSamples: {},
  }

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_upgrade_mid_load`
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

      const point: TimeseriesPoint = {
        tSec: (now - startedAtMs) / 1000,
        ok: okDelta,
        total: totalDelta,
        error: errorDelta,
        tpsOk: okDelta / elapsedSinceLast,
        timestamp: new Date().toISOString(),
      }
      appendJsonl(artifacts.timeseriesPath, point)
    }
  }

  const upgradeBPromise = (async () => {
    while (nowMs() < upgradeAtMs) await sleep(250)
    return await withDemosWallet({
      rpcUrl: bootstrapRpc,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        if (fromHex.toLowerCase() !== ownerAddress.toLowerCase()) throw new Error(`owner identity mismatch: ${fromHex} !== ${ownerAddress}`)
        const nonce = Number(await demos.getAddressNonce(ownerAddress)) + 1
        return await sendTokenUpgradeScriptTxWithDemos({ demos, tokenAddress, scriptCode: scriptB, methodNames, nonce })
      },
    })
  })()

  await Promise.all([
    ...usedWallets.map((mnemonic, idx) => worker(cfg, counters, stopAtMs, mnemonic, idx, tokenAddress, addresses)),
    timeseriesLoop(),
  ])

  counters.endedAtMs = nowMs()
  const upgradeB = await upgradeBPromise

  const tagBReady = await waitForViewTagOnAllNodes({
    rpcUrls: cfg.targets,
    tokenAddress,
    method: "ping",
    args: [],
    expectedTag: "B",
    timeoutSec: envInt("SCRIPT_READY_TIMEOUT_SEC", 180),
    pollMs: envInt("SCRIPT_READY_POLL_MS", 500),
  })
  if (!tagBReady.ok) throw new Error(`Script tag B not visible across nodes: ${JSON.stringify(tagBReady)}`)

  const hookCountsStable = await waitForCrossNodeHookCountsStable({
    rpcUrls: cfg.targets,
    tokenAddress,
    timeoutSec: envInt("SCRIPT_SETTLE_TIMEOUT_SEC", 180),
    pollMs: envInt("SCRIPT_SETTLE_POLL_MS", 700),
    stablePolls: envInt("SCRIPT_STABLE_POLLS", 3),
  })

  const settleSample = addresses.slice(0, Math.min(addresses.length, envInt("POST_RUN_SETTLE_SAMPLE_ADDRESSES", 8)))
  const crossNodeBalances = await waitForCrossNodeTokenConsistency({
    rpcUrls: cfg.targets,
    tokenAddress,
    addresses: settleSample,
    timeoutSec: envInt("POST_RUN_SETTLE_TIMEOUT_SEC", 180),
    pollMs: envInt("POST_RUN_SETTLE_POLL_MS", 500),
  })

  const summary = {
    runId: run.runId,
    scenario: "token_script_upgrade_mid_load",
    tokenAddress,
    rpcUrls: cfg.targets,
    config: {
      durationSec: cfg.durationSec,
      upgradeAtSec: cfg.upgradeAtSec,
      concurrency: cfg.concurrency,
      inflightPerWallet: cfg.inflightPerWallet,
      amount: cfg.amount.toString(),
      scriptWorkItersA: cfg.scriptWorkItersA,
      scriptWorkItersB: cfg.scriptWorkItersB,
      scriptSetStorage: cfg.scriptSetStorage,
      scriptForceUpgrade: cfg.scriptForceUpgrade,
    },
    addresses: { owner: ownerAddress, workers: addresses.slice(1) },
    counters,
    script: { hasScriptBefore, upgradeA, upgradeB },
    checks: {
      tagAReadyOk: tagAReady.ok,
      tagBReadyOk: tagBReady.ok,
      hookCountsStableOk: hookCountsStable.ok,
      crossNodeBalancesOk: crossNodeBalances.ok,
    },
    hookCountsStable,
    crossNodeBalances,
    timestamp: new Date().toISOString(),
    ok: tagAReady.ok && tagBReady.ok && hookCountsStable.ok && crossNodeBalances.ok,
  }

  writeJson(artifacts.summaryPath, summary)
  console.log(JSON.stringify({ token_script_upgrade_mid_load_summary: summary }, null, 2))
  if (!summary.ok) throw new Error("token_script_upgrade_mid_load failed checks")
}

import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenUpgradeScriptTxWithDemos,
  withDemosWallet,
} from "./token_shared"
import { getRunConfig, writeJson } from "./framework/io"

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

function assertHasError(res: any, expectedError: string) {
  if (res?.result === 200) throw new Error(`Expected error ${expectedError} but got 200: ${JSON.stringify(res)}`)
  const err = res?.response?.error ?? res?.error
  if (String(err ?? "").toUpperCase() !== expectedError.toUpperCase()) {
    throw new Error(`Expected error=${expectedError} but got: ${JSON.stringify(res)}`)
  }
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)
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

async function waitForTokenScriptApplied(params: {
  rpcUrl: string
  tokenAddress: string
  timeoutSec: number
  viewMethod: string
  viewArgs: any[]
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let last: any = null
  let lastView: any = null
  while (Date.now() < deadline) {
    last = await nodeCall(params.rpcUrl, "token.get", { tokenAddress: params.tokenAddress }, `token.get:${params.tokenAddress}`)
    if (last?.result === 200) {
      const hasScript = !!last?.response?.metadata?.hasScript
      if (hasScript) {
        lastView = await callView(params.rpcUrl, params.tokenAddress, params.viewMethod, params.viewArgs)
        if (lastView?.result === 200) {
          return { ok: true, tokenGet: last, view: lastView }
        }
      }
    }
    await sleep(500)
  }
  return { ok: false, tokenGet: last, view: lastView }
}

async function callView(rpcUrl: string, tokenAddress: string, method: string, args: any[]) {
  return await nodeCall(rpcUrl, "token.callView", { tokenAddress, method, args }, `token.callView:${method}`)
}

export async function runTokenScriptSmoke() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 1) throw new Error("token_script_smoke requires at least 1 wallet (owner)")
  const ownerMnemonic = wallets[0]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const viewMethod = process.env.TOKEN_VIEW_METHOD ?? "hello"

  const preView = await callView(rpcUrl, tokenAddress, viewMethod, ["world"])
  assertHasError(preView, "NO_SCRIPT")

  const scriptCode =
    process.env.TOKEN_SCRIPT_CODE ??
    [
      "module.exports = {",
      "  views: {",
      "    hello: (token, name) => ({ ok: true, hello: String(name ?? 'world'), ticker: token.ticker, address: token.address }),",
      "  },",
      "}",
      "",
    ].join("\n")

  const upgrade = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenUpgradeScriptTxWithDemos({ demos, tokenAddress, scriptCode, methodNames: [viewMethod], nonce })
    },
  })

  const waitConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitConsensus.ok) throw new Error("Consensus wait failed after upgradeScript")

  const applied = await waitForTokenScriptApplied({
    rpcUrl,
    tokenAddress,
    timeoutSec: envInt("TOKEN_WAIT_APPLY_SEC", 120),
    viewMethod,
    viewArgs: ["world"],
  })
  if (!applied.ok) throw new Error(`upgradeScript not visible in time: ${JSON.stringify({ tokenGet: applied.tokenGet, view: applied.view })}`)

  const perNodeViews: Record<string, any> = {}
  for (const url of targets) {
    const res = await callView(url, tokenAddress, viewMethod, ["world"])
    perNodeViews[url] = res
    if (res?.result !== 200) {
      throw new Error(`token.callView failed on ${url}: ${JSON.stringify(res)}`)
    }
    const value = res?.response?.value
    if (!value || value.ok !== true || value.hello !== "world") {
      throw new Error(`Unexpected token.callView value on ${url}: ${JSON.stringify(res)}`)
    }
  }

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_smoke`
  const summary = {
    runId: run.runId,
    scenario: "token_script_smoke",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner },
    viewMethod,
    txs: { upgrade },
    preView,
    tokenGetAfterUpgrade: applied.tokenGet,
    viewAfterUpgrade: applied.view,
    perNodeViews,
    ok: true,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(stringifyJson({ token_script_smoke_summary: summary }))
}

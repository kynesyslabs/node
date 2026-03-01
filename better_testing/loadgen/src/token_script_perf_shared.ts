import { nodeCall, sendTokenUpgradeScriptTxWithDemos, withDemosWallet } from "./token_shared"

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

async function callView(rpcUrl: string, tokenAddress: string, method: string, args: any[]) {
  return await nodeCall(rpcUrl, "token.callView", { tokenAddress, method, args }, `token.callView:${method}`)
}

export function buildPerfScript(params: { workIters: number; setStorage: boolean }) {
  const work = Math.max(0, Math.floor(params.workIters))
  const setStorage = !!params.setStorage

  return [
    `function spin(n) {`,
    `  let x = 0;`,
    `  for (let i = 0; i < n; i++) x = (x + i) % 1000003;`,
    `  return x;`,
    `}`,
    ``,
    `function inc(storage, key) {`,
    `  const base = storage && typeof storage === 'object' ? storage : {};`,
    `  const cur = base[key] || 0;`,
    `  const next = Number(cur) + 1;`,
    `  return { ...base, [key]: next };`,
    `}`,
    ``,
    `module.exports = {`,
    `  hooks: {`,
    `    beforeTransfer: (ctx) => { spin(${work}); ${setStorage ? "return { setStorage: inc(ctx.token.storage, 'beforeTransferCount') }" : "return {}"} },`,
    `    afterTransfer:  (ctx) => { spin(${work}); ${setStorage ? "return { setStorage: inc(ctx.token.storage, 'afterTransferCount') }" : "return {}"} },`,
    `    beforeMint:     (ctx) => { spin(${work}); ${setStorage ? "return { setStorage: inc(ctx.token.storage, 'beforeMintCount') }" : "return {}"} },`,
    `    afterMint:      (ctx) => { spin(${work}); ${setStorage ? "return { setStorage: inc(ctx.token.storage, 'afterMintCount') }" : "return {}"} },`,
    `    beforeBurn:     (ctx) => { spin(${work}); ${setStorage ? "return { setStorage: inc(ctx.token.storage, 'beforeBurnCount') }" : "return {}"} },`,
    `    afterBurn:      (ctx) => { spin(${work}); ${setStorage ? "return { setStorage: inc(ctx.token.storage, 'afterBurnCount') }" : "return {}"} },`,
    `  },`,
    `  views: {`,
    `    ping: (token) => ({ ok: true, address: token.address, ticker: token.ticker, hasScript: true }),`,
    `    getHookCounts: (token) => token.storage || {},`,
    `  },`,
    `}`,
    ``,
  ].join("\n")
}

async function waitForConsensusRounds(params: { rpcUrls: string[]; rounds: number; timeoutSec: number; pollMs: number }) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const start: Record<string, number | null> = {}

  for (const rpcUrl of params.rpcUrls) {
    const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, `getLastBlockNumber:start:${rpcUrl}`)
    const raw = res?.response
    start[rpcUrl] = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : null
  }

  while (Date.now() < deadlineMs) {
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      const base = start[rpcUrl]
      const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, `getLastBlockNumber:poll:${rpcUrl}`)
      const raw = res?.response
      const current = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : null
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
      const token = await nodeCall(url, "token.get", { tokenAddress: params.tokenAddress }, `token.get:ready:${url}`)
      const view = await callView(url, params.tokenAddress, params.viewMethod, params.viewArgs)
      perNode[url] = { token, view }
      if (token?.result !== 200 || !token?.response?.metadata?.hasScript || view?.result !== 200) {
        allOk = false
      }
    }
    last = perNode
    if (allOk) return { ok: true, perNode }
    await sleep(500)
  }

  return { ok: false, perNode: last }
}

export async function maybeUpgradeScript(params: {
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

  const viewMethod = process.env.TOKEN_VIEW_METHOD ?? "ping"

  if (hasScript && !params.force) {
    const ready = await waitForScriptReadyOnAllNodes({
      rpcUrls: params.rpcUrls,
      tokenAddress: params.tokenAddress,
      timeoutSec: envInt("TOKEN_WAIT_APPLY_SEC", 60),
      viewMethod,
      viewArgs: [],
    })
    if (!ready.ok) throw new Error(`Script present but ping not ready in time: ${JSON.stringify(ready)}`)
    return { upgraded: false, tokenGet: token, upgradeTx: null, ready }
  }

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


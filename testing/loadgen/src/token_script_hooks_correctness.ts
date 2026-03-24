import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenBurnTxWithDemos,
  sendTokenMintTxWithDemos,
  sendTokenTransferTxWithDemos,
  sendTokenUpgradeScriptTxWithDemos,
  withDemosWallet,
} from "./token_shared"
import { getRunConfig, writeJson } from "./framework/io"
import { logNonCriticalErrorOnce } from "./framework/common"

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

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)
}

function parseIntOrZero(value: any): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function parseBigintOrZero(value: any): bigint {
  try {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(value)
    if (typeof value === "string") return BigInt(value)
  } catch (error) {
    logNonCriticalErrorOnce("token_script_hooks_correctness.parseBigintOrZero", "token_script_hooks_correctness.parseBigintOrZero", error, { value })
  }
  return 0n
}

async function snapshot(rpcUrl: string, tokenAddress: string, addresses: string[]) {
  const token = await nodeCall(rpcUrl, "token.get", { tokenAddress }, `token.get:${tokenAddress}`)
  if (token?.result !== 200) throw new Error(`token.get failed: ${JSON.stringify(token)}`)

  const customState = token?.response?.state?.customState ?? {}
  const supply = parseBigintOrZero(token?.response?.state?.totalSupply)

  const balances: Record<string, bigint> = {}
  for (const a of addresses) {
    const bal = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    if (bal?.result !== 200) throw new Error(`token.getBalance failed: ${JSON.stringify(bal)}`)
    balances[a] = parseBigintOrZero(bal?.response?.balance)
  }

  return { token, customState, supply, balances }
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

async function waitForCustomStateCounts(params: {
  rpcUrl: string
  tokenAddress: string
  addresses: string[]
  expected: Record<string, number>
  timeoutSec: number
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let last = await snapshot(params.rpcUrl, params.tokenAddress, params.addresses)
  while (Date.now() < deadline) {
    last = await snapshot(params.rpcUrl, params.tokenAddress, params.addresses)
    const state = last.customState ?? {}
    let ok = true
    for (const [k, v] of Object.entries(params.expected)) {
      if (parseIntOrZero((state as any)[k]) !== v) {
        ok = false
        break
      }
    }
    if (ok) return { ok: true, snapshot: last }
    await sleep(500)
  }
  return { ok: false, snapshot: last }
}

async function waitForCrossNodeCustomState(params: {
  rpcUrls: string[]
  tokenAddress: string
  expected: Record<string, number>
  timeoutSec: number
  pollMs: number
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  let last: any = null
  while (Date.now() < deadline) {
    attempts++
    const perNode: Record<string, any> = {}
    let allOk = true
    for (const url of params.rpcUrls) {
      const res = await nodeCall(url, "token.get", { tokenAddress: params.tokenAddress }, `token.get:cross:${attempts}:${url}`)
      perNode[url] = res
      if (res?.result !== 200) {
        allOk = false
        continue
      }
      const cs = res?.response?.state?.customState ?? {}
      for (const [k, v] of Object.entries(params.expected)) {
        if (parseIntOrZero((cs as any)[k]) !== v) {
          allOk = false
          break
        }
      }
    }
    last = perNode
    if (allOk) return { ok: true, attempts, perNode }
    await sleep(Math.max(50, Math.floor(params.pollMs)))
  }
  return { ok: false, attempts, perNode: last }
}

export async function runTokenScriptHooksCorrectness() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_script_hooks_correctness requires at least 2 wallets (owner, other)")

  const ownerMnemonic = wallets[0]!
  const otherMnemonic = wallets[1]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, otherMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const other = walletAddresses[1]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const transferAmount = parseBigintOrZero(process.env.TOKEN_TRANSFER_AMOUNT ?? "1")
  const mintAmount = parseBigintOrZero(process.env.TOKEN_MINT_AMOUNT ?? "1")
  const burnAmount = parseBigintOrZero(process.env.TOKEN_BURN_AMOUNT ?? "1")

  const applyTimeoutSec = envInt("TOKEN_WAIT_APPLY_SEC", 120)

  const hookKeys = {
    beforeTransfer: "beforeTransferCount",
    afterTransfer: "afterTransferCount",
    beforeMint: "beforeMintCount",
    afterMint: "afterMintCount",
    beforeBurn: "beforeBurnCount",
    afterBurn: "afterBurnCount",
  }

  const scriptCode =
    process.env.TOKEN_SCRIPT_CODE ??
    [
      "function inc(storage, key) {",
      "  const cur = (storage && typeof storage === 'object' ? storage[key] : 0) || 0;",
      "  const next = Number(cur) + 1;",
      "  return { ...(storage && typeof storage === 'object' ? storage : {}), [key]: next };",
      "}",
      "",
      "module.exports = {",
      "  hooks: {",
      "    beforeTransfer: (ctx) => ({ setStorage: inc(ctx.token.storage, 'beforeTransferCount') }),",
      "    afterTransfer:  (ctx) => ({ setStorage: inc(ctx.token.storage, 'afterTransferCount') }),",
      "    beforeMint:     (ctx) => ({ setStorage: inc(ctx.token.storage, 'beforeMintCount') }),",
      "    afterMint:      (ctx) => ({ setStorage: inc(ctx.token.storage, 'afterMintCount') }),",
      "    beforeBurn:     (ctx) => ({ setStorage: inc(ctx.token.storage, 'beforeBurnCount') }),",
      "    afterBurn:      (ctx) => ({ setStorage: inc(ctx.token.storage, 'afterBurnCount') }),",
      "  },",
      "  views: {",
      "    getHookCounts: (token) => token.storage || {},",
      "  },",
      "}",
      "",
    ].join("\n")

  const before = await snapshot(rpcUrl, tokenAddress, [owner, other])

  const upgrade = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenUpgradeScriptTxWithDemos({
        demos,
        tokenAddress,
        scriptCode,
        methodNames: ["getHookCounts"],
        nonce,
      })
    },
  })

  const waitUpgradeConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitUpgradeConsensus.ok) throw new Error("Consensus wait failed after upgradeScript")

  const afterUpgrade = await snapshot(rpcUrl, tokenAddress, [owner, other])

  // 1) Transfer owner -> other (should trigger before/after transfer hooks)
  const transferTx = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: transferAmount, nonce })
    },
  })

  const waitTransferConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitTransferConsensus.ok) throw new Error("Consensus wait failed after transfer")

  const afterTransferCounts = await waitForCustomStateCounts({
    rpcUrl,
    tokenAddress,
    addresses: [owner, other],
    expected: { [hookKeys.beforeTransfer]: 1, [hookKeys.afterTransfer]: 1 },
    timeoutSec: applyTimeoutSec,
  })
  if (!afterTransferCounts.ok) throw new Error(`Transfer hook counts not visible: ${JSON.stringify(afterTransferCounts.snapshot.token)}`)

  const afterTransfer = afterTransferCounts.snapshot
  const transferApplied =
    afterTransfer.balances[owner] === afterUpgrade.balances[owner] - transferAmount &&
    afterTransfer.balances[other] === afterUpgrade.balances[other] + transferAmount

  // 2) Mint owner -> other (should trigger before/after mint hooks)
  const mintTx = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenMintTxWithDemos({ demos, tokenAddress, to: other, amount: mintAmount, nonce })
    },
  })

  const waitMintConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitMintConsensus.ok) throw new Error("Consensus wait failed after mint")

  const afterMintCounts = await waitForCustomStateCounts({
    rpcUrl,
    tokenAddress,
    addresses: [owner, other],
    expected: {
      [hookKeys.beforeTransfer]: 1,
      [hookKeys.afterTransfer]: 1,
      [hookKeys.beforeMint]: 1,
      [hookKeys.afterMint]: 1,
    },
    timeoutSec: applyTimeoutSec,
  })
  if (!afterMintCounts.ok) throw new Error(`Mint hook counts not visible: ${JSON.stringify(afterMintCounts.snapshot.token)}`)

  const afterMint = afterMintCounts.snapshot
  const mintApplied =
    afterMint.supply === afterTransfer.supply + mintAmount && afterMint.balances[other] === afterTransfer.balances[other] + mintAmount

  // 3) Burn by other from self (should trigger before/after burn hooks)
  const burnTx = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== other) throw new Error(`other identity mismatch: ${fromHex} !== ${other}`)
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: other, amount: burnAmount, nonce })
    },
  })

  const waitBurnConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitBurnConsensus.ok) throw new Error("Consensus wait failed after burn")

  const afterBurnCounts = await waitForCustomStateCounts({
    rpcUrl,
    tokenAddress,
    addresses: [owner, other],
    expected: {
      [hookKeys.beforeTransfer]: 1,
      [hookKeys.afterTransfer]: 1,
      [hookKeys.beforeMint]: 1,
      [hookKeys.afterMint]: 1,
      [hookKeys.beforeBurn]: 1,
      [hookKeys.afterBurn]: 1,
    },
    timeoutSec: applyTimeoutSec,
  })
  if (!afterBurnCounts.ok) throw new Error(`Burn hook counts not visible: ${JSON.stringify(afterBurnCounts.snapshot.token)}`)

  const afterBurn = afterBurnCounts.snapshot
  const burnApplied =
    afterBurn.supply === afterMint.supply - burnAmount && afterBurn.balances[other] === afterMint.balances[other] - burnAmount

  const crossNodeCustomState = await waitForCrossNodeCustomState({
    rpcUrls: targets,
    tokenAddress,
    expected: {
      [hookKeys.beforeTransfer]: 1,
      [hookKeys.afterTransfer]: 1,
      [hookKeys.beforeMint]: 1,
      [hookKeys.afterMint]: 1,
      [hookKeys.beforeBurn]: 1,
      [hookKeys.afterBurn]: 1,
    },
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_hooks_correctness`
  const summary = {
    runId: run.runId,
    scenario: "token_script_hooks_correctness",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, other },
    amounts: { transferAmount: transferAmount.toString(), mintAmount: mintAmount.toString(), burnAmount: burnAmount.toString() },
    txs: { upgrade, transferTx, mintTx, burnTx },
    snapshots: { before, afterUpgrade, afterTransfer, afterMint, afterBurn },
    assertions: {
      transferApplied,
      mintApplied,
      burnApplied,
      crossNodeCustomStateOk: crossNodeCustomState.ok,
    },
    crossNodeCustomState,
    ok: transferApplied && mintApplied && burnApplied && crossNodeCustomState.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(stringifyJson({ token_script_hooks_correctness_summary: summary }))
  if (!summary.ok) throw new Error("token_script_hooks_correctness failed assertions")
}

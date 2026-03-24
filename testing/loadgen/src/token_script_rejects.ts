import {
  buildSignedTokenTransferTxWithDemos,
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenTransferTxWithDemos,
  sendTokenUpgradeScriptTxWithDemos,
  waitForCrossNodeTokenConsistency,
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

function parseBigintOrZero(value: any): bigint {
  try {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(value)
    if (typeof value === "string") return BigInt(value)
  } catch (error) {
    logNonCriticalErrorOnce("token_script_rejects.parseBigintOrZero", "token_script_rejects.parseBigintOrZero", error, { value })
  }
  return 0n
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)
}

function assertRejected(res: any, expectedMessageSubstring: string) {
  if (res?.result === 200) {
    throw new Error(`Expected rejection but got result=200: ${JSON.stringify(res)}`)
  }
  const pieces: string[] = []
  if (typeof res?.extra?.error === "string") pieces.push(res.extra.error)
  if (typeof res?.response === "string") pieces.push(res.response)
  if (res?.response === false) pieces.push("false")
  if (typeof res?.message === "string") pieces.push(res.message)
  if (typeof res?.response?.message === "string") pieces.push(res.response.message)
  const haystack = pieces.join(" ").toLowerCase()
  if (!haystack.includes(expectedMessageSubstring.toLowerCase())) {
    throw new Error(`Expected error to include "${expectedMessageSubstring}" but got: ${JSON.stringify(res)}`)
  }
}

function extractRejectSignature(res: any): string | null {
  const pieces: string[] = []
  if (typeof res?.extra?.error === "string") pieces.push(res.extra.error)
  if (typeof res?.response === "string") pieces.push(res.response)
  if (typeof res?.message === "string") pieces.push(res.message)
  if (typeof res?.response?.message === "string") pieces.push(res.response.message)

  const text = pieces.join(" ")
  const m = text.match(/amount-too-large:[0-9]+>[0-9]+/i)
  if (m?.[0]) return m[0].toLowerCase()
  if (text.toLowerCase().includes("rejected")) return "rejected"
  return null
}

async function snapshot(rpcUrl: string, tokenAddress: string, addresses: string[]) {
  const token = await nodeCall(rpcUrl, "token.get", { tokenAddress }, `token.get:${tokenAddress}`)
  if (token?.result !== 200) throw new Error(`token.get failed: ${JSON.stringify(token)}`)

  const supply = parseBigintOrZero(token?.response?.state?.totalSupply)
  const balances: Record<string, bigint> = {}
  for (const a of addresses) {
    const bal = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    if (bal?.result !== 200) throw new Error(`token.getBalance failed: ${JSON.stringify(bal)}`)
    balances[a] = parseBigintOrZero(bal?.response?.balance)
  }
  const customState = token?.response?.state?.customState ?? {}
  return { token, supply, balances, customState }
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

async function waitForCrossNodeCustomState(params: {
  rpcUrls: string[]
  tokenAddress: string
  expectedCustomState: any
  timeoutSec: number
  pollMs: number
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  let last: any = null
  const expectedStable = stableJson(params.expectedCustomState)

  while (Date.now() < deadline) {
    attempts++
    const perNode: Record<string, any> = {}
    let allOk = true
    for (const url of params.rpcUrls) {
      const res = await nodeCall(url, "token.get", { tokenAddress: params.tokenAddress }, `token.get:cs:${attempts}:${url}`)
      perNode[url] = res
      if (res?.result !== 200) {
        allOk = false
        continue
      }
      const cs = res?.response?.state?.customState ?? {}
      if (stableJson(cs) !== expectedStable) allOk = false
    }
    last = perNode
    if (allOk) return { ok: true, attempts, perNode }
    await sleep(Math.max(50, Math.floor(params.pollMs)))
  }

  return { ok: false, attempts, perNode: last }
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

export async function runTokenScriptRejects() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_script_rejects requires at least 2 wallets (owner, other)")
  const ownerMnemonic = wallets[0]!
  const otherMnemonic = wallets[1]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, otherMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const other = walletAddresses[1]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const thresholdRaw = parseBigintOrZero(process.env.SCRIPT_REJECT_THRESHOLD ?? "1")
  const threshold = thresholdRaw > 0n ? thresholdRaw : 1n
  const tooLarge = threshold + 1n
  const small = threshold

  const applyTimeoutSec = envInt("TOKEN_WAIT_APPLY_SEC", 120)

  const scriptCode =
    process.env.TOKEN_SCRIPT_CODE ??
    [
      `const LIMIT = BigInt(${JSON.stringify(threshold.toString())});`,
      "",
      "module.exports = {",
      "  hooks: {",
      "    beforeTransfer: (ctx) => {",
      "      let amt = 0n;",
      "      try { amt = BigInt(ctx?.operationData?.amount ?? 0); } catch { amt = 0n; }",
      "      if (amt > LIMIT) return { reject: `amount-too-large:${amt.toString()}>${LIMIT.toString()}` };",
      "      return null;",
      "    },",
      "  },",
      "  views: {",
      "    getThreshold: (_token) => ({ threshold: LIMIT.toString() }),",
      "  },",
      "}",
      "",
    ].join("\n")

  // We store threshold in customState/storage via the install-time state (token.customState). For this smoke/reject test,
  // we just encode threshold in the script itself by default; but allow overriding via TOKEN_SCRIPT_CODE.
  // (The HookExecutor passes token.storage=customState.)

  const before = await snapshot(rpcUrl, tokenAddress, [owner, other])

  const upgrade = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenUpgradeScriptTxWithDemos({ demos, tokenAddress, scriptCode, methodNames: ["getThreshold"], nonce })
    },
  })

  const waitUpgradeConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitUpgradeConsensus.ok) throw new Error("Consensus wait failed after upgradeScript")

  const viewPerNode: Record<string, any> = {}
  for (const url of targets) {
    const res = await nodeCall(url, "token.callView", { tokenAddress, method: "getThreshold", args: [] }, `token.callView:getThreshold:${url}`)
    viewPerNode[url] = res
    if (res?.result !== 200) throw new Error(`token.callView failed on ${url}: ${JSON.stringify(res)}`)
    const got = res?.response?.value?.threshold
    if (String(got ?? "") !== threshold.toString()) {
      throw new Error(`Unexpected getThreshold on ${url}: expected=${threshold.toString()} got=${stringifyJson(res?.response?.value)}`)
    }
  }

  // Valid transfer BEFORE invalid (proves hooks are active).
  const okTransferBefore = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: small, nonce })
    },
  })
  if (okTransferBefore?.res?.result !== 200) {
    throw new Error(`Expected ok transfer-before but got: ${JSON.stringify(okTransferBefore?.res)}`)
  }

  const waitOkBeforeConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitOkBeforeConsensus.ok) throw new Error("Consensus wait failed after ok transfer-before")

  const baseline = await snapshot(rpcUrl, tokenAddress, [owner, other])
  const okAppliedBefore =
    baseline.balances[owner] === before.balances[owner] - small && baseline.balances[other] === before.balances[other] + small

  // Build ONE oversized transfer and confirm it across all nodes (determinism check).
  const invalidTx = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      const timestamp = Date.now()
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: tooLarge, nonce, timestamp })
    },
  })

  const invalidBroadcastPerNode: Record<string, any> = {}
  for (const url of targets) {
    const out = await withDemosWallet({
      rpcUrl: url,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
        const validity = await (demos as any).confirm(invalidTx.signedTx)
        const res = await (demos as any).broadcast(validity)
        return { validity, res }
      },
    })
    invalidBroadcastPerNode[url] = out
  }

  const rejectSignatures = targets.map(url => ({ url, sig: extractRejectSignature(invalidBroadcastPerNode[url]?.res) }))
  const rejectDeterministic =
    rejectSignatures.every(e => !!e.sig) && rejectSignatures.every(e => e.sig === rejectSignatures[0]!.sig)

  if (!rejectDeterministic) {
    throw new Error(`Non-deterministic reject across nodes: ${stringifyJson({ rejectSignatures, invalidBroadcastPerNode })}`)
  }

  for (const url of targets) {
    assertRejected(invalidBroadcastPerNode[url]?.res, "amount-too-large")
  }

  const afterRejected = await (async () => {
    const deadline = Date.now() + applyTimeoutSec * 1000
    let last = await snapshot(rpcUrl, tokenAddress, [owner, other])
    while (Date.now() < deadline) {
      last = await snapshot(rpcUrl, tokenAddress, [owner, other])
      const unchanged =
        last.supply === baseline.supply &&
        last.balances[owner] === baseline.balances[owner] &&
        last.balances[other] === baseline.balances[other] &&
        stableJson(last.customState) === stableJson(baseline.customState)
      if (unchanged) return { ok: true, snapshot: last }
      await sleep(500)
    }
    return { ok: false, snapshot: last }
  })()

  const rejectStateUnchanged = afterRejected.ok

  // Valid transfer AFTER invalid (proves network continues and state applies).
  const okTransferAfter = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: small, nonce })
    },
  })
  if (okTransferAfter?.res?.result !== 200) throw new Error(`Expected ok transfer-after but got: ${JSON.stringify(okTransferAfter?.res)}`)

  const waitOkConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitOkConsensus.ok) throw new Error("Consensus wait failed after ok transfer-after")

  const afterOk = await snapshot(rpcUrl, tokenAddress, [owner, other])
  const okApplied =
    afterOk.balances[owner] === baseline.balances[owner] - small && afterOk.balances[other] === baseline.balances[other] + small

  const crossNodeBalances = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: [owner, other],
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const crossNodeCustomState = await waitForCrossNodeCustomState({
    rpcUrls: targets,
    tokenAddress,
    expectedCustomState: before.customState,
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_rejects`
  const summary = {
    runId: run.runId,
    scenario: "token_script_rejects",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, other },
    config: { threshold: threshold.toString(), tooLarge: tooLarge.toString(), small: small.toString() },
    views: { getThreshold: viewPerNode },
    txs: { upgrade, okTransferBefore, invalidTx, okTransferAfter },
    broadcasts: { invalidBroadcastPerNode, rejectSignatures },
    snapshots: { before, baseline, afterRejected: afterRejected.snapshot, afterOk },
    assertions: {
      okAppliedBefore,
      rejectDeterministic,
      rejectStateUnchanged,
      okApplied,
      crossNodeBalancesOk: crossNodeBalances.ok,
      crossNodeCustomStateOk: crossNodeCustomState.ok,
    },
    crossNodeBalances,
    crossNodeCustomState,
    ok: rejectStateUnchanged && okApplied && crossNodeBalances.ok && crossNodeCustomState.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(stringifyJson({ token_script_rejects_summary: summary }))
  if (!summary.ok) throw new Error("token_script_rejects failed assertions")
}

import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"
import { getRunConfig, writeJson } from "./run_io"

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
  } catch {
    // ignore
  }
  return 0n
}

type PerNodeReport = {
  rpcUrl: string
  tokenGet: any
  tokenGetMissing: any
  balances: Record<string, any>
  holderPointers: Record<string, any>
  callViewNoScript: any
  assertions: {
    tokenGetOk: boolean
    tokenGetMissing404: boolean
    balancesOk: boolean
    holderPointersOk: boolean
    callViewNoScriptOk: boolean
  }
}

export async function runTokenQueryCoverage() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_query_coverage requires at least 2 wallets")

  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))

  const walletAddresses = await getWalletAddresses(rpcUrl, wallets.slice(0, 4))
  const normalizedAddresses = walletAddresses.map(normalizeHexAddress)

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, wallets[0]!, walletAddresses)

  const token = await nodeCall(rpcUrl, "token.get", { tokenAddress }, "baseline:token.get")
  if (token?.result !== 200) {
    throw new Error(`token.get failed on baseline node: ${JSON.stringify(token)}`)
  }

  const expectedMeta = {
    name: token?.response?.metadata?.name ?? null,
    ticker: token?.response?.metadata?.ticker ?? null,
    decimals: token?.response?.metadata?.decimals ?? null,
    hasScript: token?.response?.metadata?.hasScript ?? null,
  }

  const expectedBalances: Record<string, string> = {}
  for (const a of normalizedAddresses) {
    const bal = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `baseline:bal:${a}`)
    if (bal?.result !== 200) throw new Error(`token.getBalance failed on baseline node: ${JSON.stringify(bal)}`)
    expectedBalances[a] = String(bal?.response?.balance ?? "0")
  }

  const crossNode = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: normalizedAddresses,
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const missingTokenAddress =
    normalizeHexAddress(process.env.MISSING_TOKEN_ADDRESS ?? "0x" + "11".repeat(32))

  const perNode: PerNodeReport[] = []
  for (const target of targets) {
    const tokenGet = await nodeCall(target, "token.get", { tokenAddress }, `token.get:${tokenAddress}`)
    const tokenGetMissing = await nodeCall(target, "token.get", { tokenAddress: missingTokenAddress }, `token.get:missing`)

    const balances: Record<string, any> = {}
    for (const a of normalizedAddresses) {
      balances[a] = await nodeCall(target, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    }

    const holderPointers: Record<string, any> = {}
    for (const a of normalizedAddresses) {
      holderPointers[a] = await nodeCall(target, "token.getHolderPointers", { address: a }, `token.getHolderPointers:${a}`)
    }

    const callViewNoScript = await nodeCall(
      target,
      "token.callView",
      { tokenAddress, method: "name", args: [] },
      `token.callView:${tokenAddress}:name`,
    )

    const tokenGetOk =
      tokenGet?.result === 200 &&
      tokenGet?.response?.tokenAddress === tokenAddress &&
      (tokenGet?.response?.metadata?.name ?? null) === expectedMeta.name &&
      (tokenGet?.response?.metadata?.ticker ?? null) === expectedMeta.ticker &&
      (tokenGet?.response?.metadata?.decimals ?? null) === expectedMeta.decimals &&
      (tokenGet?.response?.metadata?.hasScript ?? null) === expectedMeta.hasScript

    const tokenGetMissing404 = tokenGetMissing?.result === 404

    let balancesOk = true
    for (const a of normalizedAddresses) {
      const one = balances[a]
      const got = String(one?.response?.balance ?? "0")
      if (one?.result !== 200 || got !== expectedBalances[a]) {
        balancesOk = false
        break
      }
    }

    let holderPointersOk = true
    for (const a of normalizedAddresses) {
      const bal = parseBigintOrZero(expectedBalances[a])
      const shouldHave = bal > 0n
      const holder = holderPointers[a]
      if (holder?.result !== 200) {
        holderPointersOk = false
        break
      }
      const tokens = Array.isArray(holder?.response?.tokens) ? holder.response.tokens : []
      const hasPointer = tokens
        .map((t: any) => (typeof t === "string" ? normalizeHexAddress(t) : normalizeHexAddress(t?.tokenAddress)))
        .includes(normalizeHexAddress(tokenAddress))
      if (hasPointer !== shouldHave) {
        holderPointersOk = false
        break
      }
    }

    const callViewNoScriptOk =
      expectedMeta.hasScript === false
        ? callViewNoScript?.result === 400 && callViewNoScript?.response?.error === "NO_SCRIPT"
        : true

    perNode.push({
      rpcUrl: target,
      tokenGet,
      tokenGetMissing,
      balances,
      holderPointers,
      callViewNoScript,
      assertions: {
        tokenGetOk,
        tokenGetMissing404,
        balancesOk,
        holderPointersOk,
        callViewNoScriptOk,
      },
    })
  }

  const ok =
    crossNode.ok &&
    perNode.every(n =>
      n.assertions.tokenGetOk &&
      n.assertions.tokenGetMissing404 &&
      n.assertions.balancesOk &&
      n.assertions.holderPointersOk &&
      n.assertions.callViewNoScriptOk,
    )

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_query_coverage`
  const summary = {
    runId: run.runId,
    scenario: "token_query_coverage",
    tokenAddress,
    rpcUrls: targets,
    addresses: normalizedAddresses,
    expectedMeta,
    expectedBalances,
    missingTokenAddress,
    crossNode,
    perNode,
    ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_query_coverage_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("token_query_coverage failed (one or more node read APIs diverged or assertions failed)")
  }
}


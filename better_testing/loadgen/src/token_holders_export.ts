import { getRunConfig, writeJson } from "./framework/io"
import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
} from "./token_shared"

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

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

function stableSortedUnique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const key = normalizeHexAddress(v)
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  out.sort()
  return out
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

function sumBalances(balances: Record<string, any>, includeZero: boolean): bigint {
  let sum = 0n
  for (const [addr, raw] of Object.entries(balances ?? {})) {
    const a = normalizeHexAddress(addr)
    if (!a) continue
    const bal = parseBigintOrZero(raw)
    if (!includeZero && bal === 0n) continue
    sum += bal
  }
  return sum
}

async function fetchTokenWithRetry(params: {
  rpcUrl: string
  tokenAddress: string
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempt = 0
  let last: any = null
  while (Date.now() < deadlineMs) {
    // Committed preferred, but allow live fallback if committed is unavailable/in-flux.
    const committed = await nodeCall(
      params.rpcUrl,
      "token.getCommitted",
      { tokenAddress: params.tokenAddress },
      `token.getCommitted:holders:${attempt}`,
    )
    last = committed
    if (committed?.result === 200) return { ok: true, mode: "committed", raw: committed }
    const inFlux = committed?.result === 409 && committed?.response?.error === "STATE_IN_FLUX"
    if (inFlux) {
      const live = await nodeCall(
        params.rpcUrl,
        "token.get",
        { tokenAddress: params.tokenAddress },
        `token.get:holdersLive:${attempt}`,
      )
      last = live
      if (live?.result === 200) return { ok: true, mode: "live", raw: live }
    }
    attempt++
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }
  return { ok: false, mode: "unknown", raw: last }
}

export async function runTokenHoldersExport() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_holders_export requires at least 2 wallets")

  const ownerMnemonic = wallets[0]!
  const ownerRpc = targets[0]!
  const walletAddresses = (await getWalletAddresses(ownerRpc, wallets)).map(normalizeHexAddress)

  const { tokenAddress } = await ensureTokenAndBalances(ownerRpc, ownerMnemonic, walletAddresses)

  const includeZero = envBool("INCLUDE_ZERO_BALANCES", false)
  const fetchTimeoutSec = envInt("HOLDERS_FETCH_TIMEOUT_SEC", 120)
  const fetchPollMs = envInt("HOLDERS_FETCH_POLL_MS", 500)

  const perNode: Array<{
    rpcUrl: string
    ok: boolean
    readMode: "committed" | "live" | "unknown"
    holderCount: number | null
    holders: string[]
    totalSupply: string | null
    sumBalances: string | null
    error: any
  }> = []

  for (const rpcUrl of targets) {
    const res = await fetchTokenWithRetry({
      rpcUrl,
      tokenAddress,
      timeoutSec: fetchTimeoutSec,
      pollMs: fetchPollMs,
    })

    if (!res.ok) {
      perNode.push({
        rpcUrl,
        ok: false,
        readMode: "unknown",
        holderCount: null,
        holders: [],
        totalSupply: null,
        sumBalances: null,
        error: res.raw,
      })
      continue
    }

    const token = res.raw?.response
    const balances = token?.state?.balances ?? {}
    const holders = stableSortedUnique(Object.keys(balances))
    const supply = parseBigintOrZero(token?.state?.totalSupply)
    const sum = sumBalances(balances, includeZero)

    perNode.push({
      rpcUrl,
      ok: true,
      readMode: res.mode as any,
      holderCount: holders.length,
      holders,
      totalSupply: supply.toString(),
      sumBalances: sum.toString(),
      error: null,
    })
  }

  const okNodes = perNode.filter(n => n.ok)
  const base = okNodes.length > 0 ? okNodes[0]!.holders.join(",") : ""
  const holderSetsEqual = okNodes.length === perNode.length && okNodes.every(n => n.holders.join(",") === base)
  const supplyInvariantOk =
    okNodes.length === perNode.length &&
    okNodes.every(n => typeof n.totalSupply === "string" && typeof n.sumBalances === "string" && n.totalSupply === n.sumBalances)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_holders_export`
  const summary = {
    runId: run.runId,
    scenario: "token_holders_export",
    tokenAddress,
    rpcUrls: targets,
    includeZeroBalances: includeZero,
    notes:
      "Holder enumeration is derived from token.getCommitted/state.balances (fallback token.get). If the implementation prunes 0-balance entries or omits some holders, this list is explicitly bounded to whatever balances are present.",
    perNode,
    assertions: {
      holderSetsEqual,
      supplyInvariantOk,
    },
    ok: holderSetsEqual && supplyInvariantOk,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  writeJson(`${artifactBase}.holders.json`, { tokenAddress, holders: okNodes.length > 0 ? okNodes[0]!.holders : [] })
  console.log(JSON.stringify({ token_holders_export_summary: summary }, null, 2))

  if (!summary.ok) {
    throw new Error(`token_holders_export failed (see summary): ${artifactBase}.summary.json`)
  }
}


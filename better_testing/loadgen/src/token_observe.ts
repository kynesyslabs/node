import { appendJsonl, getRunConfig, writeJson } from "./run_io"
import {
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"
import { createHash } from "crypto"

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

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sortObjectDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortObjectDeep)
  if (!value || typeof value !== "object") return value
  const out: Record<string, any> = {}
  for (const key of Object.keys(value).sort()) out[key] = sortObjectDeep((value as any)[key])
  return out
}

function stableJson(value: any): string {
  return JSON.stringify(sortObjectDeep(value))
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function extractMempoolCount(raw: any): number | null {
  const res = raw?.result === 200 ? raw?.response : null
  if (Array.isArray(res)) return res.length
  if (res && typeof res === "object") {
    if (Array.isArray((res as any).txs)) return (res as any).txs.length
    if (Array.isArray((res as any).transactions)) return (res as any).transactions.length
    if (typeof (res as any).size === "number" && Number.isFinite((res as any).size)) return (res as any).size
    if (typeof (res as any).count === "number" && Number.isFinite((res as any).count)) return (res as any).count
  }
  return null
}

async function getLastBlockNumber(rpcUrl: string, muid: string): Promise<number | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, muid)
  const n = res?.response
  if (typeof n === "number" && Number.isFinite(n)) return n
  if (typeof n === "string") {
    const parsed = Number.parseInt(n, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function getLastBlockHash(rpcUrl: string, muid: string): Promise<string | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockHash", {}, muid)
  const h = res?.response
  if (typeof h === "string" && h.length > 0) return h
  return null
}

export async function runTokenObserve() {
  maybeSilenceConsole()
  const targets = getTokenTargets().map(normalizeRpcUrl)
  if (targets.length === 0) throw new Error("No TARGETS configured")

  const bootstrapRpc = targets[0]!
  const waitForRpcSec = envInt("WAIT_FOR_RPC_SEC", 120)
  const waitForTxSec = envInt("WAIT_FOR_TX_SEC", 120)
  for (const url of targets) await waitForRpcReady(url, waitForRpcSec)
  await waitForTxReady(bootstrapRpc, waitForTxSec)

  const tokenAddress = String(process.env.TOKEN_ADDRESS ?? "").trim()
  if (!tokenAddress) throw new Error("TOKEN_ADDRESS is required for token_observe")

  const wallets = await readWalletMnemonics()
  const walletCount = Math.max(0, envInt("OBSERVE_WALLETS", 4))
  const derived =
    walletCount > 0 && wallets.length > 0
      ? await getWalletAddresses(bootstrapRpc, wallets.slice(0, walletCount))
      : []

  const explicit = splitCsv(process.env.ADDRESSES)
  const addresses = Array.from(new Set([...derived, ...explicit].map(normalizeHexAddress).filter(Boolean)))
  if (addresses.length === 0) throw new Error("No addresses to observe. Provide ADDRESSES or OBSERVE_WALLETS>0 with wallets configured.")

  const observeSec = envInt("OBSERVE_SEC", 120)
  const pollMs = Math.max(100, envInt("OBSERVE_POLL_MS", 1000))
  const includeTokenGet = envBool("INCLUDE_TOKEN_GET", true)
  const includeScriptState = envBool("INCLUDE_SCRIPT_STATE", true)
  const includeMempool = envBool("INCLUDE_MEMPOOL", true)
  const includeRaw = envBool("INCLUDE_RAW", false)
  const viewMethod = process.env.SCRIPT_HOOKCOUNTS_VIEW ?? "getHookCounts"

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_observe`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
    timeseriesPath: `${artifactBase}.timeseries.jsonl`,
  }

  const startMs = Date.now()
  const stopAtMs = startMs + Math.max(1, observeSec) * 1000

  let ticks = 0
  let firstSeen: Record<string, any> | null = null
  let lastSeen: Record<string, any> | null = null

  while (Date.now() < stopAtMs) {
    ticks++
    const tMs = Date.now()

    const perNode: Record<string, any> = {}
    for (const url of targets) {
      const blockNumber = await getLastBlockNumber(url, `getLastBlockNumber:observe:${ticks}:${url}`)
      const blockHash = await getLastBlockHash(url, `getLastBlockHash:observe:${ticks}:${url}`)

      const mempool = includeMempool ? await nodeCall(url, "getMempool", {}, `getMempool:observe:${ticks}:${url}`) : null
      const mempoolCount = includeMempool ? extractMempoolCount(mempool) : null

      const balances: Record<string, string | null> = {}
      for (const a of addresses) {
        const bal = await nodeCall(url, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:observe:${ticks}:${url}:${a}`)
        balances[a] = bal?.result === 200 ? (bal?.response?.balance ?? null) : null
      }

      const tokenGet = includeTokenGet ? await nodeCall(url, "token.get", { tokenAddress }, `token.get:observe:${ticks}:${url}`) : null
      const totalSupply = tokenGet?.result === 200 ? (tokenGet?.response?.state?.totalSupply ?? null) : null
      const customState = includeScriptState && tokenGet?.result === 200 ? (tokenGet?.response?.state?.customState ?? null) : null
      const hookCounts =
        includeScriptState
          ? await nodeCall(url, "token.callView", { tokenAddress, method: viewMethod, args: [] }, `token.callView:${viewMethod}:observe:${ticks}:${url}`)
          : null

      const stateForHash = {
        tokenAddress: normalizeHexAddress(tokenAddress),
        totalSupply,
        balances,
        ...(includeScriptState ? { customState } : {}),
      }

      perNode[url] = {
        url,
        blockNumber,
        blockHash,
        mempoolCount,
        token: {
          totalSupply,
          balances,
          ...(includeScriptState ? { customState } : {}),
          stateHash: sha256Hex(stableJson(stateForHash)),
          ...(includeTokenGet ? { hasScript: !!tokenGet?.response?.metadata?.hasScript } : {}),
        },
        ...(includeScriptState
          ? {
            script: {
              hookCountsHash: sha256Hex(stableJson(hookCounts?.result === 200 ? hookCounts?.response?.value ?? null : null)),
            },
          }
          : {}),
        ...(includeRaw
          ? {
            raw: {
              mempool,
              tokenGet,
              hookCounts,
            },
          }
          : {}),
      }
    }

    const point = {
      tSec: (tMs - startMs) / 1000,
      timestamp: new Date().toISOString(),
      ticks,
      tokenAddress: normalizeHexAddress(tokenAddress),
      addresses,
      perNode,
      crossNode: {
        stateHashes: Object.fromEntries(Object.entries(perNode).map(([k, v]) => [k, v?.token?.stateHash ?? null])),
        hookCountsHashes: Object.fromEntries(Object.entries(perNode).map(([k, v]) => [k, v?.script?.hookCountsHash ?? null])),
        mempoolCounts: Object.fromEntries(Object.entries(perNode).map(([k, v]) => [k, v?.mempoolCount ?? null])),
        blockNumbers: Object.fromEntries(Object.entries(perNode).map(([k, v]) => [k, v?.blockNumber ?? null])),
        blockHashes: Object.fromEntries(Object.entries(perNode).map(([k, v]) => [k, v?.blockHash ?? null])),
      },
    }

    if (!firstSeen) firstSeen = point
    lastSeen = point

    appendJsonl(artifacts.timeseriesPath, point)
    await sleep(pollMs)
  }

  const summary = {
    runId: run.runId,
    scenario: "token_observe",
    tokenAddress: normalizeHexAddress(tokenAddress),
    rpcUrls: targets,
    addresses,
    config: {
      observeSec,
      pollMs,
      includeTokenGet,
      includeScriptState,
      includeMempool,
      includeRaw,
      viewMethod: includeScriptState ? viewMethod : null,
    },
    artifacts,
    first: firstSeen ? { tSec: firstSeen.tSec, crossNode: firstSeen.crossNode } : null,
    last: lastSeen ? { tSec: lastSeen.tSec, crossNode: lastSeen.crossNode } : null,
    ticks,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, summary)
  console.log(JSON.stringify({ token_observe_summary: summary }, null, 2))
}


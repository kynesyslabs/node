import { getRunConfig, writeJson } from "./run_io"
import {
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  waitForCrossNodeHolderPointersMatchBalances,
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"

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

function sortObjectDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortObjectDeep)
  if (!value || typeof value !== "object") return value
  const out: Record<string, any> = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = sortObjectDeep((value as any)[key])
  }
  return out
}

function stableJson(value: any): string {
  return JSON.stringify(sortObjectDeep(value))
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

type BlockSkewReport = {
  ok: boolean
  timeoutSec: number
  pollMs: number
  maxSkew: number
  stablePolls: number
  attempts: number
  durationMs: number
  startedAt: string
  endedAt: string
  last: Record<string, number | null>
  lastHash: Record<string, string | null>
}

type MempoolDrainReport = {
  ok: boolean
  timeoutSec: number
  pollMs: number
  stablePolls: number
  attempts: number
  durationMs: number
  startedAt: string
  endedAt: string
  lastCount: Record<string, number | null>
  lastRaw?: Record<string, any>
}

async function waitForBlockSkew(params: {
  rpcUrls: string[]
  timeoutSec: number
  pollMs: number
  maxSkew: number
  stablePolls: number
}): Promise<BlockSkewReport> {
  const startedAt = new Date()
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const pollMs = Math.max(100, Math.floor(params.pollMs))
  const stableNeeded = Math.max(1, Math.floor(params.stablePolls))
  const maxSkew = Math.max(0, Math.floor(params.maxSkew))

  let stable = 0
  let attempts = 0
  let last: Record<string, number | null> = {}
  let lastHash: Record<string, string | null> = {}

  while (Date.now() < deadlineMs) {
    attempts++
    last = {}
    lastHash = {}
    const values: number[] = []
    for (const rpcUrl of params.rpcUrls) {
      const n = await getLastBlockNumber(rpcUrl, `getLastBlockNumber:skew:${attempts}:${rpcUrl}`)
      last[rpcUrl] = n
      lastHash[rpcUrl] = await getLastBlockHash(rpcUrl, `getLastBlockHash:skew:${attempts}:${rpcUrl}`)
      if (typeof n === "number") values.push(n)
    }

    const min = values.length > 0 ? Math.min(...values) : null
    const max = values.length > 0 ? Math.max(...values) : null
    const skewOk = typeof min === "number" && typeof max === "number" && max - min <= maxSkew

    if (skewOk) {
      stable++
      if (stable >= stableNeeded) {
        const endedAt = new Date()
        return {
          ok: true,
          timeoutSec: params.timeoutSec,
          pollMs,
          maxSkew,
          stablePolls: stableNeeded,
          attempts,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          last,
          lastHash,
        }
      }
    } else {
      stable = 0
    }

    await sleep(pollMs)
  }

  const endedAt = new Date()
  return {
    ok: false,
    timeoutSec: params.timeoutSec,
    pollMs,
    maxSkew,
    stablePolls: stableNeeded,
    attempts,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    last,
    lastHash,
  }
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

async function waitForMempoolDrain(params: {
  rpcUrls: string[]
  timeoutSec: number
  pollMs: number
  stablePolls: number
  includeRaw: boolean
}): Promise<MempoolDrainReport> {
  const startedAt = new Date()
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const pollMs = Math.max(100, Math.floor(params.pollMs))
  const stableNeeded = Math.max(1, Math.floor(params.stablePolls))

  let stable = 0
  let attempts = 0
  let lastCount: Record<string, number | null> = {}
  const lastRaw: Record<string, any> = {}

  while (Date.now() < deadlineMs) {
    attempts++
    lastCount = {}
    for (const rpcUrl of params.rpcUrls) {
      const mempool = await nodeCall(rpcUrl, "getMempool", {}, `getMempool:${attempts}:${rpcUrl}`)
      lastCount[rpcUrl] = extractMempoolCount(mempool)
      if (params.includeRaw) lastRaw[rpcUrl] = mempool
    }

    const counts = Object.values(lastCount)
    const allKnown = counts.every(c => typeof c === "number")
    const allZero = allKnown && counts.every(c => (c ?? 1) === 0)

    if (allZero) {
      stable++
      if (stable >= stableNeeded) {
        const endedAt = new Date()
        return {
          ok: true,
          timeoutSec: params.timeoutSec,
          pollMs,
          stablePolls: stableNeeded,
          attempts,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          lastCount,
          ...(params.includeRaw ? { lastRaw } : {}),
        }
      }
    } else {
      stable = 0
    }

    await sleep(pollMs)
  }

  const endedAt = new Date()
  return {
    ok: false,
    timeoutSec: params.timeoutSec,
    pollMs,
    stablePolls: stableNeeded,
    attempts,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    lastCount,
    ...(params.includeRaw ? { lastRaw } : {}),
  }
}

export async function runTokenSettleCheck() {
  maybeSilenceConsole()
  const targets = getTokenTargets().map(normalizeRpcUrl)
  if (targets.length === 0) throw new Error("No TARGETS configured")

  const bootstrapRpc = targets[0]!
  const waitForRpcSec = envInt("WAIT_FOR_RPC_SEC", 120)
  const waitForTxSec = envInt("WAIT_FOR_TX_SEC", 120)
  for (const url of targets) {
    await waitForRpcReady(url, waitForRpcSec)
  }
  await waitForTxReady(bootstrapRpc, waitForTxSec)

  const tokenAddress = String(process.env.TOKEN_ADDRESS ?? "").trim()
  if (!tokenAddress) throw new Error("TOKEN_ADDRESS is required for token_settle_check")

  const wallets = await readWalletMnemonics()
  const walletCount = Math.max(0, envInt("SETTLE_WALLETS", 4))
  const derived = walletCount > 0 && wallets.length > 0
    ? await getWalletAddresses(bootstrapRpc, wallets.slice(0, walletCount))
    : []

  const explicit = splitCsv(process.env.ADDRESSES)
  const addresses = Array.from(
    new Set([...derived, ...explicit].map(normalizeHexAddress).filter(Boolean)),
  )
  if (addresses.length === 0) throw new Error("No addresses to check. Provide ADDRESSES or SETTLE_WALLETS>0 with wallets configured.")

  const blockSyncRounds = envInt("BLOCK_SYNC_ENABLE", 1)
  const blockSkew = blockSyncRounds !== 0
    ? await waitForBlockSkew({
      rpcUrls: targets,
      timeoutSec: envInt("BLOCK_SYNC_TIMEOUT_SEC", 120),
      pollMs: envInt("BLOCK_SYNC_POLL_MS", 500),
      maxSkew: envInt("BLOCK_MAX_SKEW", 2),
      stablePolls: envInt("BLOCK_STABLE_POLLS", 3),
    })
    : null

  const mempoolDrainEnable = envInt("MEMPOOL_DRAIN_ENABLE", 1) !== 0
  const mempoolDrain = mempoolDrainEnable
    ? await waitForMempoolDrain({
      rpcUrls: targets,
      timeoutSec: envInt("MEMPOOL_DRAIN_TIMEOUT_SEC", 90),
      pollMs: envInt("MEMPOOL_DRAIN_POLL_MS", 500),
      stablePolls: envInt("MEMPOOL_DRAIN_STABLE_POLLS", 3),
      includeRaw: envBool("MEMPOOL_DRAIN_INCLUDE_RAW", false),
    })
    : null

  const settle = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses,
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const holderPointerCheck = envBool("HOLDER_POINTER_CHECK", true)
  const expectedPresent: Record<string, boolean> = {}
  if (settle.ok && settle.perNode?.[0]?.snapshot?.balances) {
    for (const [addr, balRaw] of Object.entries(settle.perNode[0].snapshot.balances)) {
      try {
        expectedPresent[addr] = BigInt(balRaw ?? "0") > 0n
      } catch {
        expectedPresent[addr] = false
      }
    }
  }
  const holderPointers =
    holderPointerCheck && settle.ok && Object.keys(expectedPresent).length > 0
      ? await waitForCrossNodeHolderPointersMatchBalances({
        rpcUrls: targets,
        tokenAddress,
        expectedPresent,
        timeoutSec: envInt("HOLDER_POINTER_TIMEOUT_SEC", 180),
        pollMs: envInt("HOLDER_POINTER_POLL_MS", 500),
      })
      : null

  const expectScript = envBool("EXPECT_SCRIPT", false)
  const scriptViewMethod = process.env.SCRIPT_HOOKCOUNTS_VIEW ?? "getHookCounts"
  const perNodeScript: Record<string, any> = {}

  let scriptOk = true
  let scriptReason: string | null = null
  let scriptStablePollsNeeded: number | null = null

  if (expectScript) {
    const scriptTimeoutSec = envInt("SCRIPT_SETTLE_TIMEOUT_SEC", envInt("CROSS_NODE_TIMEOUT_SEC", 180))
    const scriptPollMs = envInt("SCRIPT_SETTLE_POLL_MS", 500)
    const stablePollsNeeded = Math.max(1, envInt("SCRIPT_STABLE_POLLS", 3))
    scriptStablePollsNeeded = stablePollsNeeded
    const deadlineMs = Date.now() + Math.max(1, scriptTimeoutSec) * 1000

    let stablePolls = 0

    while (Date.now() < deadlineMs) {
      const customStates: Record<string, string> = {}
      const hookCounts: Record<string, string> = {}
      const hasScriptFlags: Record<string, boolean> = {}

      for (const url of targets) {
        const token = await nodeCall(url, "token.get", { tokenAddress }, `token.get:settle:${url}`)
        hasScriptFlags[url] = !!token?.response?.metadata?.hasScript
        const customState = token?.result === 200 ? token?.response?.state?.customState ?? null : null
        customStates[url] = stableJson(customState)

        const view = await nodeCall(
          url,
          "token.callView",
          { tokenAddress, method: scriptViewMethod, args: [] },
          `token.callView:${scriptViewMethod}:${url}`,
        )
        const counts = view?.result === 200 ? (view?.response?.value ?? null) : null
        hookCounts[url] = stableJson(counts)

        perNodeScript[url] = { tokenGet: token, hookCountsView: view }
      }

      const uniqueHasScript = new Set(Object.values(hasScriptFlags).map(v => String(v))).size
      const uniqueCustomState = new Set(Object.values(customStates)).size
      const uniqueHookCounts = new Set(Object.values(hookCounts)).size

      const hasScriptOk = uniqueHasScript === 1 && Object.values(hasScriptFlags).every(v => v === true)
      const customStateOk = uniqueCustomState === 1
      const hookCountsOk = uniqueHookCounts === 1

      if (hasScriptOk && customStateOk && hookCountsOk) {
        stablePolls++
        if (stablePolls >= stablePollsNeeded) {
          scriptOk = true
          scriptReason = null
          break
        }
      } else {
        stablePolls = 0
        if (!hasScriptOk) {
          scriptOk = false
          scriptReason = "metadata.hasScript not true on all nodes"
        } else if (!customStateOk) {
          scriptOk = false
          scriptReason = "token.state.customState differs across nodes"
        } else if (!hookCountsOk) {
          scriptOk = false
          scriptReason = "token.callView hookCounts differs across nodes"
        } else {
          scriptOk = false
          scriptReason = "script checks failed"
        }
      }

      await sleep(Math.max(50, scriptPollMs))
    }

    if (stablePolls < stablePollsNeeded && stablePollsNeeded > 0 && scriptOk) {
      scriptOk = false
      scriptReason = "script checks did not stabilize"
    }
  }

  const ok = settle.ok && (holderPointers?.ok ?? true) && (!expectScript || scriptOk)
  const failureReason =
    !settle.ok
      ? "cross-node token state differs (token.get/token.getBalance)"
      : holderPointers && !holderPointers.ok
        ? "cross-node holder pointer mismatch (token.getHolderPointers)"
        : expectScript && !scriptOk
          ? scriptReason ?? "script checks failed"
          : null

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_settle_check`
  const summary = {
    runId: run.runId,
    scenario: "token_settle_check",
    tokenAddress,
    rpcUrls: targets,
    addresses,
    expectScript,
    scriptViewMethod: expectScript ? scriptViewMethod : null,
    blockSkew,
    mempoolDrain,
    settle,
    holderPointers,
    script: expectScript
      ? {
        ok: scriptOk,
        reason: scriptReason,
        stablePolls: scriptStablePollsNeeded,
        perNode: perNodeScript,
      }
      : null,
    ok,
    failureReason,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_settle_check_summary: summary }, null, 2))

  if (!ok) {
    throw new Error(`token_settle_check failed: ${failureReason ?? "unknown"}`)
  }
}

import { envBool, normalizeHexAddress, normalizeRpcUrl, nowMs, sleep } from "./common"
import { nodeCall } from "./rpc"

export type CrossNodeTokenConsistencyReport = {
  ok: boolean
  tokenAddress: string
  rpcUrls: string[]
  addresses: string[]
  attempts: number
  durationMs: number
  perNode: Array<{
    rpcUrl: string
    ok: boolean
    snapshot: null | {
      tokenAddress: string
      metadata: { name: string | null; ticker: string | null; decimals: number | null }
      state: { totalSupply: string | null }
      balances: Record<string, string | null>
    }
    error: any
  }>
}

export type CrossNodeHolderPointersReport = {
  ok: boolean
  tokenAddress: string
  rpcUrls: string[]
  expectedPresent: Record<string, boolean>
  attempts: number
  durationMs: number
  perNode: Array<{
    rpcUrl: string
    ok: boolean
    perAddress: Record<string, { hasPointer: boolean; tokenCount: number | null; raw?: any }>
    error: any
  }>
}

export type CrossNodeTokenGetConsistencyReport = {
  ok: boolean
  tokenAddress: string
  rpcUrls: string[]
  attempts: number
  durationMs: number
  perNode: Array<{
    rpcUrl: string
    ok: boolean
    normalized: null | {
      tokenAddress: string
      accessControl: {
        owner: string | null
        paused: boolean
        entries: Array<{ address: string; permissions: string[] }>
      }
    }
    error: any
  }>
}

function stableBalances(addresses: string[], balances: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const address of addresses.map(normalizeHexAddress).sort()) out[address] = balances[address] ?? null
  return out
}

function snapshotsEqual(left: any, right: any): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeTokenAclEntries(entries: any): Array<{ address: string; permissions: string[] }> {
  const list = Array.isArray(entries) ? entries : []
  const out: Array<{ address: string; permissions: string[] }> = []
  for (const entry of list) {
    const address = normalizeHexAddress(entry?.address ?? "")
    if (!address) continue
    const permissions = [...new Set((Array.isArray(entry?.permissions) ? entry.permissions : []).map((value: any) => String(value)).filter(Boolean))].sort()
    out.push({ address, permissions })
  }
  out.sort((left, right) => left.address.localeCompare(right.address))
  return out
}

export function normalizeTokenPointerEntry(entry: any): string | null {
  if (!entry) return null
  if (typeof entry === "string") return normalizeHexAddress(entry)
  if (typeof entry === "object" && typeof entry.tokenAddress === "string") return normalizeHexAddress(entry.tokenAddress)
  return null
}

export async function fetchTokenSnapshot(rpcUrl: string, tokenAddress: string, addresses: string[]) {
  const normalizedAddresses = addresses.map(normalizeHexAddress)
  const tokenRes = await nodeCall(rpcUrl, "token.getCommitted", { tokenAddress }, `token.getCommitted:${tokenAddress}`)
  if (tokenRes?.result !== 200) return { ok: false, snapshot: null, error: tokenRes }

  const balances: Record<string, string | null> = {}
  for (const address of normalizedAddresses) {
    const balanceRes = await nodeCall(
      rpcUrl,
      "token.getBalanceCommitted",
      { tokenAddress, address },
      `token.getBalanceCommitted:${address}`,
    )
    balances[address] = balanceRes?.result === 200 ? balanceRes?.response?.balance ?? null : null
  }

  return {
    ok: true,
    snapshot: {
      tokenAddress,
      metadata: {
        name: tokenRes?.response?.metadata?.name ?? null,
        ticker: tokenRes?.response?.metadata?.ticker ?? null,
        decimals: typeof tokenRes?.response?.metadata?.decimals === "number" ? tokenRes.response.metadata.decimals : null,
      },
      state: {
        totalSupply: tokenRes?.response?.state?.totalSupply ?? null,
      },
      balances: stableBalances(normalizedAddresses, balances),
    },
    error: null,
  }
}

async function fetchHolderPointers(rpcUrl: string, address: string) {
  const res = await nodeCall(rpcUrl, "token.getHolderPointers", { address }, `token.getHolderPointers:${address}`)
  if (res?.result !== 200) return { ok: false, tokens: [], raw: res }
  const tokens = (Array.isArray(res?.response?.tokens) ? res.response.tokens : [])
    .map(normalizeTokenPointerEntry)
    .filter(Boolean) as string[]
  return { ok: true, tokens, raw: res?.response?.tokens }
}

async function fetchTokenGetNormalized(rpcUrl: string, tokenAddress: string) {
  const tokenRes = await nodeCall(rpcUrl, "token.getCommitted", { tokenAddress }, `token.getCommitted:${tokenAddress}`)
  if (tokenRes?.result !== 200) return { ok: false, normalized: null, error: tokenRes }

  return {
    ok: true,
    normalized: {
      tokenAddress: normalizeHexAddress(tokenAddress),
      accessControl: {
        owner: typeof tokenRes?.response?.accessControl?.owner === "string"
          ? normalizeHexAddress(tokenRes.response.accessControl.owner)
          : null,
        paused: !!tokenRes?.response?.accessControl?.paused,
        entries: normalizeTokenAclEntries(tokenRes?.response?.accessControl?.entries),
      },
    },
    error: null,
  }
}

export async function waitForCrossNodeHolderPointersMatchBalances(params: {
  rpcUrls: string[]
  tokenAddress: string
  expectedPresent: Record<string, boolean>
  timeoutSec: number
  pollMs?: number
}): Promise<CrossNodeHolderPointersReport> {
  const pollMs = Math.max(50, Math.floor(params.pollMs ?? 500))
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  const startedAtMs = nowMs()
  const includeRaw = envBool("HOLDER_POINTER_INCLUDE_RAW", false)
  let attempts = 0

  const rpcUrls = (params.rpcUrls ?? []).map(normalizeRpcUrl)
  const expectedPresent: Record<string, boolean> = {}
  for (const [address, expected] of Object.entries(params.expectedPresent ?? {})) {
    expectedPresent[normalizeHexAddress(address)] = !!expected
  }
  const addresses = Object.keys(expectedPresent).sort()

  async function buildReport() {
    const perNode: CrossNodeHolderPointersReport["perNode"] = []
    for (const rpcUrl of rpcUrls) {
      const perAddress: Record<string, { hasPointer: boolean; tokenCount: number | null; raw?: any }> = {}
      let nodeOk = true
      let nodeError: any = null
      for (const address of addresses) {
        const holder = await fetchHolderPointers(rpcUrl, address)
        if (!holder.ok) {
          nodeOk = false
          nodeError = holder.raw
          perAddress[address] = includeRaw ? { hasPointer: false, tokenCount: null, raw: holder.raw } : { hasPointer: false, tokenCount: null }
          continue
        }
        const hasPointer = holder.tokens.includes(normalizeHexAddress(params.tokenAddress))
        perAddress[address] = includeRaw
          ? { hasPointer, tokenCount: holder.tokens.length, raw: holder.raw }
          : { hasPointer, tokenCount: holder.tokens.length }
      }
      perNode.push({ rpcUrl, ok: nodeOk, perAddress, error: nodeError })
    }
    return perNode
  }

  while (nowMs() < deadlineMs) {
    attempts++
    const perNode = await buildReport()
    const allMatch = perNode.every(node =>
      node.ok && addresses.every(address => (node.perAddress[address]?.hasPointer ?? false) === (expectedPresent[address] ?? false)),
    )
    if (allMatch) {
      return {
        ok: true,
        tokenAddress: normalizeHexAddress(params.tokenAddress),
        rpcUrls,
        expectedPresent,
        attempts,
        durationMs: nowMs() - startedAtMs,
        perNode,
      }
    }
    await sleep(pollMs)
  }

  return {
    ok: false,
    tokenAddress: normalizeHexAddress(params.tokenAddress),
    rpcUrls,
    expectedPresent,
    attempts,
    durationMs: nowMs() - startedAtMs,
    perNode: await buildReport(),
  }
}

export async function waitForCrossNodeTokenConsistency(params: {
  rpcUrls: string[]
  tokenAddress: string
  addresses: string[]
  timeoutSec: number
  pollMs?: number
}): Promise<CrossNodeTokenConsistencyReport> {
  const pollMs = Math.max(50, Math.floor(params.pollMs ?? 500))
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  const startedAtMs = nowMs()
  const rpcUrls = (params.rpcUrls ?? []).map(normalizeRpcUrl)
  const addresses = (params.addresses ?? []).map(normalizeHexAddress).filter(Boolean)
  let attempts = 0

  async function buildReport() {
    const perNode: CrossNodeTokenConsistencyReport["perNode"] = []
    for (const rpcUrl of rpcUrls) {
      const snapshot = await fetchTokenSnapshot(rpcUrl, params.tokenAddress, addresses)
      perNode.push({ rpcUrl, ok: snapshot.ok, snapshot: snapshot.snapshot, error: snapshot.error })
    }
    return perNode
  }

  if (rpcUrls.length === 0) {
    return { ok: false, tokenAddress: params.tokenAddress, rpcUrls, addresses, attempts, durationMs: nowMs() - startedAtMs, perNode: [] }
  }

  while (nowMs() < deadlineMs) {
    attempts++
    const perNode = await buildReport()
    const okNodes = perNode.filter(node => node.ok && node.snapshot)
    if (okNodes.length === perNode.length) {
      const first = okNodes[0]!.snapshot
      if (okNodes.every(node => snapshotsEqual(node.snapshot, first))) {
        return {
          ok: true,
          tokenAddress: params.tokenAddress,
          rpcUrls,
          addresses,
          attempts,
          durationMs: nowMs() - startedAtMs,
          perNode,
        }
      }
    }
    await sleep(pollMs)
  }

  return {
    ok: false,
    tokenAddress: params.tokenAddress,
    rpcUrls,
    addresses,
    attempts,
    durationMs: nowMs() - startedAtMs,
    perNode: await buildReport(),
  }
}

export async function waitForCrossNodeTokenGetConsistency(params: {
  rpcUrls: string[]
  tokenAddress: string
  timeoutSec: number
  pollMs?: number
}): Promise<CrossNodeTokenGetConsistencyReport> {
  const pollMs = Math.max(50, Math.floor(params.pollMs ?? 500))
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  const startedAtMs = nowMs()
  const rpcUrls = (params.rpcUrls ?? []).map(normalizeRpcUrl)
  const tokenAddress = normalizeHexAddress(params.tokenAddress)
  let attempts = 0

  async function buildReport() {
    const perNode: CrossNodeTokenGetConsistencyReport["perNode"] = []
    for (const rpcUrl of rpcUrls) {
      const normalized = await fetchTokenGetNormalized(rpcUrl, tokenAddress)
      perNode.push({ rpcUrl, ok: normalized.ok, normalized: normalized.normalized, error: normalized.error })
    }
    return perNode
  }

  if (rpcUrls.length === 0) {
    return { ok: false, tokenAddress, rpcUrls, attempts, durationMs: nowMs() - startedAtMs, perNode: [] }
  }

  while (nowMs() < deadlineMs) {
    attempts++
    const perNode = await buildReport()
    const okNodes = perNode.filter(node => node.ok && node.normalized)
    if (okNodes.length === perNode.length) {
      const first = okNodes[0]!.normalized
      if (okNodes.every(node => snapshotsEqual(node.normalized, first))) {
        return {
          ok: true,
          tokenAddress,
          rpcUrls,
          attempts,
          durationMs: nowMs() - startedAtMs,
          perNode,
        }
      }
    }
    await sleep(pollMs)
  }

  return {
    ok: false,
    tokenAddress,
    rpcUrls,
    attempts,
    durationMs: nowMs() - startedAtMs,
    perNode: await buildReport(),
  }
}

export type CrossNodeProbeResult<T> = {
  rpcUrl: string
  ok: boolean
  value: T | null
  error: any
}

export async function pollCrossNodeConvergence<T>(params: {
  rpcUrls: string[]
  timeoutSec: number
  pollMs?: number
  fetcher: (rpcUrl: string) => Promise<CrossNodeProbeResult<T>>
  equals?: (a: T, b: T) => boolean
}): Promise<{
  ok: boolean
  attempts: number
  durationMs: number
  perNode: Array<CrossNodeProbeResult<T>>
}> {
  const pollMs = Math.max(50, Math.floor(params.pollMs ?? 500))
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  const startedAtMs = nowMs()
  let attempts = 0
  const equals = params.equals ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b))

  while (nowMs() < deadlineMs) {
    attempts++
    const perNode = await Promise.all(params.rpcUrls.map(url => params.fetcher(url)))
    const okNodes = perNode.filter(node => node.ok && node.value !== null)
    if (okNodes.length === perNode.length) {
      const first = okNodes[0]!.value as T
      if (okNodes.every(node => equals(node.value as T, first))) {
        return { ok: true, attempts, durationMs: nowMs() - startedAtMs, perNode }
      }
    }
    await sleep(pollMs)
  }

  const perNode = await Promise.all(params.rpcUrls.map(url => params.fetcher(url)))
  return { ok: false, attempts, durationMs: nowMs() - startedAtMs, perNode }
}

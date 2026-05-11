import { envInt, normalizeRpcUrl, sleep } from "../../framework/common"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import { getTokenTargets, waitForRpcReady, waitForTxReady } from "../../token_shared"

export function getConsensusTargets(): string[] {
  return getTokenTargets().map(normalizeRpcUrl)
}

export async function waitForConsensusTargets(rpcUrls: string[], requireTx = false) {
  await Promise.all(rpcUrls.map(url => waitForRpcReady(url, envInt("WAIT_FOR_RPC_SEC", 120))))
  if (requireTx) {
    await Promise.all(rpcUrls.map(url => waitForTxReady(url, envInt("WAIT_FOR_TX_SEC", 120))))
  }
}

export async function getLastBlockNumber(rpcUrl: string, muid: string): Promise<number | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, muid, NO_FALLBACKS)
  const n = res?.response
  if (typeof n === "number" && Number.isFinite(n)) return n
  if (typeof n === "string") {
    const parsed = Number.parseInt(n, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export async function getAddressNonceViaRpc(rpcUrl: string, address: string, muid: string): Promise<number | null> {
  const res = await nodeCall(rpcUrl, "getAddressNonce", { address }, muid, NO_FALLBACKS)
  const n = res?.response
  if (typeof n === "number" && Number.isFinite(n)) return n
  if (typeof n === "string") {
    const parsed = Number.parseInt(n, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export async function getTxByHashViaRpc(rpcUrl: string, hash: string, muid: string): Promise<any> {
  const res = await nodeCall(rpcUrl, "getTxByHash", { hash }, muid, NO_FALLBACKS)
  return res
}

export async function waitForBlockAdvance(params: {
  rpcUrls: string[]
  requiredDelta: number
  timeoutSec: number
  pollMs: number
}) {
  const start: Record<string, number | null> = {}
  for (const rpcUrl of params.rpcUrls) {
    start[rpcUrl] = await getLastBlockNumber(rpcUrl, `consensus:block:start:${rpcUrl}`)
  }

  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  while (Date.now() < deadlineMs) {
    const current: Record<string, number | null> = {}
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      current[rpcUrl] = await getLastBlockNumber(rpcUrl, `consensus:block:poll:${rpcUrl}`)
      const base = start[rpcUrl]
      const next = current[rpcUrl]
      if (!(typeof base === "number" && typeof next === "number" && next >= base + params.requiredDelta)) {
        allOk = false
      }
    }
    if (allOk) return { ok: true, start, end: current }
    await sleep(Math.max(100, params.pollMs))
  }

  const end: Record<string, number | null> = {}
  for (const rpcUrl of params.rpcUrls) {
    end[rpcUrl] = await getLastBlockNumber(rpcUrl, `consensus:block:end:${rpcUrl}`)
  }
  return { ok: false, start, end }
}

export async function waitForNonceAdvance(params: {
  rpcUrls: string[]
  address: string
  expectedAtLeast: number
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  while (Date.now() < deadlineMs) {
    const current: Record<string, number | null> = {}
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      current[rpcUrl] = await getAddressNonceViaRpc(rpcUrl, params.address, `consensus:nonce:${rpcUrl}:${params.address}`)
      if (!(typeof current[rpcUrl] === "number" && current[rpcUrl]! >= params.expectedAtLeast)) {
        allOk = false
      }
    }
    if (allOk) return { ok: true, observed: current }
    await sleep(Math.max(100, params.pollMs))
  }

  const observed: Record<string, number | null> = {}
  for (const rpcUrl of params.rpcUrls) {
    observed[rpcUrl] = await getAddressNonceViaRpc(rpcUrl, params.address, `consensus:nonce:end:${rpcUrl}:${params.address}`)
  }
  return { ok: false, observed }
}

export async function waitForTxByHash(params: {
  rpcUrls: string[]
  hash: string
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  while (Date.now() < deadlineMs) {
    const observed: Record<string, any> = {}
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      observed[rpcUrl] = await getTxByHashViaRpc(rpcUrl, params.hash, `consensus:tx:${rpcUrl}:${params.hash}`)
      if (observed[rpcUrl]?.result !== 200 || !observed[rpcUrl]?.response) {
        allOk = false
      }
    }
    if (allOk) return { ok: true, observed }
    await sleep(Math.max(100, params.pollMs))
  }

  const observed: Record<string, any> = {}
  for (const rpcUrl of params.rpcUrls) {
    observed[rpcUrl] = await getTxByHashViaRpc(rpcUrl, params.hash, `consensus:tx:end:${rpcUrl}:${params.hash}`)
  }
  return { ok: false, observed }
}


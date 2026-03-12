import { envInt, normalizeRpcUrl, nowMs, sleep } from "./common"
import { NetworkError, RpcTimeoutError, serializeLoadgenError } from "./errors"

export type CommittedFallbackMap = Record<string, string>
export const NO_FALLBACKS: CommittedFallbackMap = {}

export const TOKEN_COMMITTED_FALLBACKS: CommittedFallbackMap = {
  "token.get": "token.getCommitted",
  "token.getBalance": "token.getBalanceCommitted",
  "token.callView": "token.callViewCommitted",
}

export type RpcPostOptions = {
  headers?: Record<string, string>
}

function invertFallbackMap(map: CommittedFallbackMap): CommittedFallbackMap {
  const out: CommittedFallbackMap = {}
  for (const [from, to] of Object.entries(map)) out[to] = from
  return out
}

export async function rpcPost(
  rpcUrl: string,
  body: unknown,
  options: RpcPostOptions = {},
): Promise<{ ok: boolean; status: number; json: any }> {
  const url = normalizeRpcUrl(rpcUrl)
  const timeoutMs = envInt("NODECALL_FETCH_TIMEOUT_MS", 8000)
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const json = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, json }
  } catch (error: any) {
    const typedError = error?.name === "AbortError"
      ? new RpcTimeoutError(url, "rpcPost", timeoutMs)
      : new NetworkError(error instanceof Error ? error.message : String(error), { url, body }, true)
    return {
      ok: false,
      status: 0,
      json: {
        result: 599,
        response: `rpcPost failed: ${typedError.message}`,
        require_reply: false,
        extra: {
          error: serializeLoadgenError(typedError),
        },
      },
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function nodeCallExact(rpcUrl: string, message: string, data: any, muid = "loadgen"): Promise<any> {
  const payload = { method: "nodeCall", params: [{ message, data, muid }] }
  const { ok, json } = await rpcPost(rpcUrl, payload)
  if (!ok) return json
  return json
}

export async function nodeCall(
  rpcUrl: string,
  message: string,
  data: any,
  muid = "loadgen",
  fallbackMap: CommittedFallbackMap = TOKEN_COMMITTED_FALLBACKS,
): Promise<any> {
  const toLegacy = invertFallbackMap(fallbackMap)
  const primaryMessage = fallbackMap[message] ?? message
  const fallbackMessage = toLegacy[primaryMessage] ?? primaryMessage

  async function postOnce(msg: string) {
    const payload = { method: "nodeCall", params: [{ message: msg, data, muid }] }
    const { ok, json } = await rpcPost(rpcUrl, payload)
    if (!ok) return json
    return json
  }

  const isCommittedRead = Object.values(fallbackMap).includes(primaryMessage)
  const inFluxTimeoutMs = isCommittedRead ? envInt("NODECALL_IN_FLUX_TIMEOUT_MS", 2000) : 0

  async function postWithStateInFluxRetry(msg: string) {
    if (!isCommittedRead || inFluxTimeoutMs <= 0) return await postOnce(msg)
    const deadlineMs = nowMs() + inFluxTimeoutMs
    let attempt = 0
    while (true) {
      const res = await postOnce(msg)
      const inFlux = res?.result === 409 && res?.response?.error === "STATE_IN_FLUX"
      if (!inFlux) return res
      if (nowMs() >= deadlineMs) return res
      attempt++
      const backoffMs = Math.min(2000, 50 + attempt * 75)
      await sleep(backoffMs)
    }
  }

  const first = await postWithStateInFluxRetry(primaryMessage)
  const unknown =
    typeof first?.response === "string" &&
    (first.response.includes("Unknown message") || first.response.includes("unknown message"))
  if (unknown && fallbackMessage !== primaryMessage) {
    return await postWithStateInFluxRetry(fallbackMessage)
  }
  return first
}

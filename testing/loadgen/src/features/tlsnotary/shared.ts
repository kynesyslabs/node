import { envInt, normalizeRpcUrl, splitCsv } from "../../framework/common"

export type TlsNotaryJsonResponse = {
  status: number
  ok: boolean
  json: any
  text: string
}

export type TlsNotaryHealthProbe = {
  rpcUrl: string
  reachable: boolean
  health: TlsNotaryJsonResponse | null
  info: TlsNotaryJsonResponse | null
  error: string | null
}

export function getTlsNotaryTargets(): string[] {
  const explicit = splitCsv(process.env.TARGETS)
  const targets = explicit.length > 0
    ? explicit
    : ["http://localhost:53551", "http://localhost:53553", "http://localhost:53555", "http://localhost:53557"]
  return targets.map(normalizeRpcUrl)
}

export async function fetchTlsNotaryJson(
  rpcUrl: string,
  route: string,
  init?: RequestInit,
): Promise<TlsNotaryJsonResponse> {
  const controller = new AbortController()
  const timeoutMs = envInt("TLSNOTARY_HTTP_TIMEOUT_MS", 5000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(new URL(route, rpcUrl).toString(), {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
    const text = await response.text()
    let json: any = null
    try {
      json = text.length > 0 ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return {
      status: response.status,
      ok: response.ok,
      json,
      text,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeTlsNotaryRoutes(rpcUrl: string): Promise<TlsNotaryHealthProbe> {
  try {
    const health = await fetchTlsNotaryJson(rpcUrl, "/tlsnotary/health", { method: "GET" })
    const info = await fetchTlsNotaryJson(rpcUrl, "/tlsnotary/info", { method: "GET" })
    return {
      rpcUrl,
      reachable: true,
      health,
      info,
      error: null,
    }
  } catch (error) {
    return {
      rpcUrl,
      reachable: false,
      health: null,
      info: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}


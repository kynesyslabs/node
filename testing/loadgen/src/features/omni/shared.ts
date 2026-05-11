import { envInt, splitCsv } from "../../framework/common"
import { getTokenTargets } from "../../token_shared"

export function normalizeOmniTarget(value: string): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error("empty Omni target")
  if (/^(tcp|tls|tcps):\/\//i.test(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return httpRpcToOmni(trimmed)
  throw new Error(`Unsupported Omni target: ${value}`)
}

export function httpRpcToOmni(rpcUrl: string): string {
  const parsed = new URL(rpcUrl)
  const offset = envInt("OMNI_PORT_OFFSET", 1)
  const port = Number(parsed.port || (parsed.protocol === "https:" ? "443" : "80"))
  if (!Number.isFinite(port)) throw new Error(`Cannot derive Omni port from ${rpcUrl}`)
  return `tcp://${parsed.hostname}:${port + offset}`
}

export function getOmniTargets(): string[] {
  const explicit = splitCsv(process.env.OMNI_TARGETS)
  if (explicit.length > 0) return explicit.map(normalizeOmniTarget)
  return getTokenTargets().map(httpRpcToOmni)
}


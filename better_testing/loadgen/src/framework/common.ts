export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

export function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

export function envBool(name: string, fallback: boolean): boolean {
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

export function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

export function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

export function normalizeWsUrl(url: string): string {
  return (url ?? "").trim().replace(/\/+$/, "")
}

export function nowMs(): number {
  return Date.now()
}

export function unique(values: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

export function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

const loggedNonCriticalKeys = new Set<string>()

function stringifyLogDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return ""
  try {
    return ` ${JSON.stringify(details)}`
  } catch {
    return ""
  }
}

export function logNonCriticalError(
  context: string,
  error: unknown,
  details?: Record<string, unknown>,
) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[loadgen] Non-critical error in ${context}: ${message}${stringifyLogDetails(details)}`)
}

export function logNonCriticalErrorOnce(
  key: string,
  context: string,
  error: unknown,
  details?: Record<string, unknown>,
) {
  if (loggedNonCriticalKeys.has(key)) return
  loggedNonCriticalKeys.add(key)
  logNonCriticalError(context, error, details)
}

export function installGlobalFetchTimeout(envName = "FETCH_TIMEOUT_MS"): number {
  const fetchTimeoutMs = Math.max(0, envInt(envName, 0))
  if (fetchTimeoutMs <= 0) return 0

  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: any, init: any = {}) => {
    if (init?.signal) return originalFetch(input, init)
    const controller = new AbortController()
    const timeout: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), fetchTimeoutMs)
    try {
      return await originalFetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }) as typeof fetch

  return fetchTimeoutMs
}

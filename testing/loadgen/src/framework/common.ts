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

const LOG_ESCAPES: Record<string, string> = { "\n": String.raw`\n`, "\r": String.raw`\r`, "\t": String.raw`\t` }

// Peer- or node-supplied text can hold newlines, terminal escapes or bidi overrides
// that forge or hide log lines: show C0/C1 controls, DEL, the line and paragraph
// separators (U+2028, U+2029) and bidi controls (U+061C, U+200E, U+200F, U+202A-U+202E,
// U+2066-U+2069) as escapes.
// Every matched character is a single UTF-16 code unit, so codePointAt(0) is its code.
export function escapeControlChars(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u{061c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu,
    char => LOG_ESCAPES[char] ?? String.raw`\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`)
}

// Peer- or node-supplied text (RPC amounts, error messages) has no size limit, so each
// log field and the whole record are cut. The message cap keeps a truncatedError copy
// (500 characters plus its length marker) whole.
const LOG_MESSAGE_MAX_CHARS = 1_000
const LOG_FIELD_MAX_CHARS = 500
const LOG_RECORD_MAX_CHARS = 2_000

// `text` cut to `maxChars` plus a "…(N chars)" marker with the full length.
function cutText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…(${text.length} chars)` : text
}

// cutText for text that is escaped here: escapes can make the text up to six times
// longer, so whole escapes are kept up to `maxChars` and the marker gives the original
// length. Later cuts and escaping then leave the copy and its marker as they are.
function cutEscaped(text: string, maxChars: number): string {
  let shown = ""
  for (const char of text.slice(0, maxChars)) {
    const escaped = escapeControlChars(char)
    if (shown.length + escaped.length > maxChars) return `${shown}…(${text.length} chars)`
    shown += escaped
  }
  return text.length > maxChars ? `${shown}…(${text.length} chars)` : shown
}

type Printable = string | number | bigint | boolean | symbol | null | undefined | { toString(): string }

// False only for an object whose toString is Object's own, which String() shows as "[object Object]".
function isPrintable(value: unknown): value is Printable {
  return typeof value !== "object" || value === null || value.toString !== Object.prototype.toString
}

const PREVIEW_MAX_ITEMS = 20
const PREVIEW_MAX_STRING_CHARS = 80

function previewType(value: unknown): string {
  if (value === null) return "null"
  return Array.isArray(value) ? "array" : typeof value
}

// A string's first 80 characters (sliced before quoting) plus its length when longer.
function previewString(text: string): string {
  const shown = JSON.stringify(text.slice(0, PREVIEW_MAX_STRING_CHARS))
  return text.length > PREVIEW_MAX_STRING_CHARS ? `${shown}…(${text.length} chars)` : shown
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return previewString(value)
  const shown = value == null || typeof value === "number" || typeof value === "boolean"
  return shown ? String(value) : previewType(value)
}

// Bounded, JSON-like preview that never serializes or walks nested values: an array's
// length and its first 20 item types; an object's first 20 own keys (cut like strings),
// each with a primitive value, a cut string, or the value's type, then "…(more keys)".
function previewObject(value: object): string {
  if (Array.isArray(value)) {
    const types: string[] = []
    for (let i = 0; i < Math.min(value.length, PREVIEW_MAX_ITEMS); i++) types.push(previewType(value[i]))
    return `array(${value.length}) [${types.join(",")}${value.length > PREVIEW_MAX_ITEMS ? ",…" : ""}]`
  }
  const fields: string[] = []
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    if (fields.length === PREVIEW_MAX_ITEMS) {
      fields.push("…(more keys)")
      break
    }
    fields.push(`${previewString(key)}:${previewValue((value as Record<string, unknown>)[key])}`)
  }
  return `{${fields.join(",")}}`
}

// Log text for a value: String(), or a bounded preview for an array or an object
// String() would show as "[object Object]". String() and getters can throw (e.g. on
// RPC JSON {"toString":null}); log the type instead. Callers cut long strings.
export function textOrType(value: unknown): string {
  try {
    return Array.isArray(value) || !isPrintable(value) ? previewObject(value as object) : String(value)
  } catch {
    return typeof value
  }
}

function logFieldText(value: unknown, cut: (text: string) => string): string {
  return cut(textOrType(value))
}

// Numbers, booleans and null stay JSON values; strings, bigints and nested values
// become cut text, so JSON.stringify sees only bounded, serializable fields.
function stringifyLogDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return ""
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    const keepAsJson = value == null || typeof value === "number" || typeof value === "boolean"
    fields[key] = keepAsJson ? value : logFieldText(value, text => cutText(text, LOG_FIELD_MAX_CHARS))
  }
  return ` ${JSON.stringify(fields)}`
}

// One record per call: the message escaped and cut (so its marker stays within the
// record cap), each details value cut, control characters escaped across the whole
// line (JSON.stringify leaves DEL, C1 and bidi controls raw), then the line cut.
export function logNonCriticalError(
  context: string,
  error: unknown,
  details?: Record<string, unknown>,
) {
  const message = logFieldText(error instanceof Error ? error.message : error,
    text => cutEscaped(text, LOG_MESSAGE_MAX_CHARS))
  const line = `[loadgen] Non-critical error in ${context}: ${message}${stringifyLogDetails(details)}`
  console.error(cutText(escapeControlChars(line), LOG_RECORD_MAX_CHARS))
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

const nonCriticalKeyBudgetUsed = new Map<string, number>()

// logNonCriticalErrorOnce for keys built from peer-supplied text, which can vary
// without limit: at most `budget` distinct keys are kept and logged per context.
// The first new key past the budget logs one line instead; later ones log nothing.
export function logNonCriticalErrorOnceCapped(
  context: string,
  budget: number,
  key: string,
  error: unknown,
  details?: Record<string, unknown>,
) {
  const fullKey = `${context}:${key}`
  if (loggedNonCriticalKeys.has(fullKey)) return
  const used = nonCriticalKeyBudgetUsed.get(context) ?? 0
  if (used > budget) return
  nonCriticalKeyBudgetUsed.set(context, used + 1)
  if (used < budget) {
    logNonCriticalErrorOnce(fullKey, context, error, details)
    return
  }
  logNonCriticalError(context, `${budget} distinct errors logged; further distinct errors are counted but not logged`)
}

export function loggedNonCriticalKeyCount(): number {
  return loggedNonCriticalKeys.size
}

function errorName(error: unknown): string {
  return textOrType((error as { name?: unknown } | null | undefined)?.name ?? typeof error)
}

// Error text from a peer has no size limit (e.g. a confirm rejection message): a new
// Error with the same name and the message with control characters escaped, cut to
// `maxChars` plus a "…(N chars)" marker with the original length. Key and log this copy,
// not the original, so neither scans nor prints the full text.
export function truncatedError(error: unknown, maxChars = 500): Error {
  const message = textOrType(error instanceof Error ? error.message : error)
  const cut = new Error(cutEscaped(message, maxChars))
  cut.name = errorName(error)
  return cut
}

// Once-log key that groups errors differing only in nonces, hashes or ids: the
// error name plus the message with hex runs and digits replaced, capped at 200 chars.
export function errorShapeKey(error: unknown): string {
  const name = errorName(error)
  const message = error instanceof Error ? error.message : textOrType(error)
  const shape = message.replace(/0x[0-9a-f]+|\b(?=[0-9a-f]*\d)[0-9a-f]+\b|\d+/gi, "#")
  return `${name}:${shape}`.slice(0, 200)
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

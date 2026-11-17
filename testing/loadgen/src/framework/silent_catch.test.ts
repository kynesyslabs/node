/**
 * A loadgen catch block that neither logs nor rethrows hides the failure it
 * caught (#708). Every `catch {` without a binding, and every `.catch(...)` arrow
 * that does not use its error (`() => {}`, `() => null`, `() => ""`, `_ => 0`, ...)
 * and is not on `.json()`, must log through the framework helpers or throw.
 * The values those log calls carry go through `textOrType`, not a bare `String()`.
 */

import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const SRC_ROOT = path.resolve(import.meta.dir, "..")

// Binding-less catches that report the failure another way. Counts are exact so
// a new silent catch in one of these files still fails the test.
const REPORTED_ELSEWHERE: Record<string, number> = {
  // The logger itself cannot log its own failure: its String() guard (textOrType) and
  // its guard on reading the logged error's name and message (readOr).
  "framework/common.ts": 2,
  // Falls back to String(value), which is still the diagnostic text.
  "features/gcr/gcr_identity_loadgen.ts": 1,
  // Returns null and the caller lists the holder under `invalid`.
  "token_invariants_known_holders.ts": 1,
  // The one catch is inside a token-script source string that runs in the node's script VM.
  "token_script_rejects.ts": 1,
}

// Same: every catch in this file is inside a token-script source string.
const SKIP_FILES = new Set(["token_script_complex_policy_shared.ts"])

function listSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSources(full))
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full)
  }
  return out
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

const LOGS_OR_THROWS = /logNonCritical\w*\(|console\.\w+\(|\bthrow\b/

// Text from `start` up to the bracket that closes the one opened just before it.
function enclosed(source: string, start: number, open: string, close: string): string {
  let depth = 1
  let i = start
  while (i < source.length && depth > 0) {
    if (source[i] === open) depth++
    else if (source[i] === close) depth--
    i++
  }
  return source.slice(start, i - 1)
}

function silentCatches(source: string): number[] {
  const lines: number[] = []
  const bare = /catch\s*\{/g
  let match: RegExpExecArray | null
  while ((match = bare.exec(source))) {
    const body = stripComments(enclosed(source, match.index + match[0].length, "{", "}"))
    if (!LOGS_OR_THROWS.test(body)) {
      lines.push(source.slice(0, match.index).split("\n").length)
    }
  }
  // A `.catch` arrow that neither logs, throws nor uses its error drops the
  // rejection, whatever it returns. Allowed only on `.json()`, where the caller
  // checks the null for a non-JSON body.
  const dotCatch = /\.catch\(/g
  while ((match = dotCatch.exec(source))) {
    const handler = stripComments(enclosed(source, match.index + match[0].length, "(", ")"))
    const arrow = /^\s*(?:\(\s*(\w*)\s*(?::[^)]*)?\)|(\w+))\s*=>([\s\S]*)$/.exec(handler)
    if (!arrow) continue
    const param = arrow[1] || arrow[2]
    const body = arrow[3]
    if (LOGS_OR_THROWS.test(body) || (param && new RegExp(`\\b${param}\\b`).test(body))) continue
    if (/\.json\(\)\s*$/.test(source.slice(Math.max(0, match.index - 40), match.index))) continue
    lines.push(source.slice(0, match.index).split("\n").length)
  }
  return lines
}

// Lines of logNonCritical*( calls whose arguments convert a value with a bare
// String(), which throws on values such as RPC JSON {"toString":null} and shows a
// plain object as "[object Object]". Log values go through textOrType instead.
function rawStringInLogCalls(source: string): number[] {
  const lines: number[] = []
  const call = /logNonCritical\w*\(/g
  let match: RegExpExecArray | null
  while ((match = call.exec(source))) {
    const args = stripComments(enclosed(source, match.index + match[0].length, "(", ")"))
    if (/(?:^|[^\w.])String\(/.test(args)) lines.push(source.slice(0, match.index).split("\n").length)
  }
  return lines
}

describe("loadgen log calls", () => {
  it("format values with textOrType, not a bare String()", () => {
    const offenders: string[] = []
    for (const file of listSources(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/")
      const found = rawStringInLogCalls(fs.readFileSync(file, "utf8"))
      if (found.length > 0) offenders.push(`${rel}:${found.join(",")}`)
    }
    expect(offenders).toEqual([])
  })

  it("flag String() in a log call and accept textOrType", () => {
    expect(rawStringInLogCalls("logNonCriticalErrorOnce(\"k\", \"ctx\", error, { value: String(value).slice(0, 80) })")).toEqual([1])
    expect(rawStringInLogCalls("logNonCriticalError(\"ctx\",\n  error,\n  { value: String(value) },\n)")).toEqual([1])
    expect(rawStringInLogCalls("logNonCriticalErrorOnce(\"k\", \"ctx\", error, { value: textOrType(value).slice(0, 80) })")).toEqual([])
    expect(rawStringInLogCalls("logNonCriticalError(\"ctx\", error, { id: id.toString(), raw: String.raw`\\n` })")).toEqual([])
  })
})

describe("loadgen catch blocks", () => {
  it("do not swallow errors without logging", () => {
    const offenders: string[] = []
    for (const file of listSources(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join("/")
      if (SKIP_FILES.has(rel)) continue
      const found = silentCatches(fs.readFileSync(file, "utf8"))
      const allowed = REPORTED_ELSEWHERE[rel] ?? 0
      if (found.length > allowed) offenders.push(`${rel}:${found.join(",")}`)
    }
    expect(offenders).toEqual([])
  })

  it("flag a .catch that drops its error for a constant", () => {
    for (const snippet of [
      "const text = await read().catch(() => \"\")",
      "const count = await read().catch(() => 0)",
      "const ok = await read().catch((_error) => false)",
      "const value = await read().catch(error => undefined)",
      "const info = await read().catch(() => ({}))",
      "const list = await read().catch(() => [])",
      "const row = await read().catch(() => null)",
      "await close().catch(() => {})",
      "await close().catch(() => {\n  // ignore\n})",
    ]) {
      expect({ snippet, lines: silentCatches(snippet) }).toEqual({ snippet, lines: [1] })
    }
  })

  it("accept a .catch that logs, throws or keeps its error, and .json() fallbacks", () => {
    for (const snippet of [
      "const text = await read().catch(error => {\n  logNonCriticalError(\"read\", error, { file })\n  return \"\"\n})",
      "await close().catch(error => logNonCriticalError(\"close\", error, { target }))",
      "const res = await call().catch((error: unknown) => ({ result: 599, extra: String(error) }))",
      "await confirm().catch((err: any) => {\n  counters.error++\n  throw err\n})",
      "const json = await res.json().catch(() => null)",
    ]) {
      expect({ snippet, lines: silentCatches(snippet) }).toEqual({ snippet, lines: [] })
    }
  })
})

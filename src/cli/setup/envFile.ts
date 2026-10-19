import * as fs from "node:fs"

// Plain scans, not regular expressions: an env file is operator input and a
// pattern with repeated whitespace or a lazy wildcard over a very long hostile
// line goes super-linear where a single pass stays linear.
const isSpace = (ch: string): boolean => /\s/.test(ch)

function skipSpace(text: string, from: number): number {
    let i = from
    while (i < text.length && isSpace(text[i])) i++
    return i
}

function isNameStart(ch: string): boolean {
    return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_"
}

function isNameChar(ch: string): boolean {
    return isNameStart(ch) || (ch >= "0" && ch <= "9")
}

interface Assignment {
    /** Indentation and a leading `export`, exactly as written. */
    prefix: string
    key: string
    /** Everything after the `=`. */
    rest: string
}

/** `  export KEY = value` split into its parts, or undefined when the line is not an assignment. */
function readName(line: string, from: number): { key: string; end: number } | undefined {
    if (from >= line.length || !isNameStart(line[from])) return undefined
    let end = from + 1
    while (end < line.length && isNameChar(line[end])) end++
    return { key: line.slice(from, end), end }
}

function parseAssignment(line: string): Assignment | undefined {
    const start = skipSpace(line, 0)
    // `export` only counts as a prefix when a name follows it; otherwise it is
    // itself the key (export=1).
    const afterExport = line.startsWith("export", start) && isSpace(line[start + 6] ?? "")
        ? skipSpace(line, start + 6)
        : -1
    for (const nameAt of afterExport === -1 ? [start] : [afterExport, start]) {
        const name = readName(line, nameAt)
        if (!name) continue
        const eq = skipSpace(line, name.end)
        if (line[eq] !== "=") continue
        return { prefix: line.slice(0, nameAt), key: name.key, rest: line.slice(eq + 1) }
    }
    return undefined
}

/** The part of a value before a closing quote or a comment, as dotenv and Bun read it. */
function readValue(rest: string): string {
    const value = rest.trim()
    // A quoted value ends at its closing quote; anything after is a comment. An
    // unquoted one ends at the first `#`, with or without a space before it.
    const close = value.length > 0 && "\"'`".includes(value[0]) ? value.indexOf(value[0], 1) : -1
    if (close > 0) return value.slice(1, close)
    const hash = value.indexOf("#")
    return hash === -1 ? value : value.slice(0, hash).trimEnd()
}

export function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
        const a = parseAssignment(line)
        if (a) out[a.key] = readValue(a.rest)
    }
    return out
}

export function readEnvFile(path: string): Record<string, string> {
    try {
        return parseEnv(fs.readFileSync(path, "utf8"))
    } catch {
        return {}
    }
}

/**
 * Like readEnvFile, but a file that exists and cannot be read (a directory, no
 * permission) is an error rather than "empty": a report built on it would say
 * everything is fine without having looked.
 */
export function readEnvFileStrict(path: string): Record<string, string> {
    try {
        return parseEnv(fs.readFileSync(path, "utf8"))
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}
        throw e
    }
}

export interface EnvChange {
    key: string
    from?: string
    to: string
}

export interface EnvDiff {
    /** Keys that are not set yet (or only present as a commented example). */
    add: EnvChange[]
    /** Keys already holding the wanted value. */
    same: string[]
    /** Keys set to a different value; replacing them needs consent. */
    conflict: EnvChange[]
}

export function diffEnv(
    existing: Record<string, string>,
    wanted: Record<string, string>,
): EnvDiff {
    const diff: EnvDiff = { add: [], same: [], conflict: [] }
    for (const [key, to] of Object.entries(wanted)) {
        const from = existing[key]
        if (from === undefined) diff.add.push({ key, to })
        else if (from === to) diff.same.push(key)
        else diff.conflict.push({ key, from, to })
    }
    return diff
}

const SECTION_TITLE = "# --- L2PS / ZK (written by `bun run setup`) ---"

/**
 * What an edited line keeps from the original: its indentation, a leading
 * `export` (which a shell that sources the file needs), and a comment after
 * the value.
 */
function trailingComment(rest: string): string {
    const value = rest.trimStart()
    const close = value.length > 0 && "\"'`".includes(value[0]) ? value.indexOf(value[0], 1) : -1
    let after: string
    if (close > 0) {
        after = value.slice(close + 1)
    } else {
        const hash = value.indexOf("#")
        if (hash === -1) return ""
        let from = hash
        while (from > 0 && isSpace(value[from - 1])) from--
        after = value.slice(from)
    }
    return after.trimStart().startsWith("#") ? after : ""
}

function rewriteActiveLine(a: Assignment, value: string): string {
    return `${a.prefix}${a.key}=${value}${trailingComment(a.rest)}`
}

/** A commented example `#  KEY = ...`, without any pattern that backtracks. */
function isCommentedExample(line: string, key: string): boolean {
    const hash = skipSpace(line, 0)
    if (line[hash] !== "#") return false
    const at = skipSpace(line, hash + 1)
    if (!line.startsWith(key, at)) return false
    return line[skipSpace(line, at + key.length)] === "="
}

/**
 * Sets the given keys in an env file's text, touching nothing else. An active
 * `KEY=` line is edited in place (the last one, because dotenv lets the last
 * duplicate win), a commented `#KEY=` example is switched on, anything new goes
 * to a labelled block at the end. CRLF files stay CRLF.
 */
export function applyEnvChanges(
    text: string,
    changes: Record<string, string>,
): string {
    const crlf = text.includes("\r\n")
    const cr = crlf ? "\r" : ""
    const lines = text.length > 0 ? text.split("\n") : []
    const appended: string[] = []
    const lastIndex = (matches: (line: string) => boolean) => {
        for (let i = lines.length - 1; i >= 0; i--) if (matches(lines[i])) return i
        return -1
    }
    const activeOf = (key: string) => (line: string) => parseAssignment(line)?.key === key
    for (const [key, value] of Object.entries(changes)) {
        let idx = lastIndex(activeOf(key))
        const wasActive = idx !== -1
        if (!wasActive) idx = lastIndex(line => isCommentedExample(line, key))
        if (idx === -1) {
            appended.push(`${key}=${value}${cr}`)
            continue
        }
        const body = lines[idx].endsWith("\r") ? lines[idx].slice(0, -1) : lines[idx]
        const assignment = parseAssignment(body)
        const edited = wasActive && assignment ? rewriteActiveLine(assignment, value) : `${key}=${value}`
        lines[idx] = `${edited}${cr}`
    }
    if (appended.length > 0) {
        // Drop the empty piece a trailing newline leaves, then restore it last.
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
        if (lines.length > 0) lines.push(cr)
        lines.push(`${SECTION_TITLE}${cr}`, ...appended, "")
    }
    const out = lines.join("\n")
    return out.endsWith("\n") || out === "" ? out : out + "\n"
}

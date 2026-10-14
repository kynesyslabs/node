import * as fs from "node:fs"

export function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
        if (!m) continue
        let value = m[2].trim()
        // A quoted value ends at its closing quote; anything after is a comment.
        const quoted = /^(["'])(.*?)\1/.exec(value)
        if (quoted) value = quoted[2]
        else value = value.replace(/\s+#.*$/, "")
        out[m[1]] = value
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
    const lastIndex = (re: RegExp) => {
        for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i
        return -1
    }
    for (const [key, value] of Object.entries(changes)) {
        const active = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
        const commented = new RegExp(`^\\s*#\\s*${key}\\s*=`)
        let idx = lastIndex(active)
        if (idx === -1) idx = lastIndex(commented)
        if (idx !== -1) lines[idx] = `${key}=${value}${cr}`
        else appended.push(`${key}=${value}${cr}`)
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

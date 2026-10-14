import * as fs from "node:fs"

export function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
        if (!m) continue
        let value = m[2].trim()
        const quote = value[0]
        if ((quote === "\"" || quote === "'") && value.endsWith(quote) && value.length >= 2) {
            value = value.slice(1, -1)
        } else {
            value = value.replace(/\s+#.*$/, "")
        }
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
 * `KEY=` line is edited in place, a commented `#KEY=` example is switched on,
 * anything new goes to a labelled block at the end.
 */
export function applyEnvChanges(
    text: string,
    changes: Record<string, string>,
): string {
    const lines = text.length > 0 ? text.split("\n") : []
    const appended: string[] = []
    for (const [key, value] of Object.entries(changes)) {
        const active = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
        const commented = new RegExp(`^\\s*#\\s*${key}\\s*=`)
        let idx = lines.findIndex(l => active.test(l))
        if (idx === -1) idx = lines.findIndex(l => commented.test(l))
        if (idx !== -1) lines[idx] = `${key}=${value}`
        else appended.push(`${key}=${value}`)
    }
    if (appended.length > 0) {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("")
        lines.push(SECTION_TITLE, ...appended, "")
    }
    const out = lines.join("\n")
    return out.endsWith("\n") || out === "" ? out : out + "\n"
}

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { L2PS_DIR } from "./context"
import { isInsideDir } from "./files"
import {
    displaySafe,
    hexLengthWarning,
    IV_BYTES,
    KEY_BYTES,
    parseHex,
    SUBNET_UID_PATTERN,
} from "./validate"

export type SubnetState =
    | "ok"
    | "disabled"
    | "invalid"
    | "missing-files"
    | "placeholder"

export interface SubnetStatus {
    uid: string
    dir: string
    state: SubnetState
    problems: string[]
    warnings: string[]
}

function readJson(file: string): { value?: any; error?: string } {
    try {
        return { value: JSON.parse(fs.readFileSync(file, "utf8")) }
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
    }
}

/**
 * Mirrors what ParallelNetworks.loadL2PSInternal demands, so a subnet this
 * reports as ok is one the node will actually load. What the loader never
 * checks (id inside config.json, key and IV lengths, key file mode) is only a
 * warning here. Never throws: an unreadable file is reported as a problem.
 */
export function inspectSubnet(root: string, uid: string): SubnetStatus {
    try {
        return inspectSubnetUnsafe(root, uid)
    } catch (e) {
        return {
            uid,
            dir: path.join(root, L2PS_DIR, uid),
            state: "invalid",
            problems: [`could not be inspected (${errorText(e)})`],
            warnings: [],
        }
    }
}

// Error text carries file names and parsed fragments, so it is cleaned like any other file-derived text.
const errorText = (e: unknown) => displaySafe(e instanceof Error ? e.message : String(e))

/** What config.json says, or the finished status when there is nothing more to inspect. */
function readConfig(status: SubnetStatus): { cfg?: any; done?: SubnetStatus } {
    const configPath = path.join(status.dir, "config.json")
    if (!fs.existsSync(configPath)) return { done: { ...status, state: "placeholder" } }
    const parsed = readJson(configPath)
    if (parsed.error !== undefined) {
        return { done: invalid(status, `config.json is not valid JSON (${displaySafe(parsed.error)})`) }
    }
    const cfg = parsed.value
    if (cfg === null || typeof cfg !== "object") {
        return { done: invalid(status, "config.json must be a JSON object") }
    }
    if (!cfg.enabled) return { done: { ...status, state: "disabled" } }
    return { cfg }
}

const invalid = (status: SubnetStatus, problem: string): SubnetStatus => ({
    ...status,
    state: "invalid",
    problems: [...status.problems, problem],
})

function checkIdentity(cfg: any, uid: string, status: SubnetStatus): void {
    if (!SUBNET_UID_PATTERN.test(uid)) {
        status.problems.push("directory name is not a valid subnet id")
    }
    if (!cfg.uid) {
        status.problems.push("config.json has no \"uid\"")
    } else if (cfg.uid !== uid) {
        status.warnings.push(`config.json uid "${displaySafe(cfg.uid)}" differs from the directory name`)
    }
}

// The same ceiling the wizard puts on a key file it reads: no key is larger.
const KEY_FILE_MAX_BYTES = 64 * 1024

/** The file's text, or why it cannot be trusted as a key file. Never follows a link, never waits on a pipe. */
function readKeyFile(abs: string): { text?: string; problem?: string } {
    let fd: number | undefined
    try {
        const info = fs.lstatSync(abs)
        if (!info.isFile()) {
            return { problem: info.isSymbolicLink() ? "is a symbolic link, not a regular file" : "is not a regular file" }
        }
        // O_NOFOLLOW closes the gap between the check and the open.
        fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        const buf = Buffer.alloc(KEY_FILE_MAX_BYTES + 1)
        let filled = 0
        while (filled < buf.length) {
            const n = fs.readSync(fd, buf, filled, buf.length - filled, null)
            if (n === 0) break
            filled += n
        }
        if (filled > KEY_FILE_MAX_BYTES) return { problem: `is larger than ${KEY_FILE_MAX_BYTES} bytes, which no key is` }
        return { text: buf.subarray(0, filled).toString("utf8") }
    } catch (e) {
        return { problem: `cannot be read (${errorText(e)})` }
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
    }
}

/** One key or IV file: problems and warnings go on the status, a missing file is returned. */
function checkKeyFile(root: string, label: "key" | "IV", rel: string, status: SubnetStatus): string | undefined {
    const projectRoot = path.resolve(root)
    const abs = path.resolve(root, rel)
    const shown = displaySafe(rel)
    // The loader only compares a prefix, which also admits a sibling such as
    // `<root>-evil`; symlinks are resolved so a link cannot lead out either.
    if (!isInsideDir(abs, projectRoot)) {
        status.problems.push(`${label} path ${shown} is outside the node directory`)
        return undefined
    }
    // `bun install` or a clean checkout wipes node_modules, and the key goes with it.
    if (path.relative(projectRoot, abs).split(path.sep).includes("node_modules")) {
        status.warnings.push(`${label} file ${shown} is inside node_modules and is lost when dependencies are reinstalled`)
    }
    if (!fs.existsSync(abs) && !isLink(abs)) return `${label} file ${shown} is missing`
    const read = readKeyFile(abs)
    if (read.text === undefined) {
        status.problems.push(`${label} file ${shown} ${read.problem}`)
        return undefined
    }
    const name = label === "key" ? "Key" : "IV"
    const r = parseHex(read.text, name)
    if (!r.ok) {
        status.problems.push(`${label} file ${shown}: ${r.error}`)
        return undefined
    }
    const lengthWarning = hexLengthWarning(r.value, name, label === "key" ? KEY_BYTES : IV_BYTES)
    if (lengthWarning) status.warnings.push(`${shown}: ${lengthWarning}`)
    if (label === "key" && (fs.statSync(abs).mode & 0o077) !== 0) {
        status.warnings.push(`key file ${shown} is readable by other users (chmod 600 it)`)
    }
    return undefined
}

/** A dangling link is not "missing": it is a link, and is reported as one. */
function isLink(file: string): boolean {
    try {
        return fs.lstatSync(file).isSymbolicLink()
    } catch {
        return false
    }
}

function checkKeyFiles(root: string, cfg: any, status: SubnetStatus): void {
    const keyRel = cfg.keys?.private_key_path
    const ivRel = cfg.keys?.iv_path
    if (!keyRel || !ivRel) {
        status.problems.push("config.json needs keys.private_key_path and keys.iv_path")
        return
    }
    const missing = [checkKeyFile(root, "key", keyRel, status), checkKeyFile(root, "IV", ivRel, status)].filter(
        (m): m is string => m !== undefined,
    )
    if (missing.length > 0 && status.problems.length === 0) status.state = "missing-files"
    status.problems.push(...missing)
}

function inspectSubnetUnsafe(root: string, uid: string): SubnetStatus {
    const status: SubnetStatus = {
        uid,
        dir: path.join(root, L2PS_DIR, uid),
        state: "ok",
        problems: [],
        warnings: [],
    }
    const { cfg, done } = readConfig(status)
    if (done) return done
    checkIdentity(cfg, uid, status)
    checkKeyFiles(root, cfg, status)
    if (status.problems.length > 0 && status.state === "ok") status.state = "invalid"
    return status
}

export function inspectSubnets(root: string): SubnetStatus[] {
    const base = path.join(root, L2PS_DIR)
    let names: string[]
    try {
        if (!fs.existsSync(base)) return []
        names = fs
            .readdirSync(base, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
    } catch (e) {
        return [
            {
                uid: "(data/l2ps)",
                dir: base,
                state: "invalid",
                problems: [`directory cannot be read (${errorText(e)})`],
                warnings: [],
            },
        ]
    }
    return names.map(name => inspectSubnet(root, name))
}

export function generateKeyMaterial(
    randomBytes: (n: number) => Buffer = crypto.randomBytes,
): { keyHex: string; ivHex: string } {
    return {
        keyHex: randomBytes(32).toString("hex"),
        ivHex: randomBytes(16).toString("hex"),
    }
}

export interface SubnetFile {
    /** Path relative to the node directory. */
    rel: string
    content: string
    mode: number
    secret: boolean
}

export function buildSubnetFiles(args: {
    uid: string
    rpcs: string[]
    keyHex: string
    ivHex: string
    /** An existing config.json, so fields the setup does not manage survive a repair. */
    existingConfig?: any
    /** Key and IV locations (relative to the node dir); default to the standard layout. */
    keyRel?: string
    ivRel?: string
}): SubnetFile[] {
    const dir = `data/l2ps/${args.uid}`
    const keyRel = args.keyRel ?? `${dir}/private_key.txt`
    const ivRel = args.ivRel ?? `${dir}/iv.txt`
    const base =
        args.existingConfig !== null && typeof args.existingConfig === "object"
            ? args.existingConfig
            : {}
    // Same shape as scripts/l2ps-create-subnet.sh and the devnet fixture.
    const config = {
        ...base,
        uid: args.uid,
        enabled: true,
        config: {
            ...base.config,
            created_at_block: base.config?.created_at_block ?? 0,
            known_rpcs: args.rpcs,
        },
        keys: { private_key_path: keyRel, iv_path: ivRel },
    }
    return [
        {
            rel: `${dir}/config.json`,
            content: JSON.stringify(config, null, 4) + "\n",
            mode: 0o644,
            secret: false,
        },
        {
            rel: keyRel,
            content: args.keyHex + "\n",
            mode: 0o600,
            secret: true,
        },
        {
            rel: ivRel,
            content: args.ivHex + "\n",
            mode: 0o600,
            secret: true,
        },
    ]
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
        )
    }
    return value
}

/** True when two JSON texts hold the same data, ignoring layout and key order. */
export function sameJson(a: string, b: string): boolean {
    try {
        return (
            JSON.stringify(canonical(JSON.parse(a))) ===
            JSON.stringify(canonical(JSON.parse(b)))
        )
    } catch {
        return false
    }
}

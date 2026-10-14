import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { L2PS_DIR } from "./context"
import {
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

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function inspectSubnetUnsafe(root: string, uid: string): SubnetStatus {
    const dir = path.join(root, L2PS_DIR, uid)
    const status: SubnetStatus = {
        uid,
        dir,
        state: "ok",
        problems: [],
        warnings: [],
    }
    const configPath = path.join(dir, "config.json")
    if (!fs.existsSync(configPath)) {
        status.state = "placeholder"
        return status
    }
    const parsed = readJson(configPath)
    if (parsed.error !== undefined) {
        status.state = "invalid"
        status.problems.push(`config.json is not valid JSON (${parsed.error})`)
        return status
    }
    const cfg = parsed.value
    if (cfg === null || typeof cfg !== "object") {
        status.state = "invalid"
        status.problems.push("config.json must be a JSON object")
        return status
    }
    if (!cfg.enabled) {
        status.state = "disabled"
        return status
    }
    if (!SUBNET_UID_PATTERN.test(uid)) {
        status.problems.push("directory name is not a valid subnet id")
    }
    if (!cfg.uid) {
        status.problems.push("config.json has no \"uid\"")
    } else if (cfg.uid !== uid) {
        status.warnings.push(
            `config.json uid "${cfg.uid}" differs from the directory name`,
        )
    }

    const keyRel = cfg.keys?.private_key_path
    const ivRel = cfg.keys?.iv_path
    if (!keyRel || !ivRel) {
        status.problems.push(
            "config.json needs keys.private_key_path and keys.iv_path",
        )
    } else {
        const missing: string[] = []
        const projectRoot = path.resolve(root)
        const files: Array<[string, string]> = [
            ["key", keyRel],
            ["IV", ivRel],
        ]
        for (const [label, rel] of files) {
            const abs = path.resolve(root, rel)
            // Same test as the loader: a plain prefix check against the root.
            if (!abs.startsWith(projectRoot)) {
                status.problems.push(`${label} path ${rel} is outside the node directory`)
                continue
            }
            // `bun install` or a clean checkout wipes node_modules, and the
            // key goes with it.
            if (path.relative(projectRoot, abs).split(path.sep).includes("node_modules")) {
                status.warnings.push(`${label} file ${rel} is inside node_modules and is lost when dependencies are reinstalled`)
            }
            if (!fs.existsSync(abs)) {
                missing.push(`${label} file ${rel} is missing`)
                continue
            }
            let text: string
            try {
                text = fs.readFileSync(abs, "utf8")
            } catch (e) {
                status.problems.push(`${label} file ${rel} cannot be read (${errorText(e)})`)
                continue
            }
            const r = parseHex(text, label === "key" ? "Key" : "IV")
            if (!r.ok) {
                status.problems.push(`${label} file ${rel}: ${r.error}`)
                continue
            }
            const lengthWarning =
                label === "key"
                    ? hexLengthWarning(r.value, "Key", KEY_BYTES)
                    : hexLengthWarning(r.value, "IV", IV_BYTES)
            if (lengthWarning) status.warnings.push(`${rel}: ${lengthWarning}`)
            if (label === "key" && (fs.statSync(abs).mode & 0o077) !== 0) {
                status.warnings.push(
                    `key file ${rel} is readable by other users (chmod 600 it)`,
                )
            }
        }
        if (missing.length > 0 && status.problems.length === 0) {
            status.state = "missing-files"
        }
        status.problems.push(...missing)
    }
    if (status.problems.length > 0 && status.state === "ok") {
        status.state = "invalid"
    }
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

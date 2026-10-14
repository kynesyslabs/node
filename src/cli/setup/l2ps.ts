import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { L2PS_DIR } from "./context"
import { validateIvHex, validateKeyHex, SUBNET_UID_PATTERN } from "./validate"

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
 * reports as ok is one the node will actually load.
 */
export function inspectSubnet(root: string, uid: string): SubnetStatus {
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
        status.problems.push('config.json has no "uid"')
    } else if (cfg.uid !== uid) {
        status.problems.push(
            `config.json uid "${cfg.uid}" differs from the directory name`,
        )
    }

    const keyRel = cfg.keys?.private_key_path
    const ivRel = cfg.keys?.iv_path
    if (!keyRel || !ivRel) {
        status.problems.push(
            'config.json needs keys.private_key_path and keys.iv_path',
        )
    } else {
        const missing: string[] = []
        const files: Array<[string, string, string]> = [
            ["key", keyRel, "Key"],
            ["IV", ivRel, "IV"],
        ]
        for (const [label, rel, name] of files) {
            const abs = path.resolve(root, rel)
            if (!abs.startsWith(path.resolve(root) + path.sep)) {
                status.problems.push(`${label} path ${rel} is outside the node directory`)
                continue
            }
            if (!fs.existsSync(abs)) {
                missing.push(`${label} file ${rel} is missing`)
                continue
            }
            const text = fs.readFileSync(abs, "utf8")
            const r = label === "key" ? validateKeyHex(text) : validateIvHex(text)
            if (!r.ok) status.problems.push(`${name} file ${rel}: ${r.error}`)
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
    if (!fs.existsSync(base)) return []
    return fs
        .readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => inspectSubnet(root, d.name))
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
}): SubnetFile[] {
    const dir = `data/l2ps/${args.uid}`
    // Same shape as scripts/l2ps-create-subnet.sh and the devnet fixture.
    const config = {
        uid: args.uid,
        enabled: true,
        config: { created_at_block: 0, known_rpcs: args.rpcs },
        keys: {
            private_key_path: `${dir}/private_key.txt`,
            iv_path: `${dir}/iv.txt`,
        },
    }
    return [
        {
            rel: `${dir}/config.json`,
            content: JSON.stringify(config, null, 4) + "\n",
            mode: 0o644,
            secret: false,
        },
        {
            rel: `${dir}/private_key.txt`,
            content: args.keyHex + "\n",
            mode: 0o600,
            secret: true,
        },
        {
            rel: `${dir}/iv.txt`,
            content: args.ivHex + "\n",
            mode: 0o600,
            secret: true,
        },
    ]
}

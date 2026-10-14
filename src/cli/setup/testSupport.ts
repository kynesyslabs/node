import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Prompter } from "./prompt"
import type { ZkRunner } from "./zk"

// Tools are found in a fixed list of system directories, never by a bare name
// through PATH, so a writable directory early in PATH cannot substitute them.
const TOOL_DIRS = ["/usr/bin", "/bin", "/usr/local/bin"]

/** Absolute path of a system tool, or undefined so the test that needs it can skip. */
export function findExecutable(name: string): string | undefined {
    for (const dir of TOOL_DIRS) {
        const candidate = path.join(dir, name)
        try {
            fs.accessSync(candidate, fs.constants.X_OK)
            return candidate
        } catch {
            /* try the next directory */
        }
    }
    return undefined
}

export const PYTHON = findExecutable("python3")
export const GIT = findExecutable("git")
export const DOCKER = findExecutable("docker")
export const BASH = findExecutable("bash")

/**
 * Whether a pseudo-terminal can be opened here. Containers without /dev/ptmx
 * (some CI sandboxes) cannot, and the terminal tests are skipped there.
 */
export const ptyAvailable =
    PYTHON !== undefined &&
    spawnSync(PYTHON, ["-c", "import os, pty\nm, s = pty.openpty()\nos.close(m)\nos.close(s)"]).status === 0

/** root ignores file modes, so tests that rely on a refused write or read cannot run as root. */
export const isRoot = process.getuid?.() === 0
export const AS_USER = "(needs a non-root user: root ignores file modes)"

export const HEX_KEY = "ab".repeat(32)
export const HEX_IV = "cd".repeat(16)

export function makeRoot(opts: { identityKey?: boolean } = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "demos-setup-"))
    if (opts.identityKey !== false) {
        const dir = path.join(root, "src", "features", "zk", "keys")
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
            path.join(dir, "verification_key_merkle.json"),
            JSON.stringify({ protocol: "groth16", vk_alpha_1: ["1"], IC: [["1"]] }),
        )
    }
    return root
}

export function removeRoot(root: string): void {
    fs.rmSync(root, { recursive: true, force: true })
}

export function writeSubnet(
    root: string,
    uid: string,
    over: { key?: string | null; iv?: string | null; config?: object | string } = {},
): string {
    const dir = path.join(root, "data", "l2ps", uid)
    fs.mkdirSync(dir, { recursive: true })
    const config =
        over.config ??
        {
            uid,
            enabled: true,
            config: { created_at_block: 0, known_rpcs: ["http://127.0.0.1:53550"] },
            keys: {
                private_key_path: `data/l2ps/${uid}/private_key.txt`,
                iv_path: `data/l2ps/${uid}/iv.txt`,
            },
        }
    fs.writeFileSync(
        path.join(dir, "config.json"),
        typeof config === "string" ? config : JSON.stringify(config),
    )
    if (over.key !== null) {
        fs.writeFileSync(path.join(dir, "private_key.txt"), (over.key ?? HEX_KEY) + "\n", { mode: 0o600 })
    }
    if (over.iv !== null) {
        fs.writeFileSync(path.join(dir, "iv.txt"), (over.iv ?? HEX_IV) + "\n", { mode: 0o600 })
    }
    return dir
}

export function writeZkBatch(root: string, size: number, parts = { zkey: true, wasm: true, vkey: true }): void {
    const dir = path.join(root, "src", "libs", "l2ps", "zk", "keys", `batch_${size}`)
    fs.mkdirSync(path.join(dir, `l2ps_batch_${size}_js`), { recursive: true })
    if (parts.zkey) fs.writeFileSync(path.join(dir, `l2ps_batch_${size}.zkey`), "z")
    if (parts.wasm) fs.writeFileSync(path.join(dir, `l2ps_batch_${size}_js`, `l2ps_batch_${size}.wasm`), "w")
    if (parts.vkey) fs.writeFileSync(path.join(dir, "verification_key.json"), JSON.stringify({ protocol: "plonk" }))
}

/** Answers questions in order; an exhausted script fails the test instead of hanging. */
export function scriptedPrompter(answers: string[]): Prompter & { asked: string[] } {
    const queue = [...answers]
    const asked: string[] = []
    return {
        asked,
        async readLine(question) {
            asked.push(question)
            if (queue.length === 0) throw new Error(`unexpected question: ${question}`)
            return queue.shift() as string
        },
    }
}

export function recorder(): { say: (l: string) => void; lines: string[]; text: () => string } {
    const lines: string[] = []
    return { say: l => lines.push(l), lines, text: () => lines.join("\n") }
}

export function fakeRunner(opts: { vkeyJson?: string; failOn?: string } = {}): ZkRunner & { calls: string[] } {
    const calls: string[] = []
    return {
        calls,
        async download(url, dest) {
            calls.push(`download ${path.basename(dest)}`)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            fs.writeFileSync(dest, "x".repeat(10))
        },
        async exec(cmd, args) {
            const name = `${path.basename(cmd)} ${args[0] === "plonk" || args[0] === "zkey" ? args.slice(0, 2).join(" ") : "compile"}`
            calls.push(name)
            if (opts.failOn && name.includes(opts.failOn)) return 1
            const last = args[args.length - 1]
            if (args[0] === "plonk") fs.writeFileSync(last, "zkey")
            if (args[0] === "zkey") fs.writeFileSync(last, opts.vkeyJson ?? JSON.stringify({ protocol: "plonk" }))
            if (name.endsWith("compile")) {
                const out = args[args.indexOf("-o") + 1]
                const base = path.basename(args[0], ".circom")
                fs.mkdirSync(path.join(out, `${base}_js`), { recursive: true })
                fs.writeFileSync(path.join(out, `${base}_js`, `${base}.wasm`), "w")
                fs.writeFileSync(path.join(out, `${base}.r1cs`), "r")
            }
            return 0
        },
    }
}

export function installZkTools(root: string): void {
    for (const rel of ["node_modules/.bin/circom2", "node_modules/.bin/snarkjs"]) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
        fs.writeFileSync(path.join(root, rel), "")
    }
    fs.mkdirSync(path.join(root, "node_modules/circomlib/circuits"), { recursive: true })
}

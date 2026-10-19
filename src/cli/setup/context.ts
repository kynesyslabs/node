import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { readEnvFile } from "./envFile"

/**
 * The checkout this code lives in, found from this file and not from the shell's
 * current directory. The committed keys and the built ZK keys are read by the
 * node from here (the batch prover resolves its key directory from its own
 * location), so they are inspected here whatever directory the node is started
 * from.
 */
export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

export interface SetupContext {
    /**
     * Directory the node runs from. The node reads `.env`, `data/l2ps` and
     * `data/genesis.json` relative to it, so the operator's own state is
     * inspected and written there.
     */
    root: string
    /** Where the committed and built ZK keys live; see CODE_ROOT. */
    codeRoot: string
    envFilePath: string
    /** Effective environment: the env file overlaid by the real process env, as dotenv does. */
    env: Record<string, string | undefined>
    /** The real process environment alone; it overrides the env file. */
    processEnv: Record<string, string | undefined>
    /** Running inside the container image, where /app/.env is not the operator's file. */
    inDocker: boolean
}

/** The Dockerfile sets DEMOS_IN_DOCKER; /.dockerenv covers images built without it. */
export function detectDocker(
    env: Record<string, string | undefined> = process.env,
): boolean {
    const flag = env.DEMOS_IN_DOCKER?.toLowerCase()
    if (flag === "true" || flag === "1") return true
    if (flag === "false" || flag === "0") return false
    return fs.existsSync("/.dockerenv")
}

export function createContext(
    root: string,
    envFileName = ".env",
    processEnv: Record<string, string | undefined> = process.env,
    inDocker: boolean = detectDocker(processEnv),
    codeRoot: string = root,
): SetupContext {
    const envFilePath = path.resolve(root, envFileName)
    return {
        root,
        codeRoot,
        envFilePath,
        env: { ...readEnvFile(envFilePath), ...processEnv },
        processEnv,
        inDocker,
    }
}

export const L2PS_DIR = path.join("data", "l2ps")
export const L2PS_ZK_DIR = path.join("src", "libs", "l2ps", "zk")
export const ZK_IDENTITY_VKEY = path.join(
    "src",
    "features",
    "zk",
    "keys",
    "verification_key_merkle.json",
)

/**
 * Whether this process may read the terminal without being stopped. A node
 * started with `&` from an interactive shell has a tty on stdin but sits in a
 * background process group; its first read stops it (SIGTTIN) and the node
 * never boots. /proc/self/stat has the terminal's foreground group (tpgid) next
 * to our own (pgrp); -1 means there is no controlling terminal, so no job
 * control applies.
 *
 * It fails safe: when that file cannot be read or understood (macOS has no
 * /proc, or the layout is not what is expected) the answer is "not known to be
 * foreground", so the offer is skipped and the node boots. A skipped offer
 * costs nothing; a stopped validator costs a missed start.
 */
export function isForegroundOnTerminal(
    stat: string | (() => string) = () => fs.readFileSync("/proc/self/stat", "utf8"),
): boolean {
    try {
        const text = typeof stat === "string" ? stat : stat()
        // The command name sits in parentheses and may contain spaces.
        const close = text.lastIndexOf(")")
        if (close === -1) return false
        const fields = text.slice(close + 2).split(" ")
        const pgrp = Number(fields[2])
        const tpgid = Number(fields[5])
        if (!Number.isInteger(pgrp) || !Number.isInteger(tpgid)) return false
        return tpgid === -1 || tpgid === pgrp
    } catch {
        return false
    }
}

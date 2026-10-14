import * as fs from "node:fs"
import * as path from "node:path"
import { readEnvFile } from "./envFile"

export interface SetupContext {
    /** Directory the node runs from; the loader resolves `data/l2ps` against it. */
    root: string
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
): SetupContext {
    const envFilePath = path.resolve(root, envFileName)
    return {
        root,
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
 * control applies. Where /proc does not exist there is nothing to check.
 */
export function isForegroundOnTerminal(stat?: string): boolean {
    try {
        const text = stat ?? fs.readFileSync("/proc/self/stat", "utf8")
        // The command name sits in parentheses and may contain spaces.
        const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
        const pgrp = Number(fields[2])
        const tpgid = Number(fields[5])
        if (!Number.isInteger(pgrp) || !Number.isInteger(tpgid)) return true
        return tpgid === -1 || tpgid === pgrp
    } catch {
        return true
    }
}

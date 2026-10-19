import { spawn } from "node:child_process"
import { downloadWithFetch, type ZkRunner } from "./zk"

// The toolchain needs a search path, a home for its caches and the runtime
// options; nothing else of the operator's environment (tokens, keys, DEMOS_*
// secrets) has a reason to reach a downloaded-code build tool.
const CHILD_ENV_KEYS = ["PATH", "HOME", "NODE_OPTIONS", "TMPDIR"] as const

export function childEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
    const out: Record<string, string> = {}
    for (const k of CHILD_ENV_KEYS) {
        const v = env[k]
        if (v !== undefined) out[k] = v
    }
    return out
}

export function createDefaultRunner(): ZkRunner {
    return {
        download: downloadWithFetch,
        exec: (cmd, args, cwd) =>
            new Promise((resolve, reject) => {
                const child = spawn(cmd, args, { cwd, stdio: "inherit", env: childEnv() })
                child.on("error", reject)
                child.on("close", code => resolve(code ?? 1))
            }),
    }
}

import { spawn } from "node:child_process"
import { downloadWithFetch, type ZkRunner } from "./zk"

export function createDefaultRunner(): ZkRunner {
    return {
        download: downloadWithFetch,
        exec: (cmd, args, cwd) =>
            new Promise((resolve, reject) => {
                const child = spawn(cmd, args, { cwd, stdio: "inherit" })
                child.on("error", reject)
                child.on("close", code => resolve(code ?? 1))
            }),
    }
}

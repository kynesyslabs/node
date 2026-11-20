import { expect, it } from "bun:test"
import { readFileSync } from "fs"
import { createShutdownExitStatus } from "./shutdownExitStatus"
it("keeps the first fatal exit code, including during an in-progress clean shutdown", () => {
    for (const [requests, expected] of [
        [[42, 1], 42],
        [[0, 1, 0], 1],
        [[0], 0],
    ] as const) {
        const status = createShutdownExitStatus()
        for (const code of requests) status.request(code)
        expect(status.code).toBe(expected)
    }
})

it("documents the force-exit timer's actual duration", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    const timer = source.match(/\/\/ Force exit after (\d+) seconds if graceful shutdown hangs\s+const forceExitTimeout = setTimeout\([\s\S]*?\}, ([\d_]+)\)/)
    expect(timer).not.toBeNull()
    expect(Number(timer![1]) * 1000).toBe(Number(timer![2].replaceAll("_", "")))
})

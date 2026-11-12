/**
 * A prover subprocess that exits or errors on its own is taken down whole:
 * on the npx path the launcher can exit while the prover under it lives on
 * with its 1 GB of loaded artifacts.
 */
import { EventEmitter } from "node:events"
import { describe, expect, it, jest, mock } from "bun:test"

const real = await import("node:child_process")
const children: any[] = []
mock.module("node:child_process", () => ({
    ...real,
    spawn: () => {
        const child: any = new EventEmitter()
        child.pid = 4300 + children.length
        child.stdin = { write: jest.fn(), end: jest.fn() }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = jest.fn()
        children.push(child)
        return child
    },
}))

const { SettlementProverPool } = await import("./proverPool")

describe("a prover subprocess that goes on its own", () => {
    for (const event of ["exit", "error"] as const) {
        it(`kills what it started and closes its stdin on ${event}`, async () => {
            const pool = new SettlementProverPool({ size: 1, zkeyPath: "k.zkey", wasmPath: "c.wasm" })
            const probe = pool.probe()
            const child = children[children.length - 1]
            child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "ready" }) + "\n"))
            await probe

            if (event === "exit") child.emit("exit", 1, null)
            else child.emit("error", new Error("spawn failed"))

            expect(child.stdin.end).toHaveBeenCalled()
            expect(child.kill).toHaveBeenCalledWith("SIGKILL")
            await pool.terminate()
        })
    }
})

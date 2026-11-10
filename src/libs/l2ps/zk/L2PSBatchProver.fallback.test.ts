/**
 * A proof on the main thread blocks the node's event loop, consensus included,
 * for its whole length (about 15 s for ten transactions). So a prover
 * subprocess that is down or fails must surface as an error, never as a
 * silent switch to the main thread.
 */

import { describe, expect, it, jest, mock } from "bun:test"
import { EventEmitter } from "node:events"

class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = { write: jest.fn() }
    kill = jest.fn()
    ready() {
        this.stdout.emit("data", Buffer.from(JSON.stringify({ type: "ready" }) + "\n"))
    }
}
const spawned: FakeChild[] = []
const childProcess = await import("node:child_process")
mock.module("node:child_process", () => ({
    ...childProcess,
    spawn: jest.fn(() => {
        const child = new FakeChild()
        spawned.push(child)
        return child
    }),
}))

const { L2PSBatchProver } = await import("./L2PSBatchProver")

const input = {
    transactions: [{ senderBefore: 5n, senderAfter: 0n, receiverBefore: 0n, receiverAfter: 5n, amount: 5n }],
    initialStateRoot: 1n,
}

function proverWith(state: { ready: boolean; request?: () => Promise<unknown> }) {
    const prover = new L2PSBatchProver("/nonexistent") as any
    prover.initialized = true
    prover.processReady = state.ready
    const restart = jest.fn(async () => undefined)
    prover.initializeSubprocess = restart
    if (state.request) prover.subprocessRequest = state.request
    const kill = jest.fn()
    prover.childProcess = { kill }
    const mainThread = jest.fn(async () => {
        throw new Error("main thread must not be used")
    })
    prover.generateProofMainThread = mainThread
    return { prover, restart, kill, mainThread }
}

describe("L2PSBatchProver without a working subprocess", () => {
    it("tries to restart a subprocess that is down, then fails without using the main thread", async () => {
        const { prover, restart, mainThread } = proverWith({ ready: false })
        await expect(prover.generateProof(input)).rejects.toThrow("subprocess is unavailable")
        expect(restart).toHaveBeenCalledTimes(1)
        expect(mainThread).not.toHaveBeenCalled()
    })

    it("fails a proof whose subprocess request failed, and drops that child so the next proof restarts it", async () => {
        const { prover, kill, mainThread } = proverWith({
            ready: true,
            request: async () => {
                throw new Error("Subprocess request timeout")
            },
        })
        await expect(prover.generateProof(input)).rejects.toThrow("Subprocess request timeout")
        expect(mainThread).not.toHaveBeenCalled()
        expect(kill).toHaveBeenCalledTimes(1)
        expect(prover.processReady).toBe(false)
        expect(prover.childProcess).toBeNull()
    })
})

describe("L2PSBatchProver subprocess lifecycle", () => {
    it("fails a proof in flight as soon as its child exits, not at the request timeout", async () => {
        const prover = new L2PSBatchProver("/nonexistent") as any
        const starting = prover.initializeSubprocess()
        const child = spawned.at(-1)!
        child.ready()
        await starting
        expect(prover.processReady).toBe(true)

        const request = prover.subprocessRequest("prove", {})
        child.emit("exit", null, "SIGKILL")
        await expect(request).rejects.toThrow("subprocess exited")
        expect(prover.processReady).toBe(false)
        expect(prover.childProcess).toBeNull()
    })

    it("spawns once for concurrent restarts and ignores output from a replaced child", async () => {
        const prover = new L2PSBatchProver("/nonexistent") as any
        const before = spawned.length
        const first = prover.initializeSubprocess()
        const second = prover.initializeSubprocess()
        expect(spawned.length).toBe(before + 1)
        const old = spawned.at(-1)!
        old.ready()
        await Promise.all([first, second])

        const restart = prover.initializeSubprocess()
        expect(old.kill).toHaveBeenCalled()
        const current = spawned.at(-1)!
        old.ready()
        old.emit("exit", 0, null)
        expect(prover.processReady).toBe(false)
        current.ready()
        await restart
        expect(prover.processReady).toBe(true)
        expect(prover.childProcess).toBe(current)
    })
})

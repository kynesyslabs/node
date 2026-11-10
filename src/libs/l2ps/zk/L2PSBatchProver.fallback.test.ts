/**
 * A proof on the main thread blocks the node's event loop, consensus included,
 * for its whole length (about 15 s for ten transactions). So a prover
 * subprocess that is down or fails must surface as an error, never as a
 * silent switch to the main thread.
 */

import { describe, expect, it, jest } from "bun:test"
import { L2PSBatchProver } from "./L2PSBatchProver"

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

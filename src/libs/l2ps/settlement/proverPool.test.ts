/**
 * The settlement prover pool. Proving takes about 40 s and 1 GB per
 * batch, so the proving tests run only with L2PS_SETTLEMENT_PROVE_TESTS=1 and
 * the keys built (bun run setup --only zk --zk --zk-generate).
 */
import { describe, expect, it, jest } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PROVEN_BATCHES } from "./__fixtures__/batches"
import { buildSettlementCircuitInput } from "./circuitInput"
import { planSettlement } from "./planner"
import { proveSettlement, verifySettlementProof } from "./prover"
import { SettlementProverPool, killProver, proverCommand } from "./proverPool"
import { isSettlementBuilt } from "../zk/settlementArtifacts"

const proveTests = process.env.L2PS_SETTLEMENT_PROVE_TESTS === "1" && isSettlementBuilt()

function inputOf(make: (typeof PROVEN_BATCHES)[number]) {
    const { transfers, balances, nonces } = make()
    return buildSettlementCircuitInput(planSettlement(transfers, balances, nonces)).input
}

describe("settlement prover pool without keys", () => {
    const missing = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settlement-pool-"))
        return { dir, zkeyPath: path.join(dir, "none.zkey"), wasmPath: path.join(dir, "none.wasm") }
    }

    it("fails the proof when the subprocess cannot start, and fails the next one the same way", async () => {
        const { dir, zkeyPath, wasmPath } = missing()
        const pool = new SettlementProverPool({ size: 1, zkeyPath, wasmPath })
        try {
            await expect(pool.prove(inputOf(PROVEN_BATCHES[0]))).rejects.toThrow(/exited \(code 2/)
            await expect(pool.prove(inputOf(PROVEN_BATCHES[0]))).rejects.toThrow(/exited \(code 2/)
        } finally {
            await pool.terminate()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("fails the boot probe when the subprocess cannot start, and passes it once it can", async () => {
        const { dir, zkeyPath, wasmPath } = missing()
        const broken = new SettlementProverPool({ size: 2, zkeyPath, wasmPath })
        // Not the real files: the subprocess only checks they are there before it is ready.
        fs.writeFileSync(path.join(dir, "present.zkey"), "x")
        fs.writeFileSync(path.join(dir, "present.wasm"), "x")
        const ready = new SettlementProverPool({
            size: 1,
            zkeyPath: path.join(dir, "present.zkey"),
            wasmPath: path.join(dir, "present.wasm"),
        })
        try {
            await expect(broken.probe()).rejects.toThrow(/exited \(code 2/)
            await ready.probe()
        } finally {
            await broken.terminate()
            await ready.terminate()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("refuses work beyond its queue", async () => {
        const { dir, zkeyPath, wasmPath } = missing()
        const pool = new SettlementProverPool({ size: 1, zkeyPath, wasmPath, maxQueue: 1 })
        try {
            const first = pool.prove(inputOf(PROVEN_BATCHES[0]))
            const queued = pool.prove(inputOf(PROVEN_BATCHES[0]))
            await expect(pool.prove(inputOf(PROVEN_BATCHES[0]))).rejects.toThrow(/queue is full/)
            await expect(first).rejects.toThrow()
            await expect(queued).rejects.toThrow()
        } finally {
            await pool.terminate()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it("fails queued and later work once terminated", async () => {
        const { dir, zkeyPath, wasmPath } = missing()
        const pool = new SettlementProverPool({ size: 1, zkeyPath, wasmPath })
        const first = pool.prove(inputOf(PROVEN_BATCHES[0]))
        const queued = pool.prove(inputOf(PROVEN_BATCHES[0]))
        await pool.terminate()
        await expect(first).rejects.toThrow()
        await expect(queued).rejects.toThrow(/terminated/)
        await expect(pool.prove(inputOf(PROVEN_BATCHES[0]))).rejects.toThrow(/closed/)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("sizes itself to at least one subprocess", () => {
        expect(new SettlementProverPool({ size: 0 }).size).toBe(1)
        expect(new SettlementProverPool({ size: 3 }).size).toBe(3)
    })
})

describe.skipIf(!proveTests)("settlement proofs in the subprocess", () => {
    it("abandons a proof that runs past its timeout and replaces the subprocess", async () => {
        const pool = new SettlementProverPool({ size: 1, proofTimeoutMs: 2_000 })
        try {
            await expect(pool.prove(inputOf(PROVEN_BATCHES[0]))).rejects.toThrow(/timed out/)
        } finally {
            await pool.terminate()
        }
    }, 60_000)

    it(
        "proves and verifies every shared batch",
        async () => {
            const pool = new SettlementProverPool({ size: 1 })
            try {
                for (const make of PROVEN_BATCHES) {
                    const { transfers, balances, nonces, name } = make()
                    const plan = planSettlement(transfers, balances, nonces)
                    const started = performance.now()
                    const result = await proveSettlement(plan, pool)
                    const ms = performance.now() - started
                    console.log(`settlement proof, ${name}: ${(ms / 1000).toFixed(1)} s`)
                    const signals = result.publicSignals.map(BigInt)
                    expect(signals).toEqual(buildSettlementCircuitInput(plan).publicSignals)
                    expect(await verifySettlementProof(signals, result.proof)).toBe(true)
                    const other = [...signals]
                    other[other.length - 1] += 1n
                    expect(await verifySettlementProof(other, result.proof)).toBe(false)
                }
            } finally {
                await pool.terminate()
            }
        },
        PROVEN_BATCHES.length * 180_000,
    )

    it("refuses to prove a plan whose witness does not exist", async () => {
        const pool = new SettlementProverPool({ size: 1 })
        try {
            const input = inputOf(PROVEN_BATCHES[0])
            ;(input.deltaMagnitude as string[])[0] = "1"
            await expect(pool.prove(input)).rejects.toThrow(/Assert Failed/)
        } finally {
            await pool.terminate()
        }
    }, 120_000)
})

describe("killing a prover subprocess", () => {
    it("starts the npx launcher in a group of its own, so a kill reaches the prover under it", () => {
        expect(proverCommand(false, "k.zkey", "c.wasm")).toMatchObject({ cmd: "npx", detached: true })
        expect(proverCommand(true, "k.zkey", "c.wasm")).toMatchObject({ cmd: process.execPath, detached: false })
    })

    it("kills the whole group and closes stdin, so a prover the signal misses still exits", () => {
        const end = jest.fn()
        const kill = jest.fn()
        const signals: unknown[][] = []
        const realKill = process.kill
        ;(process as any).kill = (...args: unknown[]) => (signals.push(args), true)
        try {
            killProver({ pid: 4242, stdin: { end } as any, kill }, true)
        } finally {
            ;(process as any).kill = realKill
        }
        expect(signals).toEqual([[-4242, "SIGKILL"]])
        expect(end).toHaveBeenCalledTimes(1)
        expect(kill).not.toHaveBeenCalled()

        killProver({ pid: 4243, stdin: { end } as any, kill }, false)
        expect(kill).toHaveBeenCalledWith("SIGKILL")
        expect(end).toHaveBeenCalledTimes(2)
    })
})

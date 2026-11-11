#!/usr/bin/env bun
/**
 * Settlement prover subprocess: one PLONK proof at a time, off the node's
 * event loop. Requests and responses are JSON lines on stdin/stdout.
 *
 *   -> {"id": "...", "type": "prove", "data": {"input": {...}}}
 *   <- {"id": "...", "type": "result", "data": {"proof": {...}, "publicSignals": [...]}}
 *   <- {"id": "...", "type": "error", "error": "..."}
 *
 * Usage: bun settlementProofProcess.ts <zkey> <wasm>
 */
import * as fs from "node:fs"
import * as readline from "node:readline"
import * as snarkjs from "snarkjs"

const [zkeyPath, wasmPath] = process.argv.slice(2)

function send(message: unknown): void {
    process.stdout.write(JSON.stringify(message) + "\n")
}

const usable = (file: string | undefined): boolean => {
    try {
        return file !== undefined && fs.statSync(file).size > 0
    } catch {
        return false
    }
}

if (!usable(zkeyPath) || !usable(wasmPath)) {
    // The parent sees the exit before any ready line and reports the reason.
    process.stderr.write(`settlement prover: missing proving key or circuit (${zkeyPath}, ${wasmPath})\n`)
    process.exit(2)
}

async function prove(input: Record<string, unknown>): Promise<unknown> {
    // singleThread: snarkjs worker threads crash under Bun; the pool scales
    // with processes instead.
    const { proof, publicSignals } = await (snarkjs as any).plonk.fullProve(
        input,
        wasmPath,
        zkeyPath,
        null,
        {},
        { singleThread: true },
    )
    return { proof, publicSignals }
}

// One proof at a time: two concurrent proofs would only double the memory
// and finish no sooner on one core.
let queue: Promise<void> = Promise.resolve()

async function handle(line: string): Promise<void> {
    let request: any
    try {
        request = JSON.parse(line)
    } catch {
        send({ type: "error", error: "request is not JSON" })
        return
    }
    const id = typeof request?.id === "string" ? request.id : undefined
    try {
        if (request.type !== "prove") throw new Error(`unknown request type ${String(request.type)}`)
        const input = request.data?.input
        if (input === null || typeof input !== "object") throw new Error("prove request has no input")
        send({ id, type: "result", data: await prove(input) })
    } catch (error) {
        send({ id, type: "error", error: error instanceof Error ? error.message : String(error) })
    }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on("line", line => {
    if (line.trim() === "") return
    queue = queue.then(() => handle(line))
})
// The parent went away: nothing will read the result.
rl.on("close", () => process.exit(0))

send({ type: "ready" })

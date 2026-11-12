/**
 * Pool of settlement prover subprocesses. A proof takes one core for about 40
 * seconds and about 1 GB of memory, so it never runs on the node's event
 * loop: there is no main-thread fallback, and a proof that cannot be made
 * fails so its batch stays in the L2PS mempool.
 */
import { spawn, type ChildProcess } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import log from "@/utilities/logger"
import { settlementFiles } from "../zk/settlementArtifacts"
import type { SettlementCircuitInput } from "./circuitInput"
import type { SettlementProof } from "./types"

const here = path.dirname(fileURLToPath(import.meta.url))
const PROCESS_SCRIPT = path.join(here, "..", "zk", "settlementProofProcess.ts")

export interface RawSettlementProof {
    proof: SettlementProof
    publicSignals: string[]
}

export interface SettlementProverPoolOptions {
    /** Subprocesses proving in parallel; each takes a core and about 1 GB while it proves. */
    size?: number
    zkeyPath?: string
    wasmPath?: string
    /** A proof that takes longer is abandoned and its subprocess replaced. */
    proofTimeoutMs?: number
    readyTimeoutMs?: number
    /** Proofs waiting for a free subprocess; more are refused at once. */
    maxQueue?: number
}

export const DEFAULT_PROOF_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_READY_TIMEOUT_MS = 30 * 1000
const DEFAULT_MAX_QUEUE = 64

interface Job {
    input: SettlementCircuitInput
    resolve: (value: RawSettlementProof) => void
    reject: (error: Error) => void
}

/**
 * How a prover subprocess is started. Without Bun the script runs through
 * `npx tsx`, a launcher whose prover is a grandchild that a signal to the
 * launcher never reaches, so it gets a process group of its own to kill.
 */
export function proverCommand(
    isBun: boolean,
    zkeyPath: string,
    wasmPath: string,
): { cmd: string; args: string[]; detached: boolean } {
    return isBun
        ? { cmd: process.execPath, args: [PROCESS_SCRIPT, zkeyPath, wasmPath], detached: false }
        : { cmd: "npx", args: ["tsx", PROCESS_SCRIPT, zkeyPath, wasmPath], detached: true }
}

/**
 * Kills a prover subprocess and everything it started. Its stdin is closed
 * as well: the prover exits on EOF, should a kill not reach it.
 */
export function killProver(
    child: Pick<ChildProcess, "pid" | "stdin" | "kill">,
    detached: boolean,
): void {
    child.stdin?.end()
    if (detached && child.pid !== undefined) {
        try {
            process.kill(-child.pid, "SIGKILL")
            return
        } catch {
            // The group is gone already; the launcher itself may not be.
        }
    }
    child.kill("SIGKILL")
}

class ProverWorker {
    private child: ChildProcess | null = null
    private detached = false
    private ready: Promise<void> | null = null
    private buffer = ""
    private current: { id: string; job: Job; timer: ReturnType<typeof setTimeout> | undefined } | null = null
    private counter = 0

    constructor(
        private readonly index: number,
        private readonly zkeyPath: string,
        private readonly wasmPath: string,
        private readonly proofTimeoutMs: number,
        private readonly readyTimeoutMs: number,
        private readonly onIdle: () => void,
    ) {}

    get busy(): boolean {
        return this.current !== null
    }

    /** Starts the subprocess if it is not running; rejects when it cannot come up. */
    start(): Promise<void> {
        this.ready ??= this.spawnChild().catch(error => {
            this.ready = null
            throw error
        })
        return this.ready
    }

    private spawnChild(): Promise<void> {
        const { cmd, args, detached } = proverCommand((globalThis as any).Bun !== undefined, this.zkeyPath, this.wasmPath)
        // Bun's collector sizes itself to the host's RAM; telling it the host
        // has 2 GiB brings a proof's peak from about 1.3 GB to 1 GB at the
        // same speed. A heuristic, not a cap: a proof that needs more still
        // gets it.
        const env = { BUN_JSC_forceRAMSize: String(2 * 1024 ** 3), ...process.env }
        const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd(), env, detached })
        this.child = child
        this.detached = detached
        this.buffer = ""

        return new Promise<void>((resolve, reject) => {
            let settled = false
            const settle = (error?: Error) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                if (error) reject(error)
                else resolve()
            }
            const timer = setTimeout(() => {
                settle(new Error(`settlement prover ${this.index} did not start within ${this.readyTimeoutMs} ms`))
                this.kill()
            }, this.readyTimeoutMs)

            child.stdout?.on("data", (data: Buffer) => {
                if (this.child !== child) return
                this.buffer += data.toString()
                const lines = this.buffer.split("\n")
                this.buffer = lines.pop() ?? ""
                for (const line of lines) {
                    if (line.trim() === "") continue
                    let message: any
                    try {
                        message = JSON.parse(line)
                    } catch {
                        continue
                    }
                    if (message.type === "ready") settle()
                    else this.onMessage(message)
                }
            })
            child.stderr?.on("data", (data: Buffer) => {
                const text = data.toString().trim()
                if (text) log.debug(`[SettlementProver ${this.index}] ${text}`)
            })
            // The launcher can go while the prover under it lives on, so
            // whatever it started is taken down with it.
            child.on("error", error => {
                if (this.child !== child) return
                killProver(child, detached)
                settle(error)
                this.down(error)
            })
            child.on("exit", (code, signal) => {
                if (this.child !== child) return
                killProver(child, detached)
                const error = new Error(`settlement prover ${this.index} exited (code ${code}, signal ${signal})`)
                settle(error)
                this.down(error)
            })
        })
    }

    private onMessage(message: any): void {
        const current = this.current
        if (!current || message.id !== current.id) return
        this.finish()
        if (message.type === "result") current.job.resolve(message.data as RawSettlementProof)
        else current.job.reject(new Error(`settlement proof failed: ${String(message.error)}`))
    }

    private finish(): void {
        if (this.current?.timer) clearTimeout(this.current.timer)
        this.current = null
        this.onIdle()
    }

    /** The subprocess is gone: its proof in flight fails now, the next job starts a new one. */
    private down(error: Error): void {
        this.child = null
        this.ready = null
        const current = this.current
        if (current) {
            this.finish()
            current.job.reject(error)
        }
    }

    /** Takes the job at once (the worker is busy from here), starting the subprocess if needed. */
    run(job: Job): void {
        const id = `p${this.index}_${++this.counter}`
        const current: NonNullable<ProverWorker["current"]> = { id, job, timer: undefined }
        this.current = current
        this.start().then(
            () => {
                if (this.current !== current) return
                current.timer = setTimeout(() => {
                    // A stuck proof would hold every later one behind it.
                    this.kill()
                    this.down(new Error(`settlement proof timed out after ${this.proofTimeoutMs} ms`))
                }, this.proofTimeoutMs)
                this.child?.stdin?.write(JSON.stringify({ id, type: "prove", data: { input: job.input } }) + "\n")
            },
            error => {
                if (this.current !== current) return
                this.finish()
                job.reject(error instanceof Error ? error : new Error(String(error)))
            },
        )
    }

    kill(): void {
        const child = this.child
        this.child = null
        this.ready = null
        if (child) killProver(child, this.detached)
    }

    terminate(error: Error): void {
        this.kill()
        this.down(error)
    }
}

export class SettlementProverPool {
    private readonly workers: ProverWorker[]
    private readonly queue: Job[] = []
    private readonly maxQueue: number
    private closed = false

    constructor(options: SettlementProverPoolOptions = {}) {
        const files = settlementFiles()
        const size = Math.max(1, Math.floor(options.size ?? 1))
        this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
        this.workers = Array.from(
            { length: size },
            (_, i) =>
                new ProverWorker(
                    i,
                    options.zkeyPath ?? files.zkey,
                    options.wasmPath ?? files.wasm,
                    options.proofTimeoutMs ?? DEFAULT_PROOF_TIMEOUT_MS,
                    options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
                    () => this.pump(),
                ),
        )
    }

    get size(): number {
        return this.workers.length
    }

    /** Starts the first subprocess and resolves once it is ready; for the boot check. */
    probe(): Promise<void> {
        if (this.closed) return Promise.reject(new Error("settlement prover pool is closed"))
        return this.workers[0].start()
    }

    prove(input: SettlementCircuitInput): Promise<RawSettlementProof> {
        if (this.closed) return Promise.reject(new Error("settlement prover pool is closed"))
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(new Error(`settlement prover queue is full (${this.maxQueue} waiting)`))
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ input, resolve, reject })
            this.pump()
        })
    }

    private pump(): void {
        if (this.closed) return
        for (const worker of this.workers) {
            if (this.queue.length === 0) return
            if (!worker.busy) worker.run(this.queue.shift() as Job)
        }
    }

    async terminate(): Promise<void> {
        this.closed = true
        const error = new Error("settlement prover pool terminated")
        for (const job of this.queue.splice(0)) job.reject(error)
        for (const worker of this.workers) worker.terminate(error)
    }
}

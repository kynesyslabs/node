import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"

import { parseWorkerMessage, stringifyWorkerMessage, type WorkerRequest, type WorkerResponse } from "./protocol"

export {
    applyMutations,
    createBurnMutations,
    createMintMutations,
    createTransferMutations,
    type ExecuteWithHooksRequest,
    type GCRTokenData,
    type HookExecutionResult,
    type ScriptExecutor,
    type ScriptMethodRequest,
    type ScriptMethodResult,
    type ScriptViewRequest,
    type ScriptViewResult,
    type TokenMutation,
} from "./shared"

import type {
    ExecuteWithHooksRequest,
    HookExecutionResult,
    ScriptExecutor,
    ScriptMethodRequest,
    ScriptMethodResult,
    ScriptViewRequest,
    ScriptViewResult,
} from "./shared"

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? value : fallback
}

const TOKEN_SCRIPT_COMPILE_TIMEOUT_MS = envInt("TOKEN_SCRIPT_COMPILE_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_VIEW_TIMEOUT_MS = envInt("TOKEN_SCRIPT_VIEW_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_HOOK_TIMEOUT_MS = envInt("TOKEN_SCRIPT_HOOK_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_METHOD_TIMEOUT_MS = envInt("TOKEN_SCRIPT_METHOD_TIMEOUT_MS", 50)
const TOKEN_SCRIPT_ASYNC_TIMEOUT_MS = envInt("TOKEN_SCRIPT_ASYNC_TIMEOUT_MS", 2000)
const TOKEN_SCRIPT_WORKER_GRACE_MS = envInt("TOKEN_SCRIPT_WORKER_GRACE_MS", 250)

type RequestKind = WorkerRequest["kind"]

type PendingRequest = {
    kind: RequestKind
    resolve: (value: any) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

class ScriptWorkerClient {
    private child: ChildProcessWithoutNullStreams | null = null
    private pending = new Map<string, PendingRequest>()
    private nextId = 0
    private stdoutBuffer = ""

    async executeView(req: ScriptViewRequest): Promise<ScriptViewResult> {
        try {
            return await this.request({ id: this.makeId(), kind: "view", payload: req })
        } catch (error: any) {
            const message = error?.message ?? String(error)
            return {
                success: false,
                error: message,
                errorType: this.isTimeoutError(message) ? "timeout" : "execution_error",
                executionTimeMs: 0,
                gasUsed: 0,
            }
        }
    }

    async executeMethod(req: ScriptMethodRequest): Promise<ScriptMethodResult> {
        try {
            return await this.request({ id: this.makeId(), kind: "method", payload: req })
        } catch (error: any) {
            const message = error?.message ?? String(error)
            return {
                success: false,
                error: message,
                errorType: this.isTimeoutError(message) ? "timeout" : "execution_error",
            }
        }
    }

    async executeWithHooks(req: ExecuteWithHooksRequest): Promise<HookExecutionResult> {
        try {
            return await this.request({ id: this.makeId(), kind: "hooks", payload: req })
        } catch (error: any) {
            return {
                finalState: req.tokenData,
                mutations: [],
                rejection: { hookType: "engine", reason: error?.message ?? String(error) },
                metadata: { beforeHookExecuted: false, afterHookExecuted: false },
            }
        }
    }

    private async request<T>(request: WorkerRequest): Promise<T> {
        const child = this.ensureWorker()
        return await new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request.id)
                this.restartWorker(`Token script worker ${request.kind} request timed out`)
                reject(new Error(`Token script worker ${request.kind} request timed out`))
            }, this.requestTimeoutMs(request.kind))

            this.pending.set(request.id, {
                kind: request.kind,
                resolve,
                reject,
                timer,
            })

            const serialized = stringifyWorkerMessage(request)
            child.stdin.write(serialized, (error) => {
                if (!error) return
                const pending = this.pending.get(request.id)
                if (!pending) return
                clearTimeout(pending.timer)
                this.pending.delete(request.id)
                reject(error)
            })
        })
    }

    private ensureWorker(): ChildProcessWithoutNullStreams {
        if (this.child && !this.child.killed && this.child.exitCode === null) {
            return this.child
        }

        const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url))
        const launch = process.versions.bun
            ? { command: process.execPath, args: [workerPath] }
            : {
                  command: process.execPath,
                  args: ["--import", "tsx", "-r", "tsconfig-paths/register", workerPath],
              }

        const child = spawn(launch.command, launch.args, {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["pipe", "pipe", "inherit"],
        })

        child.stdout.setEncoding("utf8")
        child.stdout.on("data", (chunk: string) => this.handleStdout(chunk))
        child.on("error", (error) => this.failPending(error.message))
        child.on("exit", (code, signal) => this.handleExit(code, signal))

        this.stdoutBuffer = ""
        this.child = child
        return child
    }

    private handleStdout(chunk: string): void {
        this.stdoutBuffer += chunk
        while (true) {
            const newlineIndex = this.stdoutBuffer.indexOf("\n")
            if (newlineIndex === -1) return

            const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
            if (!line) continue

            let response: WorkerResponse
            try {
                response = parseWorkerMessage<WorkerResponse>(line)
            } catch (error: any) {
                this.restartWorker(`Failed to parse script worker response: ${error?.message ?? String(error)}`)
                return
            }

            const pending = this.pending.get(response.id)
            if (!pending) continue

            clearTimeout(pending.timer)
            this.pending.delete(response.id)

            if (response.ok === true) {
                pending.resolve(response.result)
                continue
            }

            pending.reject(new Error((response as Extract<WorkerResponse, { ok: false }>).error))
        }
    }

    private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
        const message = `Token script worker exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`
        this.child = null
        this.stdoutBuffer = ""
        this.failPending(message)
    }

    private restartWorker(message: string): void {
        if (this.child && !this.child.killed) {
            this.child.kill("SIGKILL")
        }
        this.child = null
        this.stdoutBuffer = ""
        this.failPending(message)
    }

    private failPending(message: string): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error(message))
        }
        this.pending.clear()
    }

    private makeId(): string {
        this.nextId += 1
        return `script-${this.nextId}`
    }

    private requestTimeoutMs(kind: RequestKind): number {
        const syncTimeoutMs =
            kind === "view"
                ? TOKEN_SCRIPT_VIEW_TIMEOUT_MS
                : kind === "method"
                  ? TOKEN_SCRIPT_METHOD_TIMEOUT_MS
                  : TOKEN_SCRIPT_HOOK_TIMEOUT_MS
        return TOKEN_SCRIPT_COMPILE_TIMEOUT_MS + syncTimeoutMs + TOKEN_SCRIPT_ASYNC_TIMEOUT_MS + TOKEN_SCRIPT_WORKER_GRACE_MS
    }

    private isTimeoutError(message: string): boolean {
        return message.includes("Script execution timed out") || message.toLowerCase().includes("timed out")
    }
}

const workerClient = new ScriptWorkerClient()

export const scriptExecutor: ScriptExecutor = {
    async executeView(req) {
        return await workerClient.executeView(req)
    },
    async executeMethod(req) {
        return await workerClient.executeMethod(req)
    },
    async executeWithHooks(req) {
        return await workerClient.executeWithHooks(req)
    },
}

export class HookExecutor {
    constructor(private readonly executor: ScriptExecutor) {}

    async executeWithHooks(req: ExecuteWithHooksRequest): Promise<HookExecutionResult> {
        return await this.executor.executeWithHooks(req)
    }
}

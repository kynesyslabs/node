/**
 * Main contract execution sandbox using Bun Workers
 * Provides isolated, secure execution environment for user contracts
 */

import { Worker } from "bun"
import type { ExecutionRequest, ExecutionResult } from "./ExecutionContext"
// Using Bun's built-in path utilities

export class Sandbox {
    private static readonly EXECUTION_TIMEOUT_MS = 60000 // 60 seconds
    private static readonly WORKER_SCRIPT_PATH = `${
        import.meta.dir
    }/SandboxExecutor.ts`

    /**
     * Execute a contract method in isolated Bun Worker
     */
    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
        return new Promise((resolve, reject) => {
            let worker: Worker | null = null
            let timeoutId: Timer | null = null
            let isResolved = false

            // Helper to clean up and resolve
            const cleanup = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId)
                    timeoutId = null
                }
                if (worker) {
                    worker.terminate()
                    worker = null
                }
            }

            // Helper to resolve once
            const resolveOnce = (result: ExecutionResult) => {
                if (!isResolved) {
                    isResolved = true
                    cleanup()
                    resolve(result)
                }
            }

            // Helper to reject once
            const rejectOnce = (error: Error | string) => {
                if (!isResolved) {
                    isResolved = true
                    cleanup()
                    reject(typeof error === "string" ? new Error(error) : error)
                }
            }

            try {
                // Create worker instance
                console.log(
                    `[Sandbox] Creating worker for contract execution: ${request.methodName}`,
                )
                // NOTE That's ugly, but is the only way we can keep tsconfig's DOM library without ts confusing bun workers with node workers
                worker = new Worker(
                    Sandbox.WORKER_SCRIPT_PATH,
                ) as unknown as import("bun").Worker

                // Set execution timeout
                timeoutId = setTimeout(() => {
                    console.error(
                        `[Sandbox] Execution timeout after ${Sandbox.EXECUTION_TIMEOUT_MS}ms`,
                    )
                    resolveOnce({
                        success: false,
                        returnValue: null,
                        callCount: 0,
                        gasUsed: 0n,
                        stateChanges: {},
                        events: [],
                        error: `Execution timeout after ${
                            Sandbox.EXECUTION_TIMEOUT_MS / 1000
                        } seconds`,
                    })
                }, Sandbox.EXECUTION_TIMEOUT_MS)

                // Handle worker messages (results)
                worker.onmessage = (event: any) => {
                    try {
                        const result = event.data as ExecutionResult
                        console.log(
                            `[Sandbox] Worker completed. Success: ${result.success}, Calls: ${result.callCount}`,
                        )
                        resolveOnce(result)
                    } catch (error) {
                        console.error(
                            "[Sandbox] Error parsing worker result:",
                            error,
                        )
                        rejectOnce(
                            new Error(
                                "Failed to parse worker execution result",
                            ),
                        )
                    }
                }

                // Handle worker errors
                worker.addEventListener("error", (error: ErrorEvent) => {
                    console.error("[Sandbox] Worker error:", error)
                    resolveOnce({
                        success: false,
                        returnValue: null,
                        callCount: 0,
                        gasUsed: 0n,
                        stateChanges: {},
                        events: [],
                        error: `Worker error: ${
                            error.message || String(error)
                        }`,
                    })
                })

                // Handle worker exit
                worker.addEventListener("close", () => {
                    if (!isResolved) {
                        console.log("[Sandbox] Worker closed unexpectedly")
                        resolveOnce({
                            success: false,
                            returnValue: null,
                            callCount: 0,
                            gasUsed: 0n,
                            stateChanges: {},
                            events: [],
                            error: "Worker closed unexpectedly",
                        })
                    }
                })

                // Send execution request to worker
                console.log("[Sandbox] Sending execution request to worker")
                worker.postMessage(request)
            } catch (error) {
                console.error("[Sandbox] Failed to create worker:", error)
                cleanup()
                rejectOnce(
                    new Error(
                        `Failed to create worker: ${
                            error instanceof Error
                                ? error.message
                                : String(error)
                        }`,
                    ),
                )
            }
        })
    }

    /**
     * Validate contract source code before execution
     * Basic safety checks for banned APIs and syntax
     */
    static validateContractSource(source: string): {
        valid: boolean
        error?: string
    } {
        // Check for banned APIs (basic detection)
        const bannedAPIs = [
            "require(",
            "import(",
            "eval(",
            "Function(",
            "process.",
            "global.",
            "Buffer.",
            "__dirname",
            "__filename",
            "fetch(",
            "XMLHttpRequest",
            "WebSocket",
            "setTimeout",
            "setInterval",
            "clearTimeout",
            "clearInterval",
        ]

        for (const banned of bannedAPIs) {
            if (source.includes(banned)) {
                return {
                    valid: false,
                    error: `Contract source contains banned API: ${banned}`,
                }
            }
        }

        // Basic syntax validation (try to parse as TypeScript/JavaScript)
        try {
            // This is a basic check - more sophisticated validation could be added
            new Function(source)
        } catch (error) {
            return {
                valid: false,
                error: `Contract source has syntax errors: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            }
        }

        return { valid: true }
    }
}

export default Sandbox

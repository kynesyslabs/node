import { parentPort, threadId } from "worker_threads"
import type {
    TxValidationResult,
    WorkerRequest,
    WorkerResponse,
} from "./types"

// Diagnostic shim: stderr is the only reliable channel from a worker that
// crashes during module load, so we use console.error directly here. These
// logs are intentionally noisy on first boot and during failure investigation.
console.error(`[txValidatorWorker ${threadId} pid=${process.pid}] booting`)

process.on("uncaughtException", (err: unknown) => {
    const detail = err instanceof Error ? err.stack || err.message : String(err)
    console.error(
        `[txValidatorWorker ${threadId}] uncaughtException: ${detail}`,
    )
    process.exit(1)
})

process.on("unhandledRejection", (reason: unknown) => {
    const detail =
        reason instanceof Error
            ? reason.stack || reason.message
            : String(reason)
    console.error(
        `[txValidatorWorker ${threadId}] unhandledRejection: ${detail}`,
    )
    process.exit(1)
})

if (!parentPort) {
    throw new Error(
        "txValidatorWorker must be loaded as a worker_threads worker",
    )
}

const port = parentPort

// Dynamic import so a load-time failure inside the validator chain (or any of
// its transitive deps) is caught and surfaces with a real stack trace, instead
// of being swallowed as a generic worker exit.
;(async () => {
    let validateTx: typeof import("./txValidator").validateTx

    try {
        const mod = await import("./txValidator")
        validateTx = mod.validateTx
        console.error(`[txValidatorWorker ${threadId}] imports OK`)
    } catch (err) {
        const detail =
            err instanceof Error ? err.stack || err.message : String(err)
        console.error(
            `[txValidatorWorker ${threadId}] import ./txValidator failed: ${detail}`,
        )
        process.exit(1)
    }

    port.on("message", async (msg: WorkerRequest) => {
        if (msg.type === "shutdown") {
            // Cooperative exit. Pool waits for in-flight requests to drain
            // before sending shutdown, so it's safe to terminate here.
            process.exit(0)
            return
        }
        if (msg.type !== "validate") return

        try {
            const results: TxValidationResult[] = []
            for (const tx of msg.txs) {
                results.push(
                    await validateTx(tx, msg.identityHints[tx.hash] ?? null),
                )
            }
            const res: WorkerResponse = {
                type: "validateResult",
                requestId: msg.requestId,
                results,
            }
            port.postMessage(res)
        } catch (err) {
            const res: WorkerResponse = {
                type: "fatal",
                requestId: msg.requestId,
                error: err instanceof Error ? err.message : String(err),
            }
            port.postMessage(res)
        }
    })
})()

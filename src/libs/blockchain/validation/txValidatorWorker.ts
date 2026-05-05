import { parentPort } from "worker_threads"
import { validateTx } from "./txValidator"
import type {
    TxValidationResult,
    WorkerRequest,
    WorkerResponse,
} from "./types"

if (!parentPort) {
    throw new Error("txValidatorWorker must be loaded as a worker_threads worker")
}

const port = parentPort

port.on("message", async (msg: WorkerRequest) => {
    if (msg.type === "shutdown") {
        // Cooperative exit. Pool waits for in-flight requests to drain before
        // sending shutdown, so it's safe to terminate here.
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

// Surfaces structured-clone failures on inbound messages. The worker is still
// alive but a request was lost — exit non-zero so the parent treats it as a
// crash and tears the node down.
port.on("messageerror", err => {
    console.error("[txValidatorWorker] messageerror:", err)
    process.exit(1)
})

// Signal readiness only after the module has fully loaded (all imports
// resolved, listeners registered). The pool blocks `start()` until every
// worker emits this, so a worker that fails to import surfaces as a startup
// timeout instead of a silent hang on the first validate() call.
port.postMessage({ type: "ready" } satisfies WorkerResponse)

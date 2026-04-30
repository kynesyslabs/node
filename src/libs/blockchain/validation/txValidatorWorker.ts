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

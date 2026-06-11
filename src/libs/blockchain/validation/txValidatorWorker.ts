import { parentPort, workerData } from "worker_threads"
import { validateTx } from "./txValidator"
import type {
    TxValidationResult,
    WorkerInitData,
    WorkerRequest,
    WorkerResponse,
} from "./types"
// Same path-bypass as txValidator.ts: avoid the encryption package index so we
// don't transitively load zK (ffjavascript → web-worker), which crashes inside
// worker_threads. See the long comment in txValidator.ts.
import {
    unifiedCrypto as ucrypto,
} from "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js"

if (!parentPort) {
    throw new Error("txValidatorWorker must be loaded as a worker_threads worker")
}

const port = parentPort

// Surfaces structured-clone failures on inbound messages. The worker is still
// alive but a request was lost — exit non-zero so the parent treats it as a
// crash and tears the node down.
port.on("messageerror", err => {
    console.error("[txValidatorWorker] messageerror:", err)
    process.exit(1)
})

port.on("message", async (msg: WorkerRequest) => {
    if (msg.type === "shutdown") {
        // Cooperative exit. Pool waits for in-flight requests to drain before
        // sending shutdown, so it's safe to terminate here.
        process.exit(0)
        return
    }

    try {
        if (msg.type === "validate") {
            const results: TxValidationResult[] = []
            for (const tx of msg.txs) {
                results.push(
                    await validateTx(
                        tx,
                        msg.identityHints[tx.hash] ?? null,
                        msg.isPostFork,
                    ),
                )
            }
            port.postMessage({
                type: "validateResult",
                requestId: msg.requestId,
                results,
            } satisfies WorkerResponse)
            return
        }

        if (msg.type === "sign") {
            const signedObject = await ucrypto.sign(msg.algorithm, msg.data)
            port.postMessage({
                type: "signResult",
                requestId: msg.requestId,
                signedObject,
            } satisfies WorkerResponse)
            return
        }

        if (msg.type === "verify") {
            const result = await ucrypto.verify(msg.signedObject)
            port.postMessage({
                type: "verifyResult",
                requestId: msg.requestId,
                result,
            } satisfies WorkerResponse)
            return
        }
    } catch (err) {
        port.postMessage({
            type: "fatal",
            requestId: (msg as { requestId?: string }).requestId,
            error: err instanceof Error ? err.message : String(err),
        } satisfies WorkerResponse)
    }
})

// Boot identity from the master seed so ucrypto.sign() works inside this
// worker. The pool blocks start() until every worker has signaled ready,
// which only happens after this completes. A failure here propagates up via
// the unhandledRejection path → process exits non-zero → pool treats it as
// a startup crash.
async function init(): Promise<void> {
    const init = workerData as WorkerInitData | undefined
    if (!init?.masterSeed) {
        throw new Error(
            "txValidatorWorker: workerData.masterSeed missing; cannot derive node identity",
        )
    }
    await ucrypto.ensureSeed(init.masterSeed)
    await ucrypto.generateAllIdentities(init.masterSeed)
}

await init()

// Signal readiness only after the module has fully loaded (all imports
// resolved, identities generated, listeners registered). The pool blocks
// start() until every worker emits this, so a worker that fails to import
// or fails identity setup surfaces as a startup timeout / crash instead of
// a silent hang on the first request.
port.postMessage({ type: "ready" } satisfies WorkerResponse)

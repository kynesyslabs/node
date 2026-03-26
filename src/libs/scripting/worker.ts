import readline from "node:readline"

import { parseWorkerMessage, stringifyWorkerMessage, type WorkerRequest, type WorkerResponse } from "./protocol"
import { executeMethodInSandbox, executeViewInSandbox, executeWithHooksInSandbox } from "./vm-runtime"

async function executeRequest(request: WorkerRequest): Promise<WorkerResponse> {
    try {
        if (request.kind === "view") {
            return { id: request.id, ok: true, result: await executeViewInSandbox(request.payload) }
        }
        if (request.kind === "method") {
            return { id: request.id, ok: true, result: await executeMethodInSandbox(request.payload) }
        }
        return { id: request.id, ok: true, result: await executeWithHooksInSandbox(request.payload) }
    } catch (error: any) {
        return {
            id: request.id,
            ok: false,
            error: error?.message ?? String(error),
        }
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
})

rl.on("line", async (line) => {
    if (!line.trim()) return

    let response: WorkerResponse
    try {
        const request = parseWorkerMessage<WorkerRequest>(line)
        response = await executeRequest(request)
    } catch (error: any) {
        response = {
            id: "unknown",
            ok: false,
            error: error?.message ?? String(error),
        }
    }

    process.stdout.write(stringifyWorkerMessage(response))
})

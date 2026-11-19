/**
 * A node with TLSNOTARY_ENABLED and no notary sidecar is a relay: the
 * requestTLSNproxy relay needs no local notary. Boot must get a typed reason
 * it can log as relay-only, not a generic failure, and TLSNOTARY_FATAL must
 * still stop the node.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createServer } from "node:net"

import { initializeTLSNotary, NotaryUnreachableError, TLSNotaryService } from "./index"
import { shutdownTLSNotaryService } from "./TLSNotaryService"

const ENV_KEYS = ["TLSNOTARY_DISABLED", "TLSNOTARY_MODE", "TLSNOTARY_HOST", "TLSNOTARY_PORT", "TLSNOTARY_FATAL", "TLSNOTARY_AUTO_START"]
let savedEnv: Record<string, string | undefined> = {}

async function closedPort(): Promise<number> {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()))
    const { port } = server.address() as { port: number }
    await new Promise<void>(resolve => server.close(() => resolve()))
    return port
}

beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.TLSNOTARY_HOST = "127.0.0.1"
    process.env.TLSNOTARY_PORT = String(await closedPort())
    await shutdownTLSNotaryService()
})

afterEach(async () => {
    await shutdownTLSNotaryService()
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
    }
})

describe("a docker-mode notary that does not answer", () => {
    it("rejects with NotaryUnreachableError naming where it looked, without exiting", async () => {
        const exit = spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called")
        }) as never)
        try {
            const service = new TLSNotaryService({ host: "127.0.0.1", port: Number(process.env.TLSNOTARY_PORT), mode: "docker", autoStart: true })
            const err = await service.initialize().then(() => null, (e: unknown) => e)
            expect(err).toBeInstanceOf(NotaryUnreachableError)
            expect((err as Error).message).toContain(`no notary answers at 127.0.0.1:${process.env.TLSNOTARY_PORT}`)
            expect(exit).not.toHaveBeenCalled()
        } finally {
            exit.mockRestore()
        }
    })

    it("reaches the boot as NotaryUnreachableError, not as a false 'failed to initialize'", async () => {
        const exit = spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called")
        }) as never)
        try {
            const err = await initializeTLSNotary().then(() => null, (e: unknown) => e)
            expect(err).toBeInstanceOf(NotaryUnreachableError)
            expect(exit).not.toHaveBeenCalled()
        } finally {
            exit.mockRestore()
        }
    })

    it("still stops the node under TLSNOTARY_FATAL=true", async () => {
        process.env.TLSNOTARY_FATAL = "true"
        const exit = spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process.exit called")
        }) as never)
        try {
            const service = new TLSNotaryService({ host: "127.0.0.1", port: Number(process.env.TLSNOTARY_PORT), mode: "docker", autoStart: true })
            await service.initialize().catch(() => undefined)
            expect(exit).toHaveBeenCalledWith(1)
        } finally {
            exit.mockRestore()
        }
    })
})

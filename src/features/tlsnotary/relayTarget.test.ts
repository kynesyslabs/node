/**
 * The TLSNotary relay opens a raw TCP tunnel from the node to the host:port a
 * caller names. On a public validator it must not reach the operator's own
 * host or private network, nor ports other than the allowed ones (443 by
 * default), and it must dial the address it checked, not re-resolve the name.
 */

import { afterEach, describe, expect, it, jest, mock } from "bun:test"
import { EventEmitter } from "node:events"

delete process.env.TLSNOTARY_ALLOWED_PORTS
delete process.env.TLSNOTARY_ALLOW_PRIVATE_TARGETS

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
}
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))
const sharedState: Record<string, unknown> = {}
mock.module("@/utilities/sharedState", () => ({ getSharedState: sharedState }))

const spawned: string[][] = []
const realChildProcess = { ...(await import("node:child_process")) }
mock.module("child_process", () => ({
    ...realChildProcess,
    exec: (_cmd: string, cb: (e: Error | null, r: unknown) => void) =>
        cb(null, { stdout: "wstcp v0.2.1:\n    wstcp\n", stderr: "" }),
    spawn: (_bin: string, args: string[]) => {
        spawned.push(args)
        const child = new EventEmitter() as any
        child.stderr = new EventEmitter()
        child.kill = () => true
        setTimeout(
            () => child.stderr.emit("data", Buffer.from("INFO Starts a WebSocket proxy server")),
            1,
        )
        return child
    },
}))

const realDns = (await import("node:dns")).default
const DNS: Record<string, string> = {
    "rebind.example": "10.0.0.7",
    "public.example": "93.184.216.34",
}
mock.module("node:dns", () => ({
    __esModule: true,
    default: {
        ...realDns,
        lookup: (
            host: string,
            _opts: unknown,
            cb: (e: Error | null, a: unknown) => void,
        ) =>
            DNS[host]
                ? cb(null, [{ address: DNS[host], family: 4 }])
                : cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []),
    },
}))

const { requestProxy, killAllProxies } = await import("./proxyManager")

afterEach(() => {
    killAllProxies()
    spawned.length = 0
})

async function refused(url: string) {
    const result: any = await requestProxy(url)
    expect(result.error).toBe("TARGET_NOT_ALLOWED")
    expect(spawned).toEqual([])
}

describe("TLSNotary relay targets", () => {
    it("refuses loopback, private, link-local and metadata addresses", async () => {
        await refused("https://127.0.0.1/")
        await refused("https://10.1.2.3/")
        await refused("https://169.254.169.254/latest/meta-data/")
        await refused("https://[::1]/")
    })

    it("refuses a name that resolves to a private address", async () => {
        await refused("https://rebind.example/")
    })

    it("refuses a port other than the allowed ones", async () => {
        await refused("https://93.184.216.34:22/")
        await refused("https://public.example:6379/")
    })

    it("relays to a public host on 443 through the address it checked", async () => {
        const result: any = await requestProxy("https://public.example/x")
        expect(result.error).toBeUndefined()
        expect(spawned.length).toBe(1)
        expect(spawned[0].at(-1)).toBe("93.184.216.34:443")
    })
})

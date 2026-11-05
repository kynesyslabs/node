import { afterEach, describe, expect, it } from "bun:test"
import { loadConfig } from "./loader"

const KEY = "GOSSIP_IPC_CONNECT_TIMEOUT_MS"
const saved = process.env[KEY]

afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
})

describe("gossip IPC connect timeout", () => {
    it("defaults to 15 s and reads an override", () => {
        delete process.env[KEY]
        expect(loadConfig().gossip.ipcConnectTimeoutMs).toBe(15_000)
        process.env[KEY] = "30000"
        expect(loadConfig().gossip.ipcConnectTimeoutMs).toBe(30_000)
    })

    it("rejects zero and negative values", () => {
        for (const v of ["0", "-1"]) {
            process.env[KEY] = v
            expect(() => loadConfig()).toThrow(/GOSSIP_IPC_CONNECT_TIMEOUT_MS must be an integer > 0/)
        }
    })
})

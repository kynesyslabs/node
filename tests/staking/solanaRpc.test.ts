import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
const identity = { solanaRpc: "https://a.example,https://b.example", heliusApiKey: "" }
jest.mock("src/config", () => ({
    __esModule: true,
    Config: { getInstance: () => ({ identity }) },
}))

import type { Connection } from "@solana/web3.js"
import { SOLANA_RPC_TIMEOUT_MS, SolanaUnreachableError, resetSolanaConnectionsForTesting, withSolana } from "@/features/staking/solanaRpc"

const never = () => new Promise<never>(() => {})

describe("withSolana", () => {
    beforeEach(() => {
        jest.useFakeTimers()
        resetSolanaConnectionsForTesting()
    })

    it("takes the first endpoint that answers while another hangs", async () => {
        const read = (c: Connection) => (c.rpcEndpoint.startsWith("https://a.") ? never() : Promise.resolve("b"))
        await expect(withSolana("read", read)).resolves.toBe("b")
    })

    it("ignores an endpoint that fails while another answers", async () => {
        const read = (c: Connection) =>
            c.rpcEndpoint.startsWith("https://a.") ? Promise.reject(new Error("not found")) : Promise.resolve("b")
        await expect(withSolana("read", read)).resolves.toBe("b")
    })

    it("is unreachable after one timeout when every endpoint hangs, naming each", async () => {
        const pending = withSolana("read", never)
        const settled = pending.then(
            () => "answered",
            e => e,
        )
        jest.advanceTimersByTime(SOLANA_RPC_TIMEOUT_MS)
        const e = await settled
        expect(e).toBeInstanceOf(SolanaUnreachableError)
        expect(String((e as Error).message)).toContain("a.example")
        expect(String((e as Error).message)).toContain("b.example")
    })
})

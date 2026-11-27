/**
 * contract_read on EVM runs against the node's configured RPC for the chain,
 * through the same cached instance pay and contract_write use. A chain with
 * no configured RPC is reported as not found; nothing is created or cached
 * for it, so later operations on that chain id are not handed a broken
 * instance.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

const quietLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() }
mock.module("@/utilities/logger", () => ({ __esModule: true, default: quietLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: quietLog }))

const multichain = await import("@kynesyslabs/demosdk/xm-localsdk")
const { evmProviders } = await import("sdk/localsdk/multichain/configs/evmProviders")
const { default: handleContractRead } = await import("./contract_read")

const ERC20_ABI = JSON.stringify([
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
])
const HOLDER = "0x" + "11".repeat(20)

function readOp(chain: string, subchain: string, params: unknown): any {
    return { chain, subchain, is_evm: true, rpc: "", task: { type: "contract_read", params, signedPayloads: [] } }
}

/** A connected instance whose contract answers balanceOf with 42. */
function fakeInstance(calls: unknown[][] = []) {
    return {
        getContractInstance: async () => ({
            getFunction: (signature: string) => {
                if (signature !== "balanceOf(address)") {
                    throw new Error(`a read must not call ${signature}`)
                }
                return async (...args: unknown[]) => (calls.push(args), 42n)
            },
        }),
    }
}

const BALANCE = { address: HOLDER, abi: ERC20_ABI, method: "balanceOf" }

afterEach(() => jest.restoreAllMocks())

describe("contract_read RPC resolution", () => {
    it("reports an unconfigured chain as not found and caches nothing", async () => {
        const create = spyOn(multichain.EVM, "createInstance")
        const cache = (multichain.EVM as any).instances as Map<number, unknown>
        const before = cache.size
        // optimism has chain ids but no configured RPC
        const reply = await handleContractRead(
            readOp("optimism", "mainnet", { address: HOLDER, abi: ERC20_ABI, method: "balanceOf", params: "[]" }),
            10,
        )
        expect(reply).toEqual({ result: "error", error: "RPC URL not found for optimism.mainnet" })
        expect(create).not.toHaveBeenCalled()
        expect(cache.size).toBe(before)
    })

    it("reports an unknown subchain and an inherited key as not found", async () => {
        const create = spyOn(multichain.EVM, "createInstance")
        for (const [chain, subchain] of [["eth", "nowhere"], ["eth", "constructor"], ["constructor", "name"]]) {
            const reply = await handleContractRead(readOp(chain, subchain, { ...BALANCE, params: "[]" }), 1)
            expect(reply).toMatchObject({ result: "error", error: `RPC URL not found for ${chain}.${subchain}` })
        }
        expect(create).not.toHaveBeenCalled()
    })

    it("reads through the configured RPC", async () => {
        const urls: string[] = []
        spyOn(multichain.EVM, "getInstance").mockReturnValue(null as any)
        spyOn(multichain.EVM, "createInstance").mockImplementation(((_id: number, url: string) => {
            urls.push(url)
            return { ...fakeInstance(), connect: async () => true } as any
        }) as any)
        const reply = await handleContractRead(
            readOp("eth", "sepolia", { address: HOLDER, abi: ERC20_ABI, method: "balanceOf", params: JSON.stringify({ a: HOLDER }) }),
            11155111,
        )
        expect(urls).toEqual([evmProviders.eth.sepolia])
        expect(reply).toMatchObject({ status: true })
    })
})

describe("contract_read arguments and method", () => {
    function withInstance(calls: unknown[][] = []) {
        spyOn(multichain.EVM, "getInstance").mockReturnValue({ ...fakeInstance(calls), connect: async () => true } as any)
    }

    it("accepts a JSON list, a JSON object, an array or no params", async () => {
        const calls: unknown[][] = []
        withInstance(calls)
        for (const params of [JSON.stringify([HOLDER]), JSON.stringify({ a: HOLDER }), [HOLDER]]) {
            const reply = await handleContractRead(readOp("eth", "sepolia", { ...BALANCE, params }), 11155111)
            expect(reply).toEqual({ result: 42n, status: true })
        }
        expect(calls).toEqual([[HOLDER], [HOLDER], [HOLDER]])
    })

    const refused: Array<[string, unknown, string]> = [
        ["null params", null, "Missing contract read params"],
        ["no address", { ...BALANCE, address: "" }, "Missing contract address"],
        ["no ABI", { ...BALANCE, abi: undefined }, "Missing contract ABI"],
        ["a malformed ABI", { ...BALANCE, abi: "{not json" }, "Invalid contract ABI"],
        ["a method missing from the ABI", { ...BALANCE, method: "connect" }, "is not in the ABI"],
        ["a state-changing method", { ...BALANCE, method: "transfer" }, "not a view or pure function"],
        ["unparseable params", { ...BALANCE, params: "{oops" }, "Invalid contract method params"],
        ["a scalar params value", { ...BALANCE, params: "5" }, "Invalid contract method params"],
    ]
    for (const [label, params, error] of refused) {
        it(`refuses ${label} without calling the contract`, async () => {
            const calls: unknown[][] = []
            withInstance(calls)
            const reply = await handleContractRead(readOp("eth", "sepolia", params), 11155111)
            expect(reply).toMatchObject({ result: "error", error: expect.stringContaining(error) })
            expect(calls).toEqual([])
        })
    }
})

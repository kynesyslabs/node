/**
 * An EVM contract_read runs against the node's configured RPC for the chain
 * only, on a connection of its own: it never creates or replaces the per-chain
 * EVM instance that pay and contract_write broadcast through. It calls only a
 * view or pure function of the given ABI, refusing any other method before it
 * connects, and destroys its provider whatever the outcome.
 * A failed read logs only the error's class and code, never a revert reason.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import { AbiCoder, Interface } from "ethers"

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

const multichain = await import("@kynesyslabs/demosdk/xm-localsdk")
const { evmProviders } = await import(
    "sdk/localsdk/multichain/configs/evmProviders"
)
const { default: xmParser } = await import("../XMParser")
const { default: handleContractRead } = await import("./contract_read")

// The SDK caches one EVM instance per chain id for the whole process.
const cache = (multichain.EVM as any).instances as Map<number, unknown>
// The SDK's own method: it wraps the connected provider in an ethers Contract.
const sdkGetContractInstance = multichain.EVM.prototype.getContractInstance
const ABI = ["function balanceOf(address) view returns (uint256)"]
let saved: Map<number, unknown>
let readVia: string[]
let connect: ReturnType<typeof spyOn>
let provider: ReturnType<typeof stubProvider>

/**
 * Stands in for the JsonRpcProvider that connect() sets up, with no network:
 * every eth_call returns 7 and no address has code.
 */
function stubProvider() {
    const p: any = {
        call: jest.fn(async () =>
            AbiCoder.defaultAbiCoder().encode(["uint256"], [7n]),
        ),
        getCode: jest.fn(async () => "0x"),
        once: jest.fn(),
        destroy: jest.fn(),
    }
    p.provider = p
    return p
}

function read(chain: string, subchain: string, extra: object = {}): any {
    return {
        chain,
        subchain,
        is_evm: true,
        task: {
            type: "contract_read",
            params: {
                address: "0x0000000000000000000000000000000000000001",
                abi: ABI,
                method: "balanceOf",
                params: JSON.stringify({
                    owner: "0x0000000000000000000000000000000000000002",
                }),
            },
        },
        ...extra,
    }
}

beforeEach(() => {
    saved = new Map(cache)
    cache.clear()
    readVia = []
    provider = stubProvider()
    connect = spyOn(multichain.EVM.prototype, "connect").mockImplementation(
        async function (this: any) {
            this.provider = provider
            return true
        },
    )
    spyOn(multichain.EVM.prototype, "getContractInstance").mockImplementation(
        async function (this: any, address: string, abi: any) {
            readVia.push(this.rpc_url)
            return sdkGetContractInstance.call(this, address, abi)
        },
    )
    // The SDK's getContractInstance prints the instance
    spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
    jest.restoreAllMocks()
    cache.clear()
    for (const [k, v] of saved) cache.set(k, v)
})

describe("EVM contract_read", () => {
    it("reads through the configured RPC and leaves the shared instance cache alone", async () => {
        const res = await xmParser.executeOperation(
            read("eth", "sepolia", { rpc: "https://rpc.partner.example/" }),
        )
        expect(res).toEqual({ result: 7n, status: true })
        expect(readVia).toEqual([evmProviders.eth.sepolia])
        expect(cache.size).toBe(0)
    })

    it.each([
        ["a named subchain", "eth", "polygon"],
        ["a numeric subchain", "polygon", "137"],
    ])(
        "returns an error when no RPC is configured for the chain (%s)",
        async (_label, chain, subchain) => {
            const res = await xmParser.executeOperation(read(chain, subchain))
            expect(res.result).toBe("error")
            expect(readVia).toEqual([])
            expect(cache.has(137)).toBe(false)
        },
    )

    // Called directly: XMParser's chain id lookup is a separate check.
    it.each([
        ["constructor", "name"],
        ["__proto__", "constructor"],
        ["__proto__", "toString"],
        ["eth", "constructor"],
    ])(
        "takes no RPC from an inherited property (%s.%s)",
        async (chain, subchain) => {
            const res = await handleContractRead(read(chain, subchain), 1)
            expect(res).toEqual({
                result: "error",
                error: `RPC URL not found for ${chain}.${subchain}`,
            })
            expect(connect).not.toHaveBeenCalled()
            expect(readVia).toEqual([])
            expect(cache.size).toBe(0)
        },
    )

    it("logs the chain and subchain as escaped values of at most 64 characters", async () => {
        quietLog.debug.mockClear()
        await handleContractRead(read("eth\nforged " + "x".repeat(1000), "sepolia"), 1)

        expect(quietLog.debug).toHaveBeenCalledWith(
            `[XM Method] Read contract on "eth\\nforged ${"x".repeat(52)}"."sepolia"`,
        )
    })

    it("logs only the error class and code when the contract reverts with a call argument", async () => {
        const SECRET = "secret-call-argument-123"
        const revertData =
            "0x08c379a0" +
            AbiCoder.defaultAbiCoder().encode(["string"], [SECRET]).slice(2)
        provider.call.mockImplementation(async () => {
            throw AbiCoder.getBuiltinCallException("call", { data: "0x" }, revertData)
        })
        quietLog.error.mockClear()

        const res = await xmParser.execute({
            operations: { read: read("eth", "sepolia") },
        } as any)

        expect(res.read.error).toContain(`execution reverted: "${SECRET}"`)
        expect(quietLog.error.mock.calls).toEqual([
            ["[XM EXECUTE] Operation 1 failed: Error CALL_EXCEPTION"],
        ])
    })

    it("calls a view function of the given ABI and returns its result", async () => {
        const res = await handleContractRead(read("eth", "sepolia"), 11155111)

        expect(res).toEqual({ result: 7n, status: true })
        expect(provider.call).toHaveBeenCalledTimes(1)
        expect(provider.call.mock.calls[0][0]).toMatchObject({
            to: "0x0000000000000000000000000000000000000001",
            data: new Interface(ABI).encodeFunctionData("balanceOf", [
                "0x0000000000000000000000000000000000000002",
            ]),
        })
        expect(provider.destroy).toHaveBeenCalledTimes(1)
    })

    // Members of the ethers contract object that are not functions of the ABI
    it.each(["waitForDeployment", "getDeployedCode", "toString", "constructor"])(
        "refuses %s, which the ABI lacks, before connecting",
        async method => {
            const op = read("eth", "sepolia")
            op.task.params.method = method

            const res: any = await xmParser.execute({
                operations: { read: op },
            } as any)

            expect(res.read).toEqual({
                result: "error",
                error: `Method ${method} is not in the ABI`,
            })
            expect(connect).not.toHaveBeenCalled()
            expect(provider.call).not.toHaveBeenCalled()
        },
    )

    it("a later pay on the chain broadcasts through the configured RPC", async () => {
        const sentVia: string[] = []
        spyOn(multichain.EVM.prototype, "sendSignedTransaction").mockImplementation(
            async function (this: any) {
                sentVia.push(this.rpc_url)
                return { result: "success", hash: "0x01" } as any
            },
        )
        await xmParser.executeOperation(read("eth", "polygon")).catch(
            () => undefined,
        )
        await xmParser.executeOperation({
            chain: "polygon",
            subchain: "mainnet",
            is_evm: true,
            task: { type: "pay", signedPayloads: ["0x00"] },
        } as any)
        expect(sentVia).toEqual([evmProviders.polygon.mainnet])
    })
})

describe("contract_read arguments and method", () => {
    const OWNER = "0x0000000000000000000000000000000000000002"

    it.each([
        ["a JSON list", JSON.stringify([OWNER])],
        ["a JSON object", JSON.stringify({ owner: OWNER })],
        ["an array", [OWNER]],
    ])("accepts params given as %s", async (_label, params) => {
        const op = read("eth", "sepolia")
        op.task.params.params = params

        const res = await handleContractRead(op, 11155111)

        expect(res).toEqual({ result: 7n, status: true })
        expect(provider.call.mock.calls[0][0]).toMatchObject({
            data: new Interface(ABI).encodeFunctionData("balanceOf", [OWNER]),
        })
    })

    const WITH_TRANSFER = [
        ...ABI,
        "function transfer(address,uint256) returns (bool)",
    ]
    it.each([
        ["null params", null, "Missing contract read params"],
        ["no address", { address: "" }, "Missing contract address"],
        ["no ABI", { abi: undefined }, "Missing contract ABI"],
        ["a malformed ABI", { abi: "{not json" }, "Invalid contract ABI"],
        ["a method missing from the ABI", { method: "connect" }, "is not in the ABI"],
        [
            "a state-changing method",
            { abi: WITH_TRANSFER, method: "transfer" },
            "not a view or pure function",
        ],
        ["unparseable params", { params: "{oops" }, "Invalid contract method params"],
        ["a scalar params value", { params: "5" }, "Invalid contract method params"],
    ])("refuses %s without connecting", async (_label, change, error) => {
        const op = read("eth", "sepolia")
        op.task.params =
            change === null ? null : { ...op.task.params, ...(change as object) }

        const res = await handleContractRead(op, 11155111)

        expect(res).toEqual({
            result: "error",
            error: expect.stringContaining(error as string),
        })
        expect(connect).not.toHaveBeenCalled()
    })
})

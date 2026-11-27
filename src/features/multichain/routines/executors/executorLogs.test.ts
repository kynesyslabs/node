/**
 * The Aptos and Ripple XM executors log no params, call arguments, results,
 * signed payloads or full errors: SDK and chain errors can quote any of them.
 * The caller still gets the full result or error.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

const logged: string[] = []
function text(arg: unknown): string {
    if (typeof arg === "string") return arg
    if (arg instanceof Error) return `${arg.stack ?? arg}`
    try {
        return JSON.stringify(arg) ?? String(arg)
    } catch {
        return String(arg)
    }
}
const record = (...args: unknown[]) => {
    logged.push(args.map(text).join(" "))
}
const recordingLog = {
    debug: record,
    info: record,
    warn: record,
    warning: record,
    error: record,
    only: record,
}
mock.module("@/utilities/logger", () => ({ __esModule: true, default: recordingLog }))
mock.module("src/utilities/logger", () => ({ __esModule: true, default: recordingLog }))

const multichain = await import("@kynesyslabs/demosdk/xm-localsdk")
const { default: axios } = await import("axios")
const { default: xmParser } = await import("../XMParser")
const { default: handleAptosContractRead } = await import(
    "./aptos_contract_read"
)
const { genericJsonRpcPay } = await import("./pay")
const { default: handleBalanceQuery } = await import("./balance_query")
const outboundAddress = await import("src/utilities/outboundAddress")
const { Config: appConfig } = await import("src/config")

const ARG = "0xa11ce0000secretargument"
const RESULT = "secretviewresult"
const TX_BLOB = "12000022800000002400secretblob"

function aptos(type: string, params: object): any {
    return { chain: "aptos", subchain: "testnet", is_evm: false, task: { type, params } }
}
const viewParams = {
    moduleAddress: "0x1",
    moduleName: "coin",
    functionName: "balance",
    args: [ARG],
    typeArguments: ["0x1::aptos_coin::AptosCoin"],
}

function expectNotLogged(...values: string[]) {
    const all = logged.join("\n")
    for (const value of values) expect(all).not.toContain(value)
}

afterEach(() => {
    jest.restoreAllMocks()
    logged.length = 0
})

describe("Aptos contract_read logging", () => {
    it("logs no call arguments or view result", async () => {
        spyOn(axios, "post").mockResolvedValue({ data: [RESULT] })
        const res = await xmParser.execute({
            operations: { read: aptos("contract_read", viewParams) },
        } as any)

        expect(res.read).toMatchObject({ result: [RESULT], status: "success" })
        expectNotLogged(ARG, RESULT)
    })

    it("logs no error text that quotes the call arguments", async () => {
        spyOn(axios, "post").mockRejectedValue(
            new Error(`view function failed for arguments ["${ARG}"]`),
        )
        const res = await xmParser.execute({
            operations: { read: aptos("contract_read", viewParams) },
        } as any)

        expect(res.read.error).toContain(ARG)
        expectNotLogged(ARG)
    })

    it("the SDK variant logs no params, arguments or error text", async () => {
        spyOn(multichain.APTOS.prototype, "connect").mockResolvedValue(true)
        spyOn(multichain.APTOS.prototype, "readFromContractDirect").mockRejectedValue(
            new Error(`view function failed for arguments ["${ARG}"]`),
        )
        const res = await handleAptosContractRead(aptos("contract_read", viewParams))

        expect(res.error).toContain(ARG)
        expectNotLogged(ARG)
    })

    it("args of \"null\" still reach the node, which rejects them: the count log line does not throw", async () => {
        const nodeRejection = { message: "Invalid arguments", error_code: "invalid_input" }
        const post = spyOn(axios, "post").mockRejectedValue(
            new axios.AxiosError("Request failed with status code 400", "ERR_BAD_REQUEST", undefined, undefined, {
                status: 400,
                data: nodeRejection,
            } as any),
        )
        const res = await xmParser.execute({
            operations: {
                read: aptos("contract_read", { ...viewParams, args: "null", typeArguments: "null" }),
            },
        } as any)

        expect(res.read as unknown).toEqual({ status: "failed", error: nodeRejection })
        expect(post).toHaveBeenCalledTimes(1)
        expect(post.mock.calls[0][1]).toMatchObject({ arguments: "null", type_arguments: "null" })
        expect(logged.join("\n")).toContain("with 0 argument(s) and 0 type argument(s)")
    })

    it("the SDK variant passes args of \"null\" on to the view call instead of failing in the count log line", async () => {
        spyOn(multichain.APTOS.prototype, "connect").mockResolvedValue(true)
        const view = spyOn(multichain.APTOS.prototype, "readFromContractDirect").mockResolvedValue(
            [RESULT] as any,
        )
        const res = await handleAptosContractRead(
            aptos("contract_read", { ...viewParams, args: "null", typeArguments: "null" }),
        )

        expect(res).toEqual({ result: [RESULT], status: true })
        expect(view.mock.calls[0].slice(3)).toEqual([null, null])
    })
})

describe("Aptos balance_query logging", () => {
    it("logs no address, balance or error text", async () => {
        spyOn(multichain.APTOS.prototype, "connect").mockResolvedValue(true)
        spyOn(multichain.APTOS.prototype, "getAPTBalanceDirect").mockRejectedValue(
            new Error(`account ${ARG} not found`),
        )
        const res = await xmParser.execute({
            operations: {
                balance: aptos("balance_query", {
                    address: ARG,
                    coinType: "0x1::aptos_coin::AptosCoin",
                }),
            },
        } as any)

        expect(res.balance.error).toContain(ARG)
        expectNotLogged(ARG)
    })
})

describe("balance_query logging", () => {
    it("logs the caller's chain as one escaped value of at most 64 characters", async () => {
        const res = await handleBalanceQuery(
            {
                chain: "solana\nforged " + "x".repeat(1000),
                subchain: "mainnet",
                is_evm: false,
                task: { type: "balance_query", params: {} },
            } as any,
            0,
        )

        expect(res.result).toBe("error")
        const lines = logged.filter(line => line.includes("forged"))
        expect(lines).toEqual([
            `[XM Method] Balance Query - Chain: "solana\\nforged ${"x".repeat(49)}"`,
        ])
    })
})

describe("Ripple pay logging", () => {
    it("logs no error text that quotes the signed transaction", async () => {
        spyOn(multichain.XRPL.prototype, "connect").mockImplementation(
            async function (this: any) {
                this.connected = true
                this.provider = {
                    submitAndWait: async (blob: string) => {
                        throw new Error(`tefPAST_SEQ for tx_blob ${blob}`)
                    },
                }
                return true
            },
        )
        const res = await xmParser.execute({
            operations: {
                pay: {
                    chain: "xrpl",
                    subchain: "testnet",
                    is_evm: false,
                    task: { type: "pay", signedPayloads: [TX_BLOB] },
                },
            },
        } as any)

        // A submit that throws may still have reached the ledger
        expect(res.pay).toMatchObject({ result: "unknown" })
        expect(res.pay.error).toContain(TX_BLOB)
        expectNotLogged("secretblob")
        expect(logged).toContain(
            "[XMScript Parser] Ripple Pay: we will use the configured RPC to connect to \"xrpl\" on \"testnet\"",
        )
        expectNotLogged("rippletest.net")
    })

    it("with an allow-listed caller RPC, logs the subchain as one escaped value and no URL", async () => {
        const real = appConfig.getInstance()
        spyOn(appConfig, "getInstance").mockReturnValue({
            ...real,
            outbound: { ...real.outbound, xmRpcAllowlist: ["rpc.partner.example"] },
        } as any)
        // The listed host must resolve to public addresses to be used
        spyOn(outboundAddress, "resolvePublicAddress").mockResolvedValue(undefined as any)
        const connect = spyOn(multichain.XRPL.prototype, "connect").mockResolvedValue(false)
        const subchain = "testnet\n[forged] line " + "x".repeat(1000)
        const res = await xmParser.execute({
            operations: {
                pay: {
                    chain: "xrpl",
                    subchain,
                    rpc: "wss://rpc.partner.example/",
                    is_evm: false,
                    task: { type: "pay", signedPayloads: [TX_BLOB] },
                },
            },
        } as any)

        // The caller's URL was used, and the caller still gets it in the error
        expect(connect).toHaveBeenCalledTimes(1)
        expect(res.pay.error).toContain("rpc.partner.example")
        const escaped = `"testnet\\n[forged] line ${"x".repeat(41)}"`
        expect(logged.filter(line => line.includes("Ripple Pay: "))).toEqual([
            `[XMScript Parser] Ripple Pay: "xrpl" on ${escaped}`,
            `[XMScript Parser] Ripple Pay: we will use the allow-listed caller RPC to connect to "xrpl" on ${escaped}`,
            "[XMScript Parser] Ripple Pay: trying to send the payload as a signed transaction...",
        ])
        for (const line of logged) expect(line).not.toContain("\n")
        expectNotLogged("rpc.partner.example", `line ${"x".repeat(42)}`)
    })
})

describe("Generic JSON-RPC pay logging", () => {
    it("logs the chain and subchain of a pay as escaped values of at most 64 characters", async () => {
        const sdk = {
            create: async () => ({ sendTransaction: async () => ({ result: "success" }) }),
        }
        await genericJsonRpcPay(sdk, "https://rpc.example/", {
            chain: "multiversx",
            subchain: "testnet\nforged " + "x".repeat(1000),
            is_evm: false,
            task: { type: "pay", signedPayloads: [TX_BLOB] },
        } as any)

        expect(logged.filter(line => line.includes("Pay on:"))).toEqual([
            `[XMScript Parser] Generic JSON RPC Pay on: "multiversx"."testnet\\nforged ${"x".repeat(48)}"`,
        ])
    })

    it("logs the chain and subchain of a failed pay as escaped values of at most 64 characters", async () => {
        const sdk = {
            create: async () => ({
                sendTransaction: async () => {
                    throw new Error("rejected")
                },
            }),
        }
        await genericJsonRpcPay(sdk, "https://rpc.example/", {
            chain: "multiversx\nforged " + "x".repeat(1000),
            subchain: "testnet",
            is_evm: false,
            task: { type: "pay", signedPayloads: [TX_BLOB] },
        } as any)

        const failed = logged.filter(line => line.includes("failed:"))
        expect(failed).toEqual([
            `[XMScript Parser] Generic JSON RPC Pay on "multiversx\\nforged ${"x".repeat(45)}"."testnet" failed: Error`,
        ])
    })
})

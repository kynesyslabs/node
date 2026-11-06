/**
 * An XM operation may name its own RPC URL. The node must not fetch whatever
 * URL a caller names (cloud metadata, the operator's private network): it uses
 * its configured RPC for the chain, and a caller URL only when the operator
 * allow-listed it.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

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
const { chainProviders } = await import(
    "sdk/localsdk/multichain/configs/chainProviders"
)
const { evmProviders } = await import(
    "sdk/localsdk/multichain/configs/evmProviders"
)
const { default: handlePayOperation } = await import("./pay")
const { default: handleContractWrite } = await import("./contract_write")
const { pickRpcUrl } = await import("./rpcUrl")
const { Config } = await import("src/config")

const METADATA = "http://169.254.169.254/latest/meta-data/"

function op(chain: string, subchain: string, isEvm = false): any {
    return {
        chain,
        subchain,
        is_evm: isEvm,
        rpc: METADATA,
        task: { type: "pay", signedPayloads: ["00"] },
    }
}

/** Records the URL the executor hands the chain SDK, without touching the network. */
function captureCreate(sdk: any) {
    const urls: string[] = []
    spyOn(sdk, "create").mockImplementation(async (url: string) => {
        urls.push(url)
        return { sendTransaction: async () => ({ result: "success" }) }
    })
    return urls
}

afterEach(() => {
    jest.restoreAllMocks()
})

describe("XM executors ignore a caller-named RPC URL", () => {
    it("pay on a non-EVM chain uses the configured RPC", async () => {
        const urls = captureCreate(multichain.TON)
        await handlePayOperation(op("ton", "mainnet"), 0)
        expect(urls).toEqual([chainProviders.ton.mainnet])
    })

    it("pay on an EVM chain uses the configured RPC", async () => {
        const urls: string[] = []
        spyOn(multichain.EVM, "getInstance").mockReturnValue(null as any)
        spyOn(multichain.EVM, "createInstance").mockImplementation(((
            _id: number,
            url: string,
        ) => {
            urls.push(url)
            return { connect: async () => true } as any
        }) as any)
        await handlePayOperation(op("eth", "sepolia", true), 11155111).catch(
            () => undefined,
        )
        expect(urls).toEqual([evmProviders.eth.sepolia])
    })

    it("contract_write on TON and MultiversX uses the configured RPC", async () => {
        const ton = captureCreate(multichain.TON)
        const egld = captureCreate(multichain.MULTIVERSX)
        await handleContractWrite(op("ton", "mainnet"), 0)
        await handleContractWrite(op("egld", "mainnet"), 0)
        expect(ton).toEqual([chainProviders.ton.mainnet])
        expect(egld).toEqual([chainProviders.egld.mainnet])
    })

    it("contract_write on an EVM chain uses the configured RPC", async () => {
        const urls: string[] = []
        spyOn(multichain.EVM, "getInstance").mockReturnValue(null as any)
        spyOn(multichain.EVM, "createInstance").mockImplementation(((
            _id: number,
            url: string,
        ) => {
            urls.push(url)
            return {
                connect: async () => true,
                sendSignedTransaction: async () => ({ result: "success" }),
            } as any
        }) as any)
        await handleContractWrite(op("eth", "sepolia", true), 11155111)
        expect(urls).toEqual([evmProviders.eth.sepolia])
    })
})

describe("an allow-listed caller RPC stays with that caller", () => {
    const partner = "https://rpc.partner.example/"

    it.each([
        ["pay", (o: any) => handlePayOperation(o, 11155111)],
        ["contract_write", (o: any) => handleContractWrite(o, 11155111)],
    ])("%s: a later caller on the chain gets the configured RPC", async (_n, run) => {
        // The SDK caches one EVM instance per chain id for the whole process.
        const cache = (multichain.EVM as any).instances as Map<number, unknown>
        const saved = new Map(cache)
        cache.clear()
        const real = Config.getInstance()
        spyOn(Config, "getInstance").mockReturnValue({
            ...real,
            outbound: { ...real.outbound, xmRpcAllowlist: ["rpc.partner.example"] },
        } as any)

        const used: string[] = []
        spyOn(multichain.EVM.prototype, "connect").mockResolvedValue(true)
        spyOn(multichain.EVM.prototype, "sendSignedTransaction").mockImplementation(
            async function (this: any) {
                used.push(this.rpc_url)
                return { result: "success", hash: "0x" }
            },
        )
        try {
            await run({ ...op("eth", "sepolia", true), rpc: partner })
            await run({ ...op("eth", "sepolia", true), rpc: undefined })
            expect(used).toEqual([partner, evmProviders.eth.sepolia])
        } finally {
            cache.clear()
            for (const [k, v] of saved) cache.set(k, v)
        }
    })
})

describe("pickRpcUrl", () => {
    const configured = "https://rpc.configured.example/"

    it("uses the caller URL only when its host or origin is allow-listed", () => {
        const caller = "https://rpc.partner.example:8545/v1"
        expect(pickRpcUrl(caller, configured, [])).toBe(configured)
        expect(pickRpcUrl(caller, configured, ["rpc.partner.example"])).toBe(caller)
        expect(pickRpcUrl(caller, configured, ["RPC.Partner.Example"])).toBe(caller)
        expect(
            pickRpcUrl(caller, configured, ["https://rpc.partner.example:8545"]),
        ).toBe(caller)
        expect(
            pickRpcUrl(caller, configured, ["https://rpc.partner.example"]),
        ).toBe(configured)
        expect(pickRpcUrl(caller, configured, ["partner.example"])).toBe(
            configured,
        )
    })

    it("refuses non-http(s)/ws(s) schemes and malformed URLs even when listed", () => {
        expect(pickRpcUrl("file:///etc/passwd", configured, ["", "etc"])).toBe(
            configured,
        )
        expect(pickRpcUrl("not a url", configured, ["not a url"])).toBe(configured)
        expect(pickRpcUrl(42, configured, ["42"])).toBe(configured)
    })

    it("falls back to the configured URL when the caller named none", () => {
        expect(pickRpcUrl(undefined, configured, ["x"])).toBe(configured)
        expect(pickRpcUrl("", configured, ["x"])).toBe(configured)
    })
})

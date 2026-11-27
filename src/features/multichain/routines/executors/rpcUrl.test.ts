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
const { Config: appConfig } = await import("src/config")

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
    // A public IP literal: the host check needs no DNS for it.
    const partner = "https://8.8.8.8/"

    it.each([
        ["pay", (o: any) => handlePayOperation(o, 11155111)],
        ["contract_write", (o: any) => handleContractWrite(o, 11155111)],
    ])("%s: a later caller on the chain gets the configured RPC", async (_n, run) => {
        // The SDK caches one EVM instance per chain id for the whole process.
        const cache = (multichain.EVM as any).instances as Map<number, unknown>
        const saved = new Map(cache)
        cache.clear()
        const real = appConfig.getInstance()
        spyOn(appConfig, "getInstance").mockReturnValue({
            ...real,
            outbound: { ...real.outbound, xmRpcAllowlist: ["8.8.8.8"] },
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

describe("EVM RPC lookup reads configured keys only", () => {
    it.each([
        ["constructor", "name"],
        ["constructor", "constructor"],
        ["constructor", "length"],
        ["eth", "toString"],
        ["eth", "__proto__"],
        ["toString", "name"],
        ["__proto__", "sepolia"],
        ["hasOwnProperty", "name"],
        ["eth", "unknown"],
        ["unknown", "sepolia"],
    ])("pay on %s.%s reports the RPC URL as not found", async (chain, subchain) => {
        const create = spyOn(multichain.EVM, "createInstance")
        spyOn(multichain.EVM, "getInstance").mockReturnValue(null as any)
        const result = await handlePayOperation(
            { ...op(chain, subchain, true), rpc: undefined },
            1,
        )
        expect(result).toEqual({
            result: "error",
            error: `RPC URL not found for ${chain}.${subchain}`,
        })
        expect(create).not.toHaveBeenCalled()
    })

    it("contract_write on an inherited key reports the RPC URL as not found", async () => {
        const create = spyOn(multichain.EVM, "createInstance")
        spyOn(multichain.EVM, "getInstance").mockReturnValue(null as any)
        const result = await handleContractWrite(
            { ...op("constructor", "name", true), rpc: undefined },
            1,
        )
        expect(result).toEqual({
            result: "error",
            error: "RPC URL not found for constructor.name",
        })
        expect(create).not.toHaveBeenCalled()
    })
})

describe("pickRpcUrl", () => {
    const configured = "https://rpc.configured.example/"
    const publicHost = async () => "8.8.8.8"
    const pick = (caller: unknown, allowlist: string[]) =>
        pickRpcUrl(caller, configured, allowlist, publicHost)

    it("uses the caller URL only when its host or origin is allow-listed", async () => {
        const caller = "https://rpc.partner.example:8545/v1"
        expect(await pick(caller, [])).toBe(configured)
        expect(await pick(caller, ["rpc.partner.example"])).toBe(caller)
        expect(await pick(caller, ["RPC.Partner.Example"])).toBe(caller)
        expect(await pick(caller, ["https://rpc.partner.example:8545"])).toBe(caller)
        expect(await pick(caller, ["https://rpc.partner.example"])).toBe(configured)
        expect(await pick(caller, ["partner.example"])).toBe(configured)
    })

    it("refuses non-http(s)/ws(s) schemes and malformed URLs even when listed", async () => {
        expect(await pick("file:///etc/passwd", ["", "etc"])).toBe(configured)
        expect(await pick("not a url", ["not a url"])).toBe(configured)
        expect(await pick(42, ["42"])).toBe(configured)
    })

    it("falls back to the configured URL when the caller named none", async () => {
        expect(await pick(undefined, ["x"])).toBe(configured)
        expect(await pick("", ["x"])).toBe(configured)
    })
})

describe("an allow-listed RPC host must be public", () => {
    const configured = "https://rpc.configured.example/"

    it.each([
        ["http://127.0.0.1:8545/", "127.0.0.1"],
        ["http://10.0.0.5:8545/", "10.0.0.5"],
        ["http://169.254.169.254/latest/", "169.254.169.254"],
        ["http://[::1]:8545/", "[::1]"],
        ["http://[fd00::1]/", "[fd00::1]"],
        ["http://[::ffff:127.0.0.1]/", "[::ffff:7f00:1]"],
    ])("ignores listed literal %s", async (caller, host) => {
        // Listed: with a resolver that lets it through, the caller URL wins.
        expect(await pickRpcUrl(caller, configured, [host], async () => host)).toBe(caller)
        // The real resolver: literals are judged without DNS.
        expect(await pickRpcUrl(caller, configured, [host])).toBe(configured)
    })

    it("ignores a listed name that resolves to a private address", async () => {
        const toPrivate = async () => {
            throw new Error("Target rpc.internal.example resolves to a private, loopback or link-local address")
        }
        expect(
            await pickRpcUrl("https://rpc.internal.example/", configured, ["rpc.internal.example"], toPrivate),
        ).toBe(configured)
    })

    it("ignores a listed name that does not resolve", async () => {
        const unresolved = async () => {
            throw Object.assign(new Error("getaddrinfo ENOTFOUND rpc.partner.invalid"), { code: "ENOTFOUND" })
        }
        expect(
            await pickRpcUrl("https://rpc.partner.invalid/", configured, ["rpc.partner.invalid"], unresolved),
        ).toBe(configured)
    })

    it("uses a listed public literal", async () => {
        expect(await pickRpcUrl("https://8.8.8.8/", configured, ["8.8.8.8"])).toBe("https://8.8.8.8/")
    })
})

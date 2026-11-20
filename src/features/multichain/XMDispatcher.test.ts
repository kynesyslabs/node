/**
 * The XM entry point logs what a script asks for (operation types, chains and
 * counts), never its payloads or signed data, and lists at most 10
 * operations. Its result keeps each
 * operation's outcome.
 */

import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

const logged: string[] = []
function text(arg: unknown): string {
    if (typeof arg === "string") return arg
    if (arg instanceof Error) return `${arg.stack ?? arg}`
    try {
        return (
            JSON.stringify(arg, (_k, v) =>
                typeof v === "bigint" ? v.toString() : v,
            ) ?? String(arg)
        )
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
const { default: multichainDispatcher } = await import("./XMDispatcher")
const { default: xmParser } = await import("./routines/XMParser")

const SIGNED_OK = "0x02f8aa11signedok"
const SIGNED_REJECTED = "0x02f8bb22signedrejected"

function pay(signed: string): any {
    return {
        chain: "eth",
        subchain: "sepolia",
        is_evm: true,
        task: { type: "pay", signedPayloads: [signed] },
    }
}

/** Broadcasts succeed except the rejected payload, whose error names the tx as ethers errors do. */
function fakeChain() {
    spyOn(multichain.EVM, "getInstance").mockReturnValue({
        sendSignedTransaction: async (tx: string) => {
            if (tx === SIGNED_REJECTED) {
                throw new Error(
                    `insufficient funds for intrinsic transaction cost (transaction="${tx}", code=INSUFFICIENT_FUNDS)`,
                )
            }
            return { result: "success", hash: "0x01" }
        },
    } as any)
}

afterEach(() => {
    jest.restoreAllMocks()
    logged.length = 0
})

describe("XM script logging", () => {
    it("logs operation types, chains and counts, and no payloads or signed data", async () => {
        fakeChain()
        await multichainDispatcher.digest({
            operations: { first: pay(SIGNED_OK), second: pay(SIGNED_REJECTED) },
        } as any)

        const all = logged.join("\n")
        expect(all).toContain("\"pay\" on \"eth\".\"sepolia\"")
        expect(all).not.toContain("signedok")
        expect(all).not.toContain("signedrejected")
    })

    it("logs each operation type, chain and subchain as one escaped value of at most 64 characters", async () => {
        const field = (name: string) => `${name}\nforged ` + "x".repeat(1000)
        const logs = (name: string) => `"${name}\\nforged ` + "x".repeat(64 - name.length - 9) + "\""
        await multichainDispatcher.digest({
            operations: {
                odd: {
                    chain: field("chain"),
                    subchain: field("sub"),
                    is_evm: true,
                    task: { type: field("type") },
                },
            },
        } as any)

        const lines = logged.filter(line => line.includes("forged"))
        // the dispatcher summary and the parser's line for the operation
        expect(lines).toHaveLength(2)
        for (const line of lines) {
            expect(line).not.toContain("\n")
            expect(line).toContain(`${logs("type")} on ${logs("chain")}.${logs("sub")}`)
            expect(line).not.toContain("x".repeat(64))
        }
    })

    it("logs a field that is not a string as its type", async () => {
        await multichainDispatcher.digest({
            operations: {
                odd: { chain: { url: "x" }, subchain: 5, is_evm: true, task: {} },
            },
        } as any)

        expect(logged.join("\n")).toContain("undefined on object.number")
    })

    it("logs a long string `operations` as no operations, without walking it", async () => {
        // The parser's own loop over operations is not under test here
        spyOn(xmParser,"execute").mockResolvedValue({})

        const started = performance.now()
        await multichainDispatcher.digest({ operations: "a".repeat(4_000_000) } as any)
        const elapsed = performance.now() - started

        expect(elapsed).toBeLessThan(100)
        expect(logged).toContain("[XMChain Digestion] Processing 0 operation(s): ")
        expect(logged.every(line => line.length < 1000)).toBe(true)
    })

    it("logs the first 10 operations and counts the rest", async () => {
        const operations = Object.fromEntries(
            Array.from({ length: 1000 }, (_, i) => [
                `op${i}`,
                { chain: "c", subchain: "s", is_evm: false, task: { type: `t${i}` } },
            ]),
        )
        const first10 = Array.from({ length: 10 }, (_, i) => `"t${i}" on "c"."s"`).join(", ")

        await multichainDispatcher.digest({ operations } as any)

        expect(logged).toContain(
            `[XMChain Digestion] Processing 1000 operation(s): ${first10}, 990 more`,
        )
        expect(logged.filter(line => line.startsWith("[XMParser] Operation"))).toHaveLength(10)
        expect(logged.filter(line => line.startsWith("[RESULT]"))).toHaveLength(10)
        expect(logged).toContain("[XMParser] 990 more operation(s) not listed")
    })

    it("logs the size of the results, not their content", async () => {
        spyOn(xmParser,"execute").mockResolvedValue({
            read: { result: "readvalue" },
        } as any)

        await multichainDispatcher.digest({ operations: {} } as any)

        const all = logged.join("\n")
        expect(all).toContain("[XM EXECUTE] results serialised, 31 chars")
        expect(all).not.toContain("readvalue")
    })
})

describe("XM script result", () => {
    it("reports a partly failed script as partial_success, with each operation's result", async () => {
        fakeChain()
        const res = await multichainDispatcher.digest({
            operations: { first: pay(SIGNED_OK), second: pay(SIGNED_REJECTED) },
        } as any)

        expect(res.success).toBe(true)
        expect(res.message).toBe("partial_success")
        expect(res.results.first).toMatchObject({ result: "success" })
        expect(res.results.second).toMatchObject({ result: "error" })
    })

    it("reports success when every operation succeeded", async () => {
        fakeChain()
        const res = await multichainDispatcher.digest({
            operations: { first: pay(SIGNED_OK), second: pay(SIGNED_OK) },
        } as any)

        expect(res).toMatchObject({ success: true, message: "all_ops_ok" })
    })

    it("reports failure when every operation failed", async () => {
        fakeChain()
        const res = await multichainDispatcher.digest({
            operations: { only: pay(SIGNED_REJECTED) },
        } as any)

        expect(res).toMatchObject({ success: false, message: "all_ops_failed" })
    })

    it("refuses a script whose results cannot be serialised", async () => {
        spyOn(xmParser,"execute").mockResolvedValue({
            read: { result: 5n },
        } as any)

        await expect(
            multichainDispatcher.digest({
                operations: {
                    read: {
                        chain: "eth",
                        subchain: "mainnet",
                        is_evm: true,
                        task: { type: "contract_read" },
                    },
                },
            } as any),
        ).rejects.toThrow(TypeError)
    })
})

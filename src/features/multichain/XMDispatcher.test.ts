/**
 * MultichainDispatcher.digest takes only a script whose operations are a
 * plain object of at most MAX_XM_OPERATIONS entries; anything else gets the
 * dispatcher's failure reply before the parser runs. Scripts within the
 * bound run as before, and the parser runs the operations present when it
 * starts.
 */

import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test"

const quietLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    only: jest.fn(),
}
mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: quietLog,
}))
mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: quietLog,
}))

const { default: parser } =
    await import("src/features/multichain/routines/XMParser")
const dispatcherModule: any =
    await import("src/features/multichain/XMDispatcher")
const dispatcher = dispatcherModule.default

const executeOperation = jest.spyOn(parser, "executeOperation")
const parserExecute = jest.spyOn(parser, "execute")

function op(n: number): any {
    return {
        chain: "evm",
        subchain: "sepolia",
        is_evm: true,
        rpc: null,
        task: {
            type: "balance_query",
            params: { address: "0x" + String(n).padStart(40, "0") },
        },
    }
}

function opsOf(count: number) {
    const operations: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) operations["op" + i] = op(i)
    return operations
}

beforeEach(() => {
    delete process.env.XM_ENABLED
    executeOperation.mockReset()
    executeOperation.mockImplementation(async () => ({ result: "ok" }))
    parserExecute.mockClear()
})

afterAll(() => {
    executeOperation.mockRestore()
    parserExecute.mockRestore()
})

describe("MultichainDispatcher.digest operations bound", () => {
    it("names the bound as 32 operations", () => {
        expect(dispatcherModule.MAX_XM_OPERATIONS).toBe(32)
    })

    it.each([
        ["a string", "abcd"],
        ["an array", [op(0), op(1)]],
        ["null", null],
        ["a number", 7],
    ])(
        "refuses operations that are %s without running the parser",
        async (_label, operations) => {
            const res = await dispatcher.digest({ operations } as any)
            expect(res.success).toBe(false)
            expect(res.results).toEqual({})
            expect(typeof res.message).toBe("string")
            expect(parserExecute).not.toHaveBeenCalled()
            expect(executeOperation).not.toHaveBeenCalled()
        },
    )

    class OperationSet {}

    it.each([
        ["a Date", () => Object.assign(new Date(0), { op0: op(0) })],
        ["a Map", () => new Map([["op0", op(0)]])],
        [
            "a class instance",
            () => Object.assign(new OperationSet(), { op0: op(0) }),
        ],
    ])(
        "refuses operations that are %s without running the parser",
        async (_label, make) => {
            const res = await dispatcher.digest({ operations: make() } as any)
            expect(res).toEqual({
                success: false,
                message:
                    "XM script refused: operations must be an object of at most 32 entries",
                results: {},
            })
            expect(parserExecute).not.toHaveBeenCalled()
            expect(executeOperation).not.toHaveBeenCalled()
        },
    )

    it("runs operations held in an object with a null prototype", async () => {
        const operations = Object.assign(Object.create(null), { op0: op(0) })
        const res = await dispatcher.digest({ operations } as any)
        expect(res).toEqual({
            success: true,
            message: "all_ops_ok",
            results: { op0: { result: "ok" } },
        })
        expect(executeOperation.mock.calls.map(c => c[0])).toEqual([op(0)])
    })

    it("refuses 33 operations without running the parser", async () => {
        const res = await dispatcher.digest({ operations: opsOf(33) } as any)
        expect(res.success).toBe(false)
        expect(res.results).toEqual({})
        expect(res.message).toContain("32")
        expect(parserExecute).not.toHaveBeenCalled()
        expect(executeOperation).not.toHaveBeenCalled()
    })

    it("runs 32 operations", async () => {
        const res = await dispatcher.digest({ operations: opsOf(32) } as any)
        expect(res.success).toBe(true)
        expect(res.message).toBe("all_ops_ok")
        expect(Object.keys(res.results)).toEqual(Object.keys(opsOf(32)))
        expect(executeOperation).toHaveBeenCalledTimes(32)
    })

    it("runs an ordinary two-operation script as before", async () => {
        const first = op(1)
        const second = op(2)
        executeOperation
            .mockImplementationOnce(async () => ({ result: "ok" }))
            .mockImplementationOnce(async () => ({
                result: "error",
                error: "boom",
            }))
        const res = await dispatcher.digest({
            operations: { first, second },
        } as any)
        expect(res).toEqual({
            success: true,
            message: "partial_success",
            results: {
                first: { result: "ok" },
                second: { result: "error", error: "boom" },
            },
        })
        expect(executeOperation.mock.calls.map(c => c[0])).toEqual([
            first,
            second,
        ])
    })
})

describe("XMParser.execute", () => {
    it("runs the operations present when execution starts", async () => {
        const script: any = { operations: { first: op(1), second: op(2) } }
        executeOperation.mockImplementationOnce(async () => {
            script.operations.added = op(9)
            return { result: "ok" }
        })
        const results = await parser.execute(script)
        expect(Object.keys(results)).toEqual(["first", "second"])
        expect(executeOperation).toHaveBeenCalledTimes(2)
    })
})

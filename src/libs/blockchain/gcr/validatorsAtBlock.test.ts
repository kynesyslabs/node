import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

let failWith: Error | null = null
const find = mock(async () => {
    if (failWith) throw failWith
    return [{ address: "0xbeef" }]
})

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: mock(), info: mock(), warn: mock(), warning: mock(), error: mock(), only: mock() },
}))

const datasourceModule = await import("src/model/datasource")
const { default: GCR } = await import("./gcr")

const getInstance = spyOn(datasourceModule.default, "getInstance").mockImplementation(
    async () =>
        ({
            getDataSource: () => ({ getRepository: () => ({ find }) }),
        }) as never,
)
afterAll(() => getInstance.mockRestore())

describe("validators at a block", () => {
    beforeEach(() => {
        failWith = null
        find.mockClear()
    })

    it("reads the same rows either way", async () => {
        expect(await GCR.getGCRValidatorsAtBlock(5)).toEqual([{ address: "0xbeef" }])
        expect(await GCR.getGCRValidatorsAtBlockOrThrow(5)).toEqual([{ address: "0xbeef" }] as never)
        expect(find.mock.calls[0]).toEqual(find.mock.calls[1])
    })

    it("tells a failed read from an empty table only in the throwing form", async () => {
        failWith = new Error("connection terminated")
        expect(await GCR.getGCRValidatorsAtBlock(5)).toEqual([])
        await expect(GCR.getGCRValidatorsAtBlockOrThrow(5)).rejects.toThrow("connection terminated")
    })
})

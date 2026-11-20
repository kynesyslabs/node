import { expect, it, jest, spyOn } from "bun:test"
import * as chainDb from "./chainDb"
const query = {
    select: jest.fn(() => query), orderBy: jest.fn(() => query),
    limit: jest.fn(() => query), getOne: jest.fn(async () => ({ number: 42 })),
}
spyOn(chainDb, "getBlocksRepo").mockReturnValue({ createQueryBuilder: () => query } as any)
const { getLastStoredBlockNumber } = await import("./chainBlocks")
it("reads only the stored block number, even when memory is behind", async () => {
    expect(await getLastStoredBlockNumber()).toBe(42)
    expect(query.select).toHaveBeenCalledWith("block.number")
    expect(query.orderBy).toHaveBeenCalledWith("block.number", "DESC")
    expect(query.limit).toHaveBeenCalledWith(1)
})

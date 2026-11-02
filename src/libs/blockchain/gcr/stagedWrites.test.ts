import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

/**
 * Edit routines that write their own tables (validator stake, governance)
 * must not reach the database during the apply: their saves are staged
 * and issued through the entity manager of the block's transaction.
 */

const durable = new Map<string, unknown[]>()
const issued: string[] = []
/** Rows the fake database holds, keyed by table. */
let seeded: Record<string, any[]> = {}

const nameOf = (entity: any) => entity?.name ?? String(entity)

function repoFor(table: string, sink: Map<string, unknown[]>, tag: string) {
    const query: any = {
        select: () => query,
        getRawOne: async () => ({ max: null }),
    }
    return {
        target: { name: table },
        create: (row: unknown) => row,
        findOneBy: async (where: Record<string, unknown>) =>
            (seeded[table] ?? []).find(row =>
                Object.entries(where).every(([k, v]) => row[k] === v),
            ) ?? null,
        findOne: async ({ where }: { where: Record<string, unknown> }) =>
            (seeded[table] ?? []).find(row =>
                Object.entries(where).every(([k, v]) => row[k] === v),
            ) ?? null,
        find: async () => [],
        save: async (rows: unknown) => {
            issued.push(`${tag}:${table}`)
            const list = Array.isArray(rows) ? rows : [rows]
            sink.set(table, [...(sink.get(table) ?? []), ...list])
            return rows
        },
        createQueryBuilder: () => query,
    }
}

const fakeDataSource = {
    getRepository: (entity: any) => repoFor(nameOf(entity), durable, "direct"),
    transaction: async (work: (em: unknown) => Promise<unknown>) =>
        work({ getRepository: (entity: any) => repoFor(nameOf(entity), durable, "em") }),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const { default: HandleGCR } = await import("./handleGCR")
const { default: Chain } = await import("../chain")

const caches = (): any => ({
    accounts: new Map(),
    storagePrograms: new Map(),
    tlsNotaries: new Map(),
    atomicWorks: new Map(),
    resourceSlots: new Map(),
})

const stake = (amount: string): any => ({
    type: "validatorStake",
    operation: "stake",
    account: "0xabc",
    amount,
    connectionUrl: "https://v1.example",
})

beforeEach(() => {
    durable.clear()
    issued.length = 0
    seeded = {}
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(100)
})

describe("validator stake edits", () => {
    it("stages the row instead of saving it, and writes it through the block's manager", async () => {
        const entities = caches()
        const result = await HandleGCR.applyGCREdit(stake("5"), entities, false, false)

        expect(result.success).toBe(true)
        expect(issued).toEqual([])
        expect(durable.size).toBe(0)
        expect(result.deferredWrite).toBeDefined()

        await fakeDataSource.transaction(async em => result.deferredWrite!(em as any))

        expect(issued).toEqual(["em:Validators"])
        expect(durable.get("Validators")).toMatchObject([
            { address: "0xabc", staked_amount: "5", status: expect.any(String) },
        ])
    })

    it("lets a later edit in the same set read what an earlier one staged", async () => {
        const entities = caches()
        const first = await HandleGCR.applyGCREdit(stake("5"), entities, false, false)
        const second = await HandleGCR.applyGCREdit(stake("7"), entities, false, false)

        expect(first.success).toBe(true)
        expect(second.success).toBe(true)
        expect(second.message).toBe("Stake increased")
        expect(entities.validators.get("0xabc").staked_amount).toBe("12")
        expect(issued).toEqual([])
    })

    it("reads an existing row from the database once, then from the set", async () => {
        seeded = {
            Validators: [{ address: "0xabc", status: "active", staked_amount: "10" }],
        }
        const entities = caches()
        const result = await HandleGCR.applyGCREdit(stake("1"), entities, false, false)

        expect(result.success).toBe(true)
        expect(entities.validators.get("0xabc").staked_amount).toBe("11")
        expect(durable.size).toBe(0)
    })

    it("writes nothing when simulated", async () => {
        const result = await HandleGCR.applyGCREdit(stake("5"), caches(), false, true)

        expect(result.success).toBe(true)
        expect(result.deferredWrite).toBeUndefined()
        expect(issued).toEqual([])
    })
})

describe("governance edits", () => {
    it("stages a proposal row for the block's transaction", async () => {
        const edit: any = {
            type: "networkUpgrade",
            account: "0xabc",
            proposalId: "p1",
            proposedParameters: { networkFee: "2" },
            effectiveAtBlock: 100_000,
            rationale: "test",
        }
        const result = await HandleGCR.applyGCREdit(edit, caches(), false, false)

        expect(result.success).toBe(true)
        expect(issued).toEqual([])
        expect(result.deferredWrite).toBeDefined()

        await fakeDataSource.transaction(async em => result.deferredWrite!(em as any))

        expect(issued).toEqual(["em:NetworkUpgrade"])
        expect(durable.get("NetworkUpgrade")).toMatchObject([{ proposalId: "p1" }])
    })
})

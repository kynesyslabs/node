/**
 * The validator set record and its snapshots. The hash goes into every block
 * under finalityProofs, so the record must not depend on row order or on
 * fields that do not decide committee membership, and a snapshot row must
 * exist for every height a committee is drawn at: block 0 and each block
 * that changed the set.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { createHash } from "node:crypto"
import { getMetadataArgsStorage } from "typeorm"
import type { FindOperator, QueryRunner } from "typeorm"
import { Validators } from "src/model/entities/Validators"
import { ValidatorSetSnapshots } from "src/model/entities/ValidatorSetSnapshots"
import { CreateValidatorSetSnapshots1793404800000 } from "@/migrations/1793404800000-CreateValidatorSetSnapshots"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

interface Row {
    address: string
    staked_amount: string | null
    status: string | null
    valid_at: number | null
    connection_url?: string | null
}
interface Snapshot {
    block: number
    setHash: string
    validators: unknown[]
}

let validators: Row[] = []
let snapshots: Snapshot[] = []

const matches = (value: number, op: FindOperator<number>): boolean => {
    const bound = op.value as number
    switch (op.type) {
        case "lessThanOrEqual":
            return value <= bound
        case "moreThan":
            return value > bound
        case "moreThanOrEqual":
            return value >= bound
        default:
            throw new Error(`unexpected operator ${op.type}`)
    }
}

const snapshotRepo = {
    findOne: async ({ where }: { where: { block: FindOperator<number> } }) =>
        snapshots
            .filter(s => matches(s.block, where.block))
            .sort((a, b) => b.block - a.block)[0] ?? null,
    delete: async ({ block }: { block: FindOperator<number> }) => {
        snapshots = snapshots.filter(s => !matches(s.block, block))
    },
    insert: async (row: Snapshot) => {
        if (snapshots.some(s => s.block === row.block)) {
            throw new Error(`duplicate key ${row.block}`)
        }
        snapshots.push(structuredClone(row))
    },
    upsert: async (row: Snapshot) => {
        snapshots = snapshots.filter(s => s.block !== row.block)
        snapshots.push(structuredClone(row))
    },
}
const em: any = {
    getRepository: (target: unknown) => {
        if (target === ValidatorSetSnapshots) return snapshotRepo
        if (target === Validators) return { find: async () => structuredClone(validators) }
        throw new Error("unexpected repository")
    },
}
mock.module("src/model/datasource", () => ({
    __esModule: true,
    dataSource: {},
    default: {
        getInstance: async () => ({
            getDataSource: () => ({
                manager: em,
                getRepository: em.getRepository,
                transaction: async (fn: (m: unknown) => unknown) => await fn(em),
            }),
        }),
    },
}))

const { getSharedState } = await import("@/utilities/sharedState")
const {
    ValidatorSetHistoryError: historyError,
    activeIdentities,
    ensureValidatorSetSnapshot,
    pruneValidatorSetSnapshots,
    recordValidatorSetSnapshot,
    validatorSetAt,
    validatorSetHash,
    validatorSetRecord,
} = await import("./validatorSet")

const V = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(32)
const row = (n: number, extra: Partial<Row> = {}): Row => ({
    address: V(n),
    staked_amount: "1000",
    status: "2",
    valid_at: 0,
    connection_url: `http://node-${n}`,
    ...extra,
})

beforeEach(() => {
    validators = [row(1), row(2), row(3)]
    snapshots = []
})

describe("validator set record", () => {
    it("is sorted by lowercase identity and holds only what decides membership", () => {
        const record = validatorSetRecord([
            row(2, { address: V(2).toUpperCase().replace("0X", "0x") }),
            row(1, { staked_amount: null, valid_at: null, status: null }),
        ])
        expect(record).toEqual([
            { identity: V(1), stake: "0", status: null, validAt: null },
            { identity: V(2), stake: "1000", status: "2", validAt: 0 },
        ])
    })

    it("hashes the JCS bytes of the record", () => {
        const record = validatorSetRecord([row(1)])
        const bytes = `[{"identity":"${V(1)}","stake":"1000","status":"2","validAt":0}]`
        expect(validatorSetHash(record)).toBe(
            createHash("sha256").update(bytes).digest("hex"),
        )
        expect(validatorSetHash([])).toBe(createHash("sha256").update("[]").digest("hex"))
    })

    it("hashes the same whatever order the rows come in", () => {
        const rows = [row(3), row(1), row(2), row(4, { status: "0" })]
        const reference = validatorSetHash(validatorSetRecord(rows))
        for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]]) {
            expect(validatorSetHash(validatorSetRecord(order.map(i => rows[i])))).toBe(reference)
        }
    })

    it("changes with stake, status and validAt, not with the connection URL", () => {
        const base = validatorSetHash(validatorSetRecord([row(1)]))
        expect(validatorSetHash(validatorSetRecord([row(1, { staked_amount: "1001" })]))).not.toBe(base)
        expect(validatorSetHash(validatorSetRecord([row(1, { status: "3" })]))).not.toBe(base)
        expect(validatorSetHash(validatorSetRecord([row(1, { valid_at: 1 })]))).not.toBe(base)
        expect(validatorSetHash(validatorSetRecord([row(1, { connection_url: "x" })]))).toBe(base)
    })

    it("counts active identities valid at the height", () => {
        const record = validatorSetRecord([
            row(1),
            row(2, { status: "0" }),
            row(3, { status: "3" }),
            row(4, { valid_at: 6 }),
            row(5, { valid_at: null }),
        ])
        expect([...activeIdentities(record, 5)]).toEqual([V(1)])
        expect([...activeIdentities(record, 6)]).toEqual([V(1), V(4)])
    })
})

describe("snapshots written with a block", () => {
    beforeEach(async () => {
        await ensureValidatorSetSnapshot(0)
    })

    it("writes no row for a block that left the set as it was", async () => {
        expect(await recordValidatorSetSnapshot(em, 1)).toBe(false)
        expect(snapshots.map(s => s.block)).toEqual([0])
    })

    it("writes a row for a block that changed a stake", async () => {
        validators[1].staked_amount = "2000"
        expect(await recordValidatorSetSnapshot(em, 4)).toBe(true)
        expect(snapshots.map(s => s.block)).toEqual([0, 4])
        expect((await validatorSetAt(3))?.block).toBe(0)
        expect((await validatorSetAt(4))?.setHash).toBe(
            validatorSetHash(validatorSetRecord(validators)),
        )
        expect((await validatorSetAt(99))?.block).toBe(4)
    })

    it("writes a row for a new validator and for an exit", async () => {
        validators.push(row(4, { valid_at: 1 }))
        expect(await recordValidatorSetSnapshot(em, 2)).toBe(true)
        validators[0].status = "0"
        expect(await recordValidatorSetSnapshot(em, 3)).toBe(true)
        expect(await recordValidatorSetSnapshot(em, 4)).toBe(false)
        expect(snapshots.map(s => s.block)).toEqual([0, 2, 3])
    })

    it("drops rows left from a chain this node no longer follows", async () => {
        validators[0].staked_amount = "5"
        await recordValidatorSetSnapshot(em, 6)
        validators[0].staked_amount = "1000"

        // Block 5 is inserted again on another branch; the old 6 is gone
        expect(await recordValidatorSetSnapshot(em, 5)).toBe(false)
        expect(snapshots.map(s => s.block)).toEqual([0])
    })

    it("answers nothing below the oldest snapshot", async () => {
        snapshots = snapshots.map(s => ({ ...s, block: 3 }))
        expect(await validatorSetAt(2)).toBeNull()
    })
})

describe("boot", () => {
    it("records block 0 on a fresh chain", async () => {
        expect(await ensureValidatorSetSnapshot(0)).toBe(0)
        expect(snapshots).toEqual([
            {
                block: 0,
                setHash: validatorSetHash(validatorSetRecord(validators)),
                validators: validatorSetRecord(validators),
            },
        ])
    })

    it("writes nothing when the newest snapshot matches the table", async () => {
        await ensureValidatorSetSnapshot(0)
        expect(await ensureValidatorSetSnapshot(40)).toBeNull()
        expect(snapshots.map(s => s.block)).toEqual([0])
    })

    it("records the tip when the table moved without snapshots", async () => {
        await ensureValidatorSetSnapshot(0)
        validators.push(row(9))
        expect(await ensureValidatorSetSnapshot(40)).toBe(40)
        expect(snapshots.map(s => s.block)).toEqual([0, 40])
    })

    it("keeps the set committed with the tip block when the table drifted from it", async () => {
        await ensureValidatorSetSnapshot(0)
        validators.push(row(9))
        await recordValidatorSetSnapshot(em, 40)
        const committed = structuredClone(snapshots.find(s => s.block === 40))
        validators.push(row(10))

        expect(await ensureValidatorSetSnapshot(40)).toBeNull()
        expect(snapshots.find(s => s.block === 40)).toEqual(committed)
    })

    it("drops snapshots above the tip", async () => {
        await ensureValidatorSetSnapshot(0)
        validators.push(row(9))
        await recordValidatorSetSnapshot(em, 50)
        validators.pop()

        expect(await ensureValidatorSetSnapshot(40)).toBeNull()
        expect(snapshots.map(s => s.block)).toEqual([0])
    })

    it("prunes with the blocks", async () => {
        await ensureValidatorSetSnapshot(0)
        validators.push(row(9))
        await recordValidatorSetSnapshot(em, 3)
        await pruneValidatorSetSnapshots(0)
        expect(snapshots.map(s => s.block)).toEqual([0])
    })
})

describe("boot with finalityProofs active", () => {
    const forkConfigAtStart = structuredClone(getSharedState.forkConfig)
    afterEach(() => {
        getSharedState.forkConfig = structuredClone(forkConfigAtStart)
    })
    beforeEach(() => {
        getSharedState.forkConfig.finalityProofs.activationHeight = 0
    })

    it("refuses an existing chain whose snapshot table is empty", async () => {
        const error = await ensureValidatorSetSnapshot(40).catch(e => e)
        expect(error).toBeInstanceOf(historyError)
        expect(error.message).toContain("no validator set snapshot at or below block 39")
        expect(error.message).toContain("Resync this node from genesis")
        expect(snapshots).toEqual([])
    })

    it("refuses when only the tip's set is recorded", async () => {
        snapshots = [{ block: 40, setHash: "h", validators: [] }]
        await expect(ensureValidatorSetSnapshot(40)).rejects.toBeInstanceOf(historyError)
    })

    it("boots a chain whose history reaches the set before the tip", async () => {
        snapshots = [
            {
                block: 0,
                setHash: validatorSetHash(validatorSetRecord(validators)),
                validators: validatorSetRecord(validators),
            },
        ]
        expect(await ensureValidatorSetSnapshot(40)).toBeNull()
    })

    it("boots a fresh chain and the first two heights from the table", async () => {
        expect(await ensureValidatorSetSnapshot(0)).toBe(0)
        snapshots = []
        expect(await ensureValidatorSetSnapshot(1)).toBe(1)
    })

    it("lets an empty table boot while the fork is still ahead of the next block", async () => {
        getSharedState.forkConfig.finalityProofs.activationHeight = 42
        expect(await ensureValidatorSetSnapshot(40)).toBe(40)
    })
})

describe("the validator_set_snapshots migration", () => {
    const run = async (step: "up" | "down") => {
        const queries: string[] = []
        const runner = { query: async (sql: string) => void queries.push(sql) }
        await new CreateValidatorSetSnapshots1793404800000()[step](
            runner as unknown as QueryRunner,
        )
        return queries.join("\n")
    }
    const columns = () =>
        getMetadataArgsStorage().columns.filter(c => c.target === ValidatorSetSnapshots)

    it("creates the table the entity maps, with every column it declares", async () => {
        const table = getMetadataArgsStorage().tables.find(
            t => t.target === ValidatorSetSnapshots,
        )
        const sql = await run("up")
        expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table?.name}"`)
        expect(columns().length).toBe(3)
        for (const column of columns()) {
            expect(sql).toContain(`"${column.options.name}" ${column.options.type} NOT NULL`)
        }
        expect(sql).toContain("PRIMARY KEY (\"block\")")
    })

    it("down drops the table", async () => {
        expect(await run("down")).toBe("DROP TABLE IF EXISTS \"validator_set_snapshots\"")
    })
})

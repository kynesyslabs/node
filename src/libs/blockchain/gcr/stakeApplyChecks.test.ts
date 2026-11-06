import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"

/**
 * Under `stakeApplyChecks` the staking rules hold where a stake is applied,
 * on every node, so a stake that never passed the RPC checks of the node
 * that took it in is held to them all the same: the minimum to enter, a
 * balance that covers it, one debit and one refund, and no unstake that
 * leaves the set below the committee floor.
 */

/** Rows the fake database holds, keyed by table. */
let seeded: Record<string, any[]> = {}

const matches = (row: any, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => v === undefined || row[k] === v)

function repoFor(table: string) {
    const rows = () => seeded[table] ?? []
    return {
        target: { name: table },
        create: (row: unknown) => ({ ...(row as object) }),
        // Copies, as a database read returns: an edit that changes a row it
        // read must not change what the table holds.
        findOneBy: async (where: Record<string, unknown>) => {
            const row = rows().find(row => matches(row, where))
            return row ? structuredClone(row) : null
        },
        find: async (options?: { where?: Record<string, unknown> }) =>
            rows()
                .filter(row => matches(row, options?.where ?? {}))
                .map(row => structuredClone(row)),
        save: async (saved: unknown) => saved,
    }
}

const fakeDataSource = {
    getRepository: (entity: any) => repoFor(entity?.name ?? String(entity)),
    transaction: async (work: (em: unknown) => Promise<unknown>) =>
        work({ getRepository: (entity: any) => repoFor(entity?.name ?? String(entity)) }),
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
const { getSharedState } = await import("@/utilities/sharedState")
const { cloneDefaultForkConfig } = await import("@/forks/forkConfig")
const { stakeSenderRefusal } = await import("../validation/editBinding")
const { DEFAULT_MIN_VALIDATOR_STAKE } = await import("@/features/staking/constants")

const MIN = BigInt(DEFAULT_MIN_VALIDATOR_STAKE)
const SENDER = "0xabc"

const caches = (balance: bigint): any => {
    const entities: any = {
        accounts: new Map(),
        storagePrograms: new Map(),
        tlsNotaries: new Map(),
        atomicWorks: new Map(),
        resourceSlots: new Map(),
    }
    entities.accounts.set(SENDER, { pubkey: SENDER, balance, nonce: 0 })
    return entities
}

const edit = (operation: string, amount = "0", connectionUrl = "https://v.example"): any => ({
    type: "validatorStake",
    operation,
    account: SENDER,
    amount,
    connectionUrl,
})

const tx = (edits: any[]): any => ({
    hash: `0x${Math.random().toString(16).slice(2)}`,
    content: { type: "validatorStake", from_ed25519_address: SENDER, gcr_edits: edits },
})

const apply = (e: any, entities: any) => HandleGCR.applyGCREdit(e, entities, false, false)

/** Active validators other than the sender, so the floor is met. */
function activeValidators(n: number): any[] {
    return Array.from({ length: n }, (_, i) => ({
        address: `0xv${i}`,
        status: "2",
        staked_amount: MIN.toString(),
        bonded_amount: "0",
    }))
}

let savedForkConfig: any

beforeEach(() => {
    seeded = {}
    spyOn(Chain, "getLastBlockNumber").mockResolvedValue(100)
    savedForkConfig = getSharedState.forkConfig
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.forkConfig.stakeApplyChecks.activationHeight = 0
    if (!getSharedState.hasShardSize) getSharedState.setShardSizeFromGenesis(10)
    getSharedState.governedMinValidatorStake = null
})

afterEach(() => {
    getSharedState.forkConfig = savedForkConfig
})

describe("stake at apply", () => {
    it("refuses a first stake below the minimum", async () => {
        const entities = caches(MIN * 2n)
        const result = await apply(edit("stake", (MIN - 1n).toString()), entities)

        expect(result.success).toBe(false)
        expect(entities.validators?.get(SENDER) ?? null).toBeNull()
        expect(entities.accounts.get(SENDER).balance).toBe(MIN * 2n)
    })

    it("refuses a first stake without a connection URL", async () => {
        const result = await apply(edit("stake", MIN.toString(), ""), caches(MIN))
        expect(result.success).toBe(false)
    })

    it("refuses a stake the balance does not cover", async () => {
        const entities = caches(MIN - 1n)
        const result = await apply(edit("stake", MIN.toString()), entities)

        expect(result.success).toBe(false)
        expect(result.message).toContain("Insufficient balance")
        expect(entities.accounts.get(SENDER).balance).toBe(MIN - 1n)
    })

    it("debits the stake from the balance once and records it as bonded", async () => {
        const entities = caches(MIN + 10n)
        const result = await apply(edit("stake", MIN.toString()), entities)

        expect(result.success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(10n)
        expect(entities.validators.get(SENDER)).toMatchObject({
            status: "2",
            staked_amount: MIN.toString(),
            bonded_amount: MIN.toString(),
        })

        const topUp = await apply(edit("stake", "10"), entities)
        expect(topUp.success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(0n)
        expect(entities.validators.get(SENDER).bonded_amount).toBe((MIN + 10n).toString())
    })

    it("lets a validator top up any positive amount", async () => {
        seeded = {
            Validators: [{ address: SENDER, status: "2", staked_amount: MIN.toString(), bonded_amount: "0" }],
        }
        const entities = caches(5n)
        const result = await apply(edit("stake", "5", ""), entities)

        expect(result.success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(0n)
    })

    it("re-activates an exited row only with the minimum", async () => {
        seeded = {
            Validators: [
                { address: SENDER, status: "0", staked_amount: "0", bonded_amount: "0", connection_url: "https://old.example" },
            ],
        }
        const entities = caches(MIN)
        const low = await apply(edit("stake", "1", ""), entities)
        expect(low.success).toBe(false)
        expect(entities.validators.get(SENDER).status).toBe("0")
        expect(entities.accounts.get(SENDER).balance).toBe(MIN)

        const enough = await apply(edit("stake", MIN.toString(), ""), entities)
        expect(enough.success).toBe(true)
        expect(entities.validators.get(SENDER)).toMatchObject({
            status: "2",
            staked_amount: MIN.toString(),
            connection_url: "https://old.example",
        })
        expect(entities.accounts.get(SENDER).balance).toBe(0n)
    })

    it("holds the minimum an active network upgrade set, not the node's own", async () => {
        getSharedState.governedMinValidatorStake = (MIN * 2n).toString()
        const result = await apply(edit("stake", MIN.toString()), caches(MIN * 3n))
        expect(result.success).toBe(false)
    })

    it("leaves the balance and the row as they were when a later edit of the transaction fails", async () => {
        const entities = caches(MIN)
        const result = await HandleGCR.applyTransaction(
            entities,
            tx([
                edit("stake", MIN.toString()),
                { type: "balance", operation: "remove", account: SENDER, amount: "1" },
            ]),
            false,
            false,
        )

        expect(result.success).toBe(false)
        expect(BigInt(entities.accounts.get(SENDER).balance)).toBe(MIN)
        expect(entities.validators?.get(SENDER) ?? null).toBeNull()
    })
})

describe("exit at apply", () => {
    const unstaking = (staked: bigint, bonded: bigint) => ({
        address: SENDER,
        status: "3",
        staked_amount: staked.toString(),
        bonded_amount: bonded.toString(),
        unstake_requested_at: 0,
        unstake_available_at: 50,
    })

    it("pays the bonded stake back once", async () => {
        seeded = { Validators: [unstaking(MIN, MIN)] }
        const entities = caches(0n)

        const first = await apply(edit("exit"), entities)
        expect(first.success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(MIN)
        expect(entities.validators.get(SENDER)).toMatchObject({
            status: "0",
            staked_amount: "0",
            bonded_amount: "0",
        })

        const again = await apply(edit("exit"), entities)
        expect(again.success).toBe(false)
        expect(entities.accounts.get(SENDER).balance).toBe(MIN)
    })

    it("pays nothing for a stake that was never debited", async () => {
        seeded = { Validators: [unstaking(MIN, 0n)] }
        const entities = caches(0n)

        const result = await apply(edit("exit"), entities)
        expect(result.success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(0n)
    })

    it("pays back only what was staked after the last exit across a re-stake cycle", async () => {
        seeded = {
            Validators: [unstaking(MIN, MIN), ...activeValidators(8)],
        }
        const entities = caches(0n)
        expect((await apply(edit("exit"), entities)).success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(MIN)

        expect((await apply(edit("stake", MIN.toString()), entities)).success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(0n)
        expect((await apply(edit("unstake"), entities)).success).toBe(true)

        const row = entities.validators.get(SENDER)
        row.unstake_available_at = 50
        expect((await apply(edit("exit"), entities)).success).toBe(true)
        expect(entities.accounts.get(SENDER).balance).toBe(MIN)
    })
})

describe("a failed transaction with an exit", () => {
    it("does not keep the refund, so the bond cannot be paid twice", async () => {
        seeded = {
            Validators: [
                {
                    address: SENDER,
                    status: "3",
                    staked_amount: MIN.toString(),
                    bonded_amount: MIN.toString(),
                    unstake_requested_at: 0,
                    unstake_available_at: 50,
                },
            ],
        }
        const entities = caches(0n)
        // No nonce or gas edit names the sender: the second exit fails.
        const failed = await HandleGCR.applyTransaction(
            entities,
            tx([edit("exit"), edit("exit")]),
            false,
            false,
        )
        expect(failed.success).toBe(false)
        expect(BigInt(entities.accounts.get(SENDER).balance)).toBe(0n)

        expect((await apply(edit("exit"), entities)).success).toBe(true)
        expect(BigInt(entities.accounts.get(SENDER).balance)).toBe(MIN)
    })
})

describe("a stake edit shipped as a rollback", () => {
    const bonded = () => ({
        address: SENDER,
        status: "2",
        staked_amount: MIN.toString(),
        bonded_amount: MIN.toString(),
        unstake_requested_at: null,
        unstake_available_at: null,
    })

    it("does not pay the bond back outside a rollback", async () => {
        // Below the floor and inside no lock: only a real rollback may refund.
        seeded = { Validators: [bonded(), ...activeValidators(6)] }
        const entities = caches(0n)
        await apply({ ...edit("stake", MIN.toString()), isRollback: true }, entities)

        expect(BigInt(entities.accounts.get(SENDER).balance)).toBe(0n)
        const row = entities.validators?.get(SENDER)
        if (row) expect(row).toMatchObject({ status: "2", bonded_amount: MIN.toString() })
    })

    it("is refused before apply", () => {
        expect(
            stakeSenderRefusal(tx([{ ...edit("stake", "1"), isRollback: true }])),
        ).not.toBeNull()
        expect(
            stakeSenderRefusal(tx([{ ...edit("stake", "1"), isRollback: false }])),
        ).toBeNull()
    })

    it("still lets a rollback of the block undo the stake", async () => {
        const entities = caches(MIN)
        expect((await apply(edit("stake", MIN.toString()), entities)).success).toBe(true)
        expect(BigInt(entities.accounts.get(SENDER).balance)).toBe(0n)

        const undone = await HandleGCR.applyGCREdit(
            edit("stake", MIN.toString()),
            entities,
            true,
            false,
        )
        expect(undone.success).toBe(true)
        expect(BigInt(entities.accounts.get(SENDER).balance)).toBe(MIN)
        expect(entities.validators.get(SENDER).status).toBe("0")
    })
})

describe("unstake at apply", () => {
    const self = () => ({
        address: SENDER,
        status: "2",
        staked_amount: MIN.toString(),
        bonded_amount: MIN.toString(),
        unstake_requested_at: null,
        unstake_available_at: null,
    })

    it("refuses an unstake that would leave the set below the committee floor", async () => {
        // shardSize 10: the floor is 7, so 7 active validators cannot lose one.
        seeded = { Validators: [self(), ...activeValidators(6)] }
        const entities = caches(0n)

        const result = await apply(edit("unstake"), entities)
        expect(result.success).toBe(false)
        expect(result.message).toContain("committee floor")
        expect(entities.validators.get(SENDER).status).toBe("2")
    })

    it("allows it while the floor still holds", async () => {
        seeded = { Validators: [self(), ...activeValidators(7)] }
        const result = await apply(edit("unstake"), caches(0n))
        expect(result.success).toBe(true)
    })

    it("counts unstakes staged earlier in the same block", async () => {
        seeded = { Validators: [self(), ...activeValidators(7)] }
        const entities = caches(0n)
        entities.accounts.set("0xv0", { pubkey: "0xv0", balance: 0n, nonce: 0 })

        expect((await apply({ ...edit("unstake"), account: "0xv0" }, entities)).success).toBe(true)
        const second = await apply(edit("unstake"), entities)
        expect(second.success).toBe(false)
    })

    it("refuses an unstake from a validator that is not active", async () => {
        seeded = { Validators: [{ ...self(), status: "0" }, ...activeValidators(9)] }
        const result = await apply(edit("unstake"), caches(0n))
        expect(result.success).toBe(false)
    })
})

describe("a stake edit for another account", () => {
    it("is refused when it names another account than the sender", () => {
        expect(stakeSenderRefusal(tx([edit("stake", "1")]))).toBeNull()
        expect(
            stakeSenderRefusal(tx([{ ...edit("stake", "1"), account: "0xvictim" }])),
        ).not.toBeNull()
    })
})

describe("before the fork", () => {
    it("applies a stake below the minimum without touching the balance, as before", async () => {
        getSharedState.forkConfig.stakeApplyChecks.activationHeight = null
        const entities = caches(0n)
        const result = await apply(edit("stake", "1"), entities)

        expect(result.success).toBe(true)
        expect(entities.validators.get(SENDER).status).toBe("2")
        expect(entities.accounts.get(SENDER).balance).toBe(0n)
    })
})

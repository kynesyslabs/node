import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { In } from "typeorm"

/**
 * Edit routines that write their own tables (validator stake, governance)
 * must not reach the database during the apply: their saves are staged
 * and issued through the entity manager of the block's transaction. Later
 * edits of the same block read what earlier ones staged, and a failed
 * transaction leaves none of its staging behind.
 */

const durable = new Map<string, unknown[]>()
const issued: string[] = []
/** Rows the fake database holds, keyed by table. */
let seeded: Record<string, any[]> = {}

const nameOf = (entity: any) => entity?.name ?? String(entity)

const matches = (row: any, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) =>
        v instanceof In([]).constructor ? ((v as { value: unknown[] }).value).includes(row[k]) : row[k] === v,
    )

function repoFor(table: string, sink: Map<string, unknown[]>, tag: string) {
    const rows = () => seeded[table] ?? []
    return {
        target: { name: table },
        create: (row: unknown) => row,
        findOneBy: async (where: Record<string, unknown>) =>
            rows().find(row => matches(row, where)) ?? null,
        findOne: async ({ where }: { where: Record<string, unknown> }) =>
            rows().find(row => matches(row, where)) ?? null,
        find: async (options?: { where?: Record<string, unknown> }) =>
            rows().filter(row => matches(row, options?.where ?? {})),
        maximum: async (column: string) =>
            rows().reduce<number | null>(
                (max, row) => (max === null || row[column] > max ? row[column] : max),
                null,
            ),
        save: async (saved: unknown) => {
            issued.push(`${tag}:${table}`)
            const list = Array.isArray(saved) ? saved : [saved]
            sink.set(table, [...(sink.get(table) ?? []), ...list])
            return saved
        },
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

    it("writes the row as it was staged, not as a later edit left it", async () => {
        const entities = caches()
        const first = await HandleGCR.applyGCREdit(stake("5"), entities, false, false)
        await HandleGCR.applyGCREdit(stake("7"), entities, false, false)

        await fakeDataSource.transaction(async em => first.deferredWrite!(em as any))

        expect(durable.get("Validators")).toMatchObject([{ staked_amount: "5" }])
    })

    it("puts the staged row back when a later transaction fails", async () => {
        const entities = caches()
        entities.accounts.set("0xabc", { pubkey: "0xabc", balance: 10n, nonce: 0 })
        const first = await HandleGCR.applyTransaction(entities, stakeTx(["5"]), false, false)
        expect(first.success).toBe(true)

        const failing = stakeTx(["7"])
        failing.content.gcr_edits.push({
            type: "balance",
            operation: "remove",
            account: "0xabc",
            amount: "0",
        })
        const second = await HandleGCR.applyTransaction(entities, failing, false, false)

        expect(second.success).toBe(false)
        expect(second.deferredWrites).toEqual([])
        expect(entities.validators.get("0xabc").staked_amount).toBe("5")

        const third = await HandleGCR.applyTransaction(entities, stakeTx(["1"]), false, false)
        expect(third.success).toBe(true)
        expect(entities.validators.get("0xabc").staked_amount).toBe("6")

        for (const r of [first, third]) {
            await fakeDataSource.transaction(async em => {
                for (const write of r.deferredWrites) await write(em as any)
            })
        }
        expect(durable.get("Validators")).toMatchObject([
            { staked_amount: "5" },
            { staked_amount: "6" },
        ])
    })
})

const proposal = (proposalId: string, key = "networkFee"): any => ({
    type: "networkUpgrade",
    account: "0xabc",
    proposalId,
    proposedParameters: { [key]: "2" },
    effectiveAtBlock: 100_000,
    rationale: "test",
})

const vote = (proposalId: string, account = "0xabc"): any => ({
    type: "networkUpgradeVote",
    account,
    proposalId,
    approve: true,
})

describe("governance edits", () => {
    it("stages a proposal row for the block's transaction", async () => {
        const result = await HandleGCR.applyGCREdit(proposal("p1"), caches(), false, false)

        expect(result.success).toBe(true)
        expect(issued).toEqual([])
        expect(result.deferredWrite).toBeDefined()

        await fakeDataSource.transaction(async em => result.deferredWrite!(em as any))

        expect(issued).toEqual(["em:NetworkUpgrade"])
        expect(durable.get("NetworkUpgrade")).toMatchObject([{ proposalId: "p1", version: 1 }])
    })

    it("sees a proposal an earlier edit of the block staged", async () => {
        const entities = caches()
        const first = await HandleGCR.applyGCREdit(proposal("p1"), entities, false, false)
        const again = await HandleGCR.applyGCREdit(proposal("p1"), entities, false, false)
        const sameKey = await HandleGCR.applyGCREdit(proposal("p2"), entities, false, false)
        const otherKey = await HandleGCR.applyGCREdit(
            proposal("p3", "blockTime"),
            entities,
            false,
            false,
        )

        expect(first.message).toBe("Proposal persisted")
        expect(again.message).toBe("Proposal p1 already persisted")
        expect(again.deferredWrite).toBeUndefined()
        expect(sameKey.message).toBe("Skipped: parameter networkFee locked by p1")
        expect(sameKey.deferredWrite).toBeUndefined()
        expect(otherKey.message).toBe("Proposal persisted")
        expect(entities.networkUpgrades.get("p1").version).toBe(1)
        expect(entities.networkUpgrades.get("p3").version).toBe(2)
    })

    it("numbers a staged proposal after the ones on disk", async () => {
        seeded = {
            NetworkUpgrade: [{ proposalId: "old", version: 4, status: "activated", proposedParameters: {} }],
        }
        const entities = caches()
        await HandleGCR.applyGCREdit(proposal("p1"), entities, false, false)

        expect(entities.networkUpgrades.get("p1").version).toBe(5)
    })

    it("stages one vote per voter and proposal", async () => {
        seeded = {
            NetworkUpgrade: [
                { proposalId: "p1", version: 1, status: "pending", snapshotBlock: 50, proposedParameters: {} },
            ],
        }
        const { default: GCR } = await import("./gcr")
        spyOn(GCR, "getGCRValidatorsAtBlock").mockResolvedValue([
            { address: "0xabc", staked_amount: "9" },
        ] as any)

        const entities = caches()
        const first = await HandleGCR.applyGCREdit(vote("p1"), entities, false, false)
        const again = await HandleGCR.applyGCREdit(vote("p1"), entities, false, false)

        expect(first.message).toBe("Vote persisted")
        expect(again.message).toBe("Vote 0xabc→p1 already persisted")
        expect(again.deferredWrite).toBeUndefined()
        expect(issued).toEqual([])
    })
})

describe("transactions on one staged cache share a group", () => {
    const txWith = (from: string, edits: any[]): any => ({
        hash: `0x${from}`,
        content: { from_ed25519_address: from, gcr_edits: edits },
    })
    const zk = (account: string): any => ({
        type: "identity",
        context: "zk",
        operation: "zk_commitmentadd",
        account,
        data: [{ commitment_hash: "a".repeat(64) }],
    })

    it("keeps ZK, stake and governance edits of different senders in block order", () => {
        const groups = HandleGCR.partitionIndependentTxs([
            txWith("0x01", [zk("0x01")]),
            txWith("0x02", [zk("0x02")]),
            txWith("0x03", [stake("1")]),
            txWith("0x04", [{ ...stake("1"), account: "0x04" }]),
            txWith("0x05", [proposal("p1")]),
            txWith("0x06", [vote("p1", "0x06")]),
            txWith("0x07", [{ type: "balance", operation: "add", account: "0x07", amount: "1" }]),
        ])

        const senders = groups.map(g => g.map(tx => tx.content.from_ed25519_address))
        expect(senders).toContainEqual(["0x01", "0x02"])
        expect(senders).toContainEqual(["0x03", "0x04"])
        expect(senders).toContainEqual(["0x05", "0x06"])
        expect(senders).toContainEqual(["0x07"])
    })
})

describe("ZK claims within a block", () => {
    const commitment = (hash: string): any => ({
        type: "identity",
        context: "zk",
        operation: "zk_commitmentadd",
        account: "0xabc",
        data: [{ commitment_hash: hash, provider: "test", timestamp: 1 }],
    })

    it("refuses the second transaction that claims one commitment", async () => {
        const entities = caches()
        entities.accounts.set("0xabc", { pubkey: "0xabc", balance: 10n, nonce: 0 })
        const hash = "b".repeat(64)

        const first = await HandleGCR.applyGCREdit(commitment(hash), entities, false, false)
        const second = await HandleGCR.applyGCREdit(commitment("0x" + hash), entities, false, false)

        expect(first.success).toBe(true)
        expect(first.deferredWrite).toBeDefined()
        expect(second.success).toBe(false)
        expect(second.message).toBe("Commitment already exists in this block")
        expect(second.deferredWrite).toBeUndefined()
    })

    it("frees the claim of a transaction that fails", async () => {
        const entities = caches()
        entities.accounts.set("0xabc", { pubkey: "0xabc", balance: 10n, nonce: 0 })
        const hash = "c".repeat(64)
        const failing: any = {
            hash: "0xfail",
            content: {
                type: "identity",
                from_ed25519_address: "0xabc",
                gcr_edits: [
                    commitment(hash),
                    { type: "balance", operation: "remove", account: "0xabc", amount: "0" },
                ],
            },
        }
        const failed = await HandleGCR.applyTransaction(entities, failing, false, false)
        expect(failed.success).toBe(false)

        const retry = await HandleGCR.applyGCREdit(commitment(hash), entities, false, false)
        expect(retry.success).toBe(true)
    })

    it("leaves the claims of other caches alone when a transaction fails", async () => {
        const entities = caches()
        entities.accounts.set("0xabc", { pubkey: "0xabc", balance: 10n, nonce: 0 })
        const claimed = await HandleGCR.applyGCREdit(commitment("d".repeat(64)), entities, false, false)
        expect(claimed.success).toBe(true)
        const claims = entities.zkCommitments

        // A stake transaction fails while the ZK claim sits in the shared caches
        const failing = stakeTx(["7"])
        failing.content.gcr_edits.push({
            type: "balance",
            operation: "remove",
            account: "0xabc",
            amount: "0",
        })
        await HandleGCR.applyTransaction(entities, failing, false, false)

        expect(entities.zkCommitments).toBe(claims)
        expect(entities.zkCommitments.has("d".repeat(64))).toBe(true)
        expect(entities.validators).toBeUndefined()
    })
})

describe("a set applied on top of a pending one", () => {
    it("reads the pending rows and claims, and folds its own back in", () => {
        const pending = HandleGCR.pendingWrite(
            {
                ...caches(),
                accounts: new Map([["0xaa", { pubkey: "0xaa", balance: 5n }]]),
                storagePrograms: new Map([["sp1", { address: "sp1", data: "block" }]]),
                zkCommitments: new Map([["c1", true]]),
            },
            new Map(),
        )
        const entities = {
            ...caches(),
            accounts: new Map([
                ["0xaa", { pubkey: "0xaa", balance: 1n }],
                ["0xbb", { pubkey: "0xbb", balance: 2n }],
            ]),
            storagePrograms: new Map([["sp1", { address: "sp1", data: "disk" }]]),
        }

        HandleGCR.overlayPending(entities, pending)
        expect(entities.accounts.get("0xaa")).toEqual({ pubkey: "0xaa", balance: 5n })
        expect(entities.accounts.get("0xbb")).toEqual({ pubkey: "0xbb", balance: 2n })
        expect(entities.storagePrograms.get("sp1")).toEqual({ address: "sp1", data: "block" })
        expect(entities.zkCommitments.has("c1")).toBe(true)

        entities.storagePrograms.set("sp1", { address: "sp1", data: "proof" })
        entities.tlsNotaries.set("t1", { tokenId: "t1" })
        HandleGCR.mergeIntoPending(pending, {
            success: true,
            entities,
            message: "",
            sideEffects: [async () => {}],
            deferredWrites: [],
            appliedEditsCount: 1,
        })
        expect(pending.entities.storagePrograms.get("sp1") as unknown).toEqual({ address: "sp1", data: "proof" })
        expect(pending.entities.tlsNotaries.get("t1") as unknown).toEqual({ tokenId: "t1" })
        expect(pending.sideEffects).toHaveLength(1)
    })
})

const stakeTx = (amounts: string[]): any => ({
    hash: `0xstake${amounts.join("")}`,
    content: {
        type: "validatorStake",
        from_ed25519_address: "0xabc",
        gcr_edits: amounts.map(stake),
    },
})

// Integration test: a signed-like validatorStake/Unstake/Exit transaction
// flows through handleStakingTx (which attaches the GCR edit) and then
// through GCRValidatorStakeRoutines (which mutates the Validators row).
//
// The actual DB + block-confirmation pipeline is not exercised here — we
// simulate the contract between the two layers by feeding the tx's
// gcr_edits[0] straight into GCRValidatorStakeRoutines.apply. This is the
// same boundary HandleGCR crosses at confirmation time.

import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        custom: jest.fn(),
    },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn() },
}))

jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorStatus: jest.fn() },
}))

// sharedState pulls in the whole framework — substitute a minimal stand-in.
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { networkParameters: null },
}))

import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import {
    DEFAULT_MIN_VALIDATOR_STAKE,
    UNSTAKE_LOCK_BLOCKS,
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "@/features/staking/constants"

let handleStakingTx: typeof import("@/libs/network/routines/transactions/handleStakingTx").handleStakingTx
let GCRValidatorStakeRoutines: typeof import("@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines").default

beforeAll(async () => {
    ({ handleStakingTx } = await import(
        "@/libs/network/routines/transactions/handleStakingTx"
    ))
    GCRValidatorStakeRoutines = (
        await import(
            "@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines"
        )
    ).default
})

// ---------- DB stub ----------

interface Row {
    address: string
    status: string | null
    connection_url: string | null
    staked_amount: string | null
    first_seen: number | null
    valid_at: number | null
    unstake_requested_at: number | null
    unstake_available_at: number | null
}

function createRepo() {
    const rows = new Map<string, Row>()
    return {
        rows,
        findOneBy: jest.fn(async ({ address }: { address: string }) =>
            rows.get(address) ?? null,
        ),
        save: jest.fn(async (row: Row) => {
            rows.set(row.address, { ...row })
            return rows.get(row.address)!
        }),
        create: jest.fn((row: Row) => ({ ...row })),
    }
}

// ---------- tx factories ----------

const SENDER = "aabbcc"

function stakeTx(amount: string, hash = "0xhash_stake") {
    return {
        hash,
        content: {
            type: "validatorStake",
            from: SENDER,
            from_ed25519_address: SENDER,
            data: [
                "validatorStake",
                { amount, connectionUrl: "https://v.example" },
            ],
            gcr_edits: [],
        },
    } as any
}

function unstakeTx(hash = "0xhash_unstake") {
    return {
        hash,
        content: {
            type: "validatorUnstake",
            from: SENDER,
            from_ed25519_address: SENDER,
            data: ["validatorUnstake", {}],
            gcr_edits: [],
        },
    } as any
}

function exitTx(hash = "0xhash_exit") {
    return {
        hash,
        content: {
            type: "validatorExit",
            from: SENDER,
            from_ed25519_address: SENDER,
            data: ["validatorExit", {}],
            gcr_edits: [],
        },
    } as any
}

/**
 * Mirrors what `SDK GCRGeneration.generate()` does for staking txs —
 * attaches the `validatorStake` edit before signing. Tests bypass the
 * SDK so we replay this step inline.
 */
function attachStakingEdit(tx: any) {
    const data = tx.content?.data
    const payload = Array.isArray(data) ? data[1] : null
    if (tx.content.type === "validatorStake") {
        tx.content.gcr_edits.push({
            type: "validatorStake",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            operation: "stake",
            amount: payload?.amount ?? "0",
            connectionUrl: payload?.connectionUrl ?? "",
            txhash: tx.hash,
        })
    } else if (tx.content.type === "validatorUnstake") {
        tx.content.gcr_edits.push({
            type: "validatorStake",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            operation: "unstake",
            amount: "0",
            txhash: tx.hash,
        })
    } else if (tx.content.type === "validatorExit") {
        tx.content.gcr_edits.push({
            type: "validatorStake",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            operation: "exit",
            amount: "0",
            txhash: tx.hash,
        })
    }
    return tx
}

// ---------- scenario ----------

describe("staking integration: tx -> gcr_edits -> Validators row", () => {
    let repo: ReturnType<typeof createRepo>

    beforeEach(() => {
        jest.clearAllMocks()
        repo = createRepo()
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(100 as never)
    })

    async function apply(tx: any, currentBlock: number) {
        const edit = tx.content.gcr_edits[0]
        expect(edit).toBeDefined()
        const r = await GCRValidatorStakeRoutines.apply(
            edit,
            repo as any,
            currentBlock,
        )
        expect(r.success).toBe(true)
        return repo.rows.get(SENDER)
    }

    it("entrance: validation passes + edit (synthesized SDK-side) creates an ACTIVE row", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )

        const tx = stakeTx(DEFAULT_MIN_VALIDATOR_STAKE)
        const handled = await handleStakingTx(tx)
        expect(handled.success).toBe(true)
        // Edit is the SDK's responsibility (GCRGeneration.generate); we
        // simulate it here.
        attachStakingEdit(tx)
        expect(tx.content.gcr_edits).toHaveLength(1)
        expect(tx.content.gcr_edits[0]).toMatchObject({
            type: "validatorStake",
            operation: "stake",
            account: SENDER,
            amount: DEFAULT_MIN_VALIDATOR_STAKE,
            connectionUrl: "https://v.example",
            txhash: "0xhash_stake",
            isRollback: false,
        })

        const row = await apply(tx, 100)
        expect(row).toMatchObject({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: DEFAULT_MIN_VALIDATOR_STAKE,
            connection_url: "https://v.example",
            first_seen: 100,
            valid_at: 100,
            unstake_requested_at: null,
            unstake_available_at: null,
        })
    })

    it("full lifecycle: stake -> top-up -> unstake -> wait lock -> exit", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )

        // 1. Initial stake at block 100.
        const t1 = stakeTx(DEFAULT_MIN_VALIDATOR_STAKE, "0xtx1")
        await handleStakingTx(t1)
        attachStakingEdit(t1)
        let row = await apply(t1, 100)
        expect(row?.status).toBe(VALIDATOR_STATUS_ACTIVE)
        expect(row?.staked_amount).toBe(DEFAULT_MIN_VALIDATOR_STAKE)

        // 2. Top-up at block 200 — GCR now reports the validator as ACTIVE.
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            staked_amount: DEFAULT_MIN_VALIDATOR_STAKE,
        } as never)
        const t2 = stakeTx("500", "0xtx2")
        await handleStakingTx(t2)
        attachStakingEdit(t2)
        row = await apply(t2, 200)
        expect(row?.staked_amount).toBe(
            (BigInt(DEFAULT_MIN_VALIDATOR_STAKE) + 500n).toString(),
        )

        // 3. Unstake request at block 300.
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_ACTIVE,
            unstake_requested_at: null,
        } as never)
        const t3 = unstakeTx("0xtx3")
        await handleStakingTx(t3)
        attachStakingEdit(t3)
        row = await apply(t3, 300)
        expect(row?.status).toBe(VALIDATOR_STATUS_UNSTAKING)
        expect(row?.unstake_requested_at).toBe(300)
        expect(row?.unstake_available_at).toBe(300 + UNSTAKE_LOCK_BLOCKS)

        // 4. Exit attempt BEFORE lock elapses is rejected at the validation layer.
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: SENDER,
            status: VALIDATOR_STATUS_UNSTAKING,
            unstake_requested_at: 300,
            unstake_available_at: 300 + UNSTAKE_LOCK_BLOCKS,
        } as never)
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(500 as never)
        const earlyExit = exitTx("0xtx4_early")
        const earlyHandled = await handleStakingTx(earlyExit)
        expect(earlyHandled.success).toBe(false)
        expect(earlyHandled.message).toContain("Lock not elapsed")
        expect(earlyExit.content.gcr_edits).toHaveLength(0)

        // 5. Exit at exactly the unlock block succeeds.
        const unlockBlock = 300 + UNSTAKE_LOCK_BLOCKS
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            unlockBlock as never,
        )
        const t5 = exitTx("0xtx5")
        const handled5 = await handleStakingTx(t5)
        expect(handled5.success).toBe(true)
        attachStakingEdit(t5)
        row = await apply(t5, unlockBlock)
        expect(row?.status).toBe(VALIDATOR_STATUS_EXITED)
        expect(row?.staked_amount).toBe("0")
    })

    it("rejected validatorStake — handler returns failure (edit synthesis is the SDK's responsibility, but tx with no validation pass shouldn't be broadcast)", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const tx = stakeTx("1") // below minimum
        const handled = await handleStakingTx(tx)
        expect(handled.success).toBe(false)
    })

    it("handler is pure validation — running it twice doesn't mutate tx", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const tx = stakeTx(DEFAULT_MIN_VALIDATOR_STAKE)
        const r1 = await handleStakingTx(tx)
        const r2 = await handleStakingTx(tx)
        expect(r1.success).toBe(true)
        expect(r2.success).toBe(true)
        // Handler is no-mutation; gcr_edits stays empty.
        expect(tx.content.gcr_edits).toHaveLength(0)
    })

    // G-1 + G-4 regression: a validator submits a stake with a mixed-case
    // address. The Validators row must land under the lower-cased key,
    // so that governance lookups (which lowercase the sender) match.
    it("persists validator addresses in lower-case (G-1+G-4 canonicalisation)", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const MIXED = "0xAaBbCc"
        const lower = MIXED.toLowerCase()
        const tx = {
            hash: "0xhash_mixed",
            content: {
                type: "validatorStake",
                from: MIXED,
                from_ed25519_address: MIXED,
                data: [
                    "validatorStake",
                    {
                        amount: DEFAULT_MIN_VALIDATOR_STAKE,
                        connectionUrl: "https://v.example",
                    },
                ],
                gcr_edits: [],
            },
        } as any
        const handled = await handleStakingTx(tx)
        expect(handled.success).toBe(true)
        attachStakingEdit(tx)

        const edit = tx.content.gcr_edits[0]
        const r = await GCRValidatorStakeRoutines.apply(
            edit,
            repo as any,
            100,
        )
        expect(r.success).toBe(true)
        expect(repo.rows.get(lower)).toBeDefined()
        expect(repo.rows.get(MIXED)).toBeUndefined()
    })
})

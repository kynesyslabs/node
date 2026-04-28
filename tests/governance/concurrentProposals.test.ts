// Concurrent-proposal edge cases from stackable_genesis_system_v2.md:
//   - Two proposals on disjoint parameter keys coexist + both activate.
//   - Two proposals on overlapping keys — the second is rejected at validation.
//   - A key locked by an `activating` proposal stays locked through its
//     grace period.
//   - A rejected proposal releases its key; a re-proposal is accepted.

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

const sharedStateStub: { networkParameters: unknown } = {
    networkParameters: null,
}
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn() },
}))

jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorStatus: jest.fn(),
        getGCRValidatorsAtBlock: jest.fn(),
    },
}))

// Minimal in-memory proposal repo. We DO care about the filtering semantics
// that handleGovernanceTx relies on (status ∈ pending/approved/activating),
// and about createQueryBuilder().getRawOne() for version assignment.
const proposalRepo = makeProposalRepo()
const voteRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() }

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: jest.fn(async () => ({
            getDataSource: () => ({
                getRepository: (e: { name: string }) => {
                    if (e.name === "NetworkUpgrade") return proposalRepo
                    if (e.name === "NetworkUpgradeVote") return voteRepo
                    return null
                },
            }),
        })),
    },
}))

import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import {
    GRACE_PERIOD_BLOCKS,
    VOTING_WINDOW_BLOCKS,
} from "@/features/networkUpgrade/constants"
import { VALIDATOR_STATUS_ACTIVE } from "@/features/staking/constants"

let handleGovernanceTx: typeof import("@/libs/network/routines/transactions/handleGovernanceTx").handleGovernanceTx

beforeAll(async () => {
    ;({ handleGovernanceTx } = await import(
        "@/libs/network/routines/transactions/handleGovernanceTx"
    ))
})

function makeProposalRepo() {
    const rows = new Map<string, any>()
    return {
        _rows: rows,
        findOne: jest.fn(async (opts: any) => {
            const w = opts.where
            const allowed: string[] | null =
                Array.isArray(w.status?._value)
                    ? w.status._value
                    : typeof w.status === "string"
                      ? [w.status]
                      : null
            for (const v of rows.values()) {
                if (
                    (!w.proposerPublicKey ||
                        v.proposerPublicKey === w.proposerPublicKey) &&
                    (!allowed || allowed.includes(v.status))
                ) {
                    return v
                }
            }
            return null
        }),
        findOneBy: jest.fn(async ({ proposalId }: { proposalId: string }) =>
            rows.get(proposalId) ?? null,
        ),
        find: jest.fn(async (opts: any) => {
            const w = opts?.where ?? {}
            const allowed: string[] | null =
                Array.isArray(w.status?._value)
                    ? w.status._value
                    : typeof w.status === "string"
                      ? [w.status]
                      : null
            return Array.from(rows.values()).filter(r =>
                allowed ? allowed.includes(r.status) : true,
            )
        }),
        save: jest.fn(async (row: any) => {
            rows.set(row.proposalId, { ...row })
            return row
        }),
        create: jest.fn((row: any) => ({ ...row })),
        createQueryBuilder: jest.fn(() => {
            const qb: any = {
                select: jest.fn(() => qb),
                getRawOne: jest.fn(async () => {
                    let max = 0
                    for (const v of rows.values())
                        max = Math.max(max, v.version ?? 0)
                    return { max }
                }),
            }
            return qb
        }),
    }
}

function proposalTx(
    proposer: string,
    proposalId: string,
    patch: Record<string, unknown>,
    effectiveAtBlock: number,
) {
    return {
        hash: `prop_${proposalId}`,
        content: {
            type: "networkUpgrade",
            from: proposer,
            from_ed25519_address: proposer,
            data: [
                "networkUpgrade",
                {
                    proposalId,
                    proposedParameters: patch,
                    rationale: "concurrent",
                    effectiveAtBlock,
                },
            ],
        },
    } as any
}

const PROPOSER_A = "aa11"
const PROPOSER_B = "bb22"

describe("Concurrent proposals", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        proposalRepo._rows.clear()
        sharedStateStub.networkParameters = null
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(1000 as never)
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockImplementation(
            async () => ({
                address: "any",
                status: VALIDATOR_STATUS_ACTIVE,
            }),
        )
    })

    it("accepts two proposals on disjoint keys from different proposers — both validate", async () => {
        const effective = 1000 + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS

        const r1 = await handleGovernanceTx(
            proposalTx(PROPOSER_A, "p_fee", { networkFee: 14 }, effective),
        )
        expect(r1.success).toBe(true)

        const r2 = await handleGovernanceTx(
            proposalTx(
                PROPOSER_B,
                "p_stake",
                { minValidatorStake: "1100000000000000000" },
                effective + 1,
            ),
        )
        expect(r2.success).toBe(true)
        // Edit synthesis is the SDK's job; persistence/conflict-resolution
        // is the apply routine's job (deterministic block ordering).
    })

    it("rejects a second proposal that overlaps keys with a pending one", async () => {
        const effective = 1000 + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS

        // Once the first proposal has been APPLIED on this node (its
        // gcr_edit ran at block-confirmation), subsequent submissions on
        // the same key are rejected at handleGovernanceTx via the DB-side
        // conflict check. Simulate the apply by seeding the row directly.
        proposalRepo._rows.set("p_fee_1", {
            proposalId: "p_fee_1",
            version: 1,
            proposerPublicKey: PROPOSER_A,
            proposedParameters: { networkFee: 14 },
            status: "pending",
            snapshotBlock: 999,
            tallyBlock: 1099,
            effectiveAtBlock: effective,
            rationale: "",
        })
        const r2 = await handleGovernanceTx(
            proposalTx(
                PROPOSER_B,
                "p_fee_2",
                { networkFee: 12 },
                effective + 1,
            ),
        )
        expect(r2.success).toBe(false)
        expect(r2.message).toContain("locked by proposal p_fee_1")
    })

    it("keeps the key locked while an approved proposal sits in its grace period (status=activating)", async () => {
        const effective = 1000 + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS
        // Seed an already-activating proposal.
        proposalRepo._rows.set("p_approved", {
            proposalId: "p_approved",
            version: 1,
            proposerPublicKey: PROPOSER_A,
            proposedParameters: { networkFee: 14 },
            status: "activating",
            snapshotBlock: 100,
            tallyBlock: 200,
            effectiveAtBlock: 500,
            rationale: "",
        })

        const r = await handleGovernanceTx(
            proposalTx(PROPOSER_B, "p_fee_2", { networkFee: 12 }, effective),
        )
        expect(r.success).toBe(false)
        expect(r.message).toContain("locked by proposal p_approved")
    })
})

describe("Rejection + re-proposal", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        proposalRepo._rows.clear()
        sharedStateStub.networkParameters = null
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(1000 as never)
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockImplementation(
            async () => ({
                address: "any",
                status: VALIDATOR_STATUS_ACTIVE,
            }),
        )
    })

    it("accepts a new proposal on the same key after the previous one was rejected", async () => {
        const effective = 1000 + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS

        // Seed a rejected proposal from PROPOSER_A on networkFee.
        proposalRepo._rows.set("p_rej", {
            proposalId: "p_rej",
            version: 1,
            proposerPublicKey: PROPOSER_A,
            proposedParameters: { networkFee: 5 },
            status: "rejected",
            snapshotBlock: 100,
            tallyBlock: 200,
            effectiveAtBlock: 300,
            rationale: "",
        })

        // Same proposer, same key — now accepted because rejected proposals
        // don't count toward the 1-open-per-proposer or key-lock rules.
        const r = await handleGovernanceTx(
            proposalTx(PROPOSER_A, "p_retry", { networkFee: 12 }, effective),
        )
        expect(r.success).toBe(true)
        // Edit/version assignment happens at apply time, not in the handler.
    })

    it("still rejects a duplicate proposalId even if status is rejected", async () => {
        const effective = 1000 + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS
        proposalRepo._rows.set("p_rej", {
            proposalId: "p_rej",
            version: 1,
            proposerPublicKey: PROPOSER_A,
            proposedParameters: { networkFee: 5 },
            status: "rejected",
            snapshotBlock: 100,
            tallyBlock: 200,
            effectiveAtBlock: 300,
            rationale: "",
        })
        const r = await handleGovernanceTx(
            proposalTx(PROPOSER_A, "p_rej", { networkFee: 12 }, effective),
        )
        expect(r.success).toBe(false)
        expect(r.message).toContain("proposalId already exists")
    })
})

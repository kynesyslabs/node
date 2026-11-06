import { describe, expect, it, mock } from "bun:test"

mock.module("@/utilities/logger", () => ({
    __esModule: true,
    default: { debug: () => {}, info: () => {}, warn: () => {}, warning: () => {}, error: () => {}, only: () => {}, custom: () => {} },
}))

const { default: dropPreGovernanceRows } = await import("./dropPreGovernanceRows")
const { default: applyNetworkUpgrade } = await import("./applyNetworkUpgrade")

/**
 * A node that ran an older binary keeps proposals and votes the fork-gated
 * binary never writes. With networkGovernance activating at 30, block 31 is
 * the first to admit governance edits and to activate due proposals.
 */

// Just the repository calls the two routines make, over plain rows.
function memoryRepo<T extends Record<string, any>>(rows: T[]) {
    const matches = (row: T, where: Record<string, any>) =>
        Object.entries(where).every(([key, cond]) =>
            cond && typeof cond === "object" && "_type" in cond
                ? cond._type === "lessThan" && row[key] < cond._value
                : row[key] === cond,
        )
    return {
        rows,
        find: async ({ where }: { where: Record<string, any> }) =>
            rows.filter(r => matches(r, where)),
        save: async (saved: T[]) => saved,
        delete: async (where: Record<string, any>) => {
            const kept = rows.filter(r => !matches(r, where))
            const affected = rows.length - kept.length
            rows.splice(0, rows.length, ...kept)
            return { affected }
        },
    } as any
}

function proposal(proposalId: string, snapshotBlock: number, status: string) {
    return {
        proposalId,
        snapshotBlock,
        tallyBlock: snapshotBlock + 1,
        effectiveAtBlock: 31,
        status,
        proposedParameters: { rpcFee: 7 },
    }
}

describe("rows recorded before networkGovernance activates", () => {
    it("an old row due at the first governance block activates without the drop", async () => {
        const proposals = memoryRepo([proposal("stale", 12, "activating")])
        const activated = await applyNetworkUpgrade(31, proposals)
        expect(activated.map(o => o.proposalId)).toEqual(["stale"])
    })

    it("are dropped at the activation block, rows from later blocks stay", async () => {
        const proposals = memoryRepo([
            proposal("stale", 12, "activating"),
            proposal("staleActive", 5, "active"),
            proposal("admitted", 30, "activating"),
        ])
        const votes = memoryRepo([
            { proposalId: "stale", voterAddress: "0xa", blockNumber: 13 },
            { proposalId: "admitted", voterAddress: "0xa", blockNumber: 30 },
        ])

        expect(await dropPreGovernanceRows(30, proposals, votes)).toEqual({
            proposals: 2,
            votes: 1,
        })
        expect(proposals.rows.map((p: any) => p.proposalId)).toEqual(["admitted"])
        expect(votes.rows.map((v: any) => v.proposalId)).toEqual(["admitted"])

        const activated = await applyNetworkUpgrade(31, proposals)
        expect(activated.map(o => o.proposalId)).toEqual(["admitted"])
    })
})

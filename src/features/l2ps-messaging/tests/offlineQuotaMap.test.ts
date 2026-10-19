/**
 * The per-sender offline quota table does not keep senders that owe nothing.
 *
 * Any key can send, and a key costs nothing to make, so an entry left behind
 * at zero is memory the node holds for as long as it runs.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { mockLogger } from "@/libs/blockchain/testSupport/mockMempoolDeps"

const rows = new Map<string, Record<string, any>>()
const repo = {
    count: async () => 0,
    findOneBy: async () => null,
    save: async (row: Record<string, any>) => {
        rows.set(row.id, { ...row })
        return row
    },
    update: async (criteria: unknown, patch: Record<string, any>) => {
        const ids = typeof criteria === "string" ? [criteria] : Array.isArray(criteria) ? criteria : []
        for (const id of ids) Object.assign(rows.get(id) ?? {}, patch)
        return { affected: ids.length }
    },
    find: async (query: { where: Array<{ id: string }> }) =>
        query.where.map(w => rows.get(w.id)).filter(Boolean).map(r => ({ ...r })),
}

mock.module("@/model/datasource", () => ({
    __esModule: true,
    dataSource: { getRepository: () => repo },
}))
mock.module("@/libs/l2ps/parallelNetworks", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/blockchain/transaction", () => ({ __esModule: true, default: class {} }))
mock.module("@/libs/blockchain/l2ps_mempool", () => ({ __esModule: true, default: {} }))
mock.module("@/libs/l2ps/L2PSTransactionExecutor", () => ({ __esModule: true, default: {} }))
mockLogger()

const { L2PSMessagingService } = await import("../L2PSMessagingService")
const service = L2PSMessagingService.getInstance() as any

const encrypted = { ciphertext: Buffer.from("m").toString("base64"), nonce: Buffer.from("n").toString("base64") }
const SENDERS = 2000

beforeEach(() => {
    rows.clear()
    service.offlineMessageCounts.clear()
})

describe("offline quota table", () => {
    it("drops a sender whose offline send failed to submit", async () => {
        jest.spyOn(service, "submitToL2PS").mockImplementation(async () => ({ success: false, error: "down" }))

        for (let i = 0; i < SENDERS; i++) {
            await service.processMessage(`sender${i}`, "absent", "subnet_a", `id${i}`, `h${i}`, encrypted, false)
        }

        expect(service.offlineMessageCounts.size).toBe(0)
    })

    it("drops a sender once the recipient has collected every queued message", async () => {
        jest.spyOn(service, "submitToL2PS").mockImplementation(async () => ({ success: true, txHash: "0xtx" }))

        const ids: string[] = []
        for (let i = 0; i < SENDERS; i++) {
            await service.processMessage(`sender${i}`, "absent", "subnet_a", `id${i}`, `h${i}`, encrypted, false)
            ids.push(`id${i}`)
        }
        expect(service.offlineMessageCounts.size).toBe(SENDERS)

        await service.markDelivered(ids)

        expect(service.offlineMessageCounts.size).toBe(0)
    })

    it("keeps counting a sender that still has messages queued", async () => {
        jest.spyOn(service, "submitToL2PS").mockImplementation(async () => ({ success: true, txHash: "0xtx" }))

        for (let i = 0; i < 3; i++) {
            await service.processMessage("sender", "absent", "subnet_a", `id${i}`, `h${i}`, encrypted, false)
        }
        await service.markDelivered(["id0"])

        expect(service.offlineMessageCounts.get("sender")).toBe(2)
    })
})

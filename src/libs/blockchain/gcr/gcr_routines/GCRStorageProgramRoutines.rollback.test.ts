/**
 * A storage edit carries only what it writes, never what it replaced, so a
 * rollback cannot restore the row. Each operation must refuse a rollback and
 * leave the row as it was: replayed forward, a write keeps its data, an ACL
 * change stays, a create or delete re-runs against the wrong state, and the
 * caller would record the undo as done.
 */

import { describe, expect, it, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        only: () => {},
    },
}))

import { GCRStorageProgram } from "@/model/entities/GCRv2/GCR_StorageProgram"
import { GCRStorageProgramRoutines } from "./GCRStorageProgramRoutines"

const OWNER = "0x" + "aa".repeat(32)
const WRITER = "0x" + "bb".repeat(32)
const ADDRESS = "stor-" + "ab".repeat(20)

function program(overrides: Partial<GCRStorageProgram> = {}): GCRStorageProgram {
    const p = new GCRStorageProgram()
    p.storageAddress = ADDRESS
    p.owner = OWNER
    p.programName = "probe"
    p.encoding = "json"
    p.data = { n: 1 }
    p.sizeBytes = Buffer.byteLength(JSON.stringify(p.data))
    p.acl = { mode: "owner" }
    p.metadata = null
    p.storageLocation = "onchain"
    p.ipfsCid = null
    p.salt = null
    p.createdByTx = "tx_create"
    p.lastModifiedByTx = "tx_write"
    p.interactionTxs = ["tx_create", "tx_write"]
    p.totalFeesPaid = 2n
    p.isDeleted = false
    p.deletedByTx = null
    return Object.assign(p, overrides)
}

function rollbackOf(operation: string, variables: Record<string, unknown>, txhash: string): any {
    return {
        type: "storageProgram",
        target: ADDRESS,
        isRollback: true,
        txhash,
        context: {
            operation,
            sender: OWNER,
            data: { variables: { operation, storageAddress: ADDRESS, ...variables }, metadata: null },
        },
    }
}

const snapshot = (p: GCRStorageProgram) => structuredClone({ ...p })

// The row as each operation left it, and the edit that rolls that operation back.
const cases: [string, () => GCRStorageProgram | null, any][] = [
    [
        "CREATE_STORAGE_PROGRAM",
        () => program({ data: { n: 1 }, lastModifiedByTx: "tx_create", interactionTxs: ["tx_create"] }),
        rollbackOf("CREATE_STORAGE_PROGRAM", { programName: "probe", data: { n: 1 } }, "tx_create"),
    ],
    [
        "WRITE_STORAGE",
        () => program({ data: { n: 2 } }),
        rollbackOf("WRITE_STORAGE", { data: { n: 2 } }, "tx_write"),
    ],
    [
        "UPDATE_ACCESS_CONTROL",
        () => program({ acl: { mode: "restricted", allowed: [WRITER] } as any }),
        rollbackOf("UPDATE_ACCESS_CONTROL", { acl: { mode: "restricted", allowed: [WRITER] } }, "tx_write"),
    ],
    [
        "DELETE_STORAGE_PROGRAM",
        () => program({ isDeleted: true, deletedByTx: "tx_write" }),
        rollbackOf("DELETE_STORAGE_PROGRAM", {}, "tx_write"),
    ],
]

describe("rolling back a storage program edit", () => {
    for (const [operation, row, edit] of cases) {
        it(`${operation} is refused and leaves the row untouched`, async () => {
            const stored = row()
            const before = stored ? snapshot(stored) : null
            const result = await GCRStorageProgramRoutines.apply(edit, stored, false)
            expect(result.success).toBe(false)
            expect(result.message).toContain("cannot be rolled back")
            expect(result.storageProgram).toBeUndefined()
            expect(stored ? snapshot(stored) : null).toEqual(before)
        })
    }

    it("a rollback is refused even on the simulate path", async () => {
        const stored = program({ data: { n: 2 } })
        const result = await GCRStorageProgramRoutines.apply(
            rollbackOf("WRITE_STORAGE", { data: { n: 2 } }, "tx_write"),
            stored,
            true,
        )
        expect(result.success).toBe(false)
    })
})

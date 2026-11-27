/**
 * A deleted storage program keeps its row and its proven record, and readers
 * trust an address through its owner. Creating it again must stay with that
 * owner, or a stranger takes over an address others already rely on.
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
const STRANGER = "0x" + "cc".repeat(32)
const ADDRESS = "stor-" + "ab".repeat(20)

function edit(operation: string, sender: string, variables: Record<string, unknown> = {}): any {
    return {
        type: "storageProgram",
        target: ADDRESS,
        isRollback: false,
        txhash: `tx_${operation}_${sender.slice(2, 6)}`,
        context: {
            operation,
            sender,
            data: {
                variables: { operation, storageAddress: ADDRESS, ...variables },
                metadata: null,
            },
        },
    }
}

const createBy = (sender: string, data: Record<string, unknown> = { seller: "listed" }) =>
    edit("CREATE_STORAGE_PROGRAM", sender, { programName: "listing", data, acl: { mode: "public" } })

async function createdByOwner(): Promise<GCRStorageProgram> {
    const result = await GCRStorageProgramRoutines.apply(createBy(OWNER), null, false)
    expect(result.success).toBe(true)
    return result.storageProgram as GCRStorageProgram
}

async function deletedByOwner(): Promise<GCRStorageProgram> {
    const program = await createdByOwner()
    const result = await GCRStorageProgramRoutines.apply(
        edit("DELETE_STORAGE_PROGRAM", OWNER),
        program,
        false,
    )
    expect(result.success).toBe(true)
    expect(program.isDeleted).toBe(true)
    return program
}

describe("creating a storage program at an address that already has one", () => {
    it("refuses a stranger on a deleted program, simulated or applied, and changes nothing", async () => {
        const program = await deletedByOwner()
        const before = structuredClone(program)

        for (const simulate of [true, false]) {
            const result = await GCRStorageProgramRoutines.apply(
                createBy(STRANGER, { seller: "forged" }),
                program,
                simulate,
            )
            expect(result.success).toBe(false)
            expect(result.message).toContain("only that owner can create it again")
            expect(result.storageProgram).toBeUndefined()
        }
        expect(program).toEqual(before)
        expect(program.owner).toBe(OWNER)
    })

    it("lets the owner create a deleted program again", async () => {
        const program = await deletedByOwner()

        const result = await GCRStorageProgramRoutines.apply(
            createBy(OWNER, { seller: "relisted" }),
            program,
            false,
        )

        expect(result.success).toBe(true)
        const recreated = result.storageProgram as GCRStorageProgram
        expect(recreated.owner).toBe(OWNER)
        expect(recreated.isDeleted).toBe(false)
        expect(recreated.data).toEqual({ seller: "relisted" })
    })

    it("refuses anyone, the owner included, on a live program", async () => {
        const program = await createdByOwner()
        for (const sender of [OWNER, STRANGER]) {
            const result = await GCRStorageProgramRoutines.apply(createBy(sender), program, false)
            expect(result.success).toBe(false)
            expect(result.message).toContain("already exists")
        }
    })

    it("lets anyone create at an address that has no program", async () => {
        const result = await GCRStorageProgramRoutines.apply(createBy(STRANGER), null, false)
        expect(result.success).toBe(true)
        expect((result.storageProgram as GCRStorageProgram).owner).toBe(STRANGER)
    })
})

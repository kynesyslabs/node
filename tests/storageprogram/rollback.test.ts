import "./mockDatasource"
import { beforeEach, describe, expect, test } from "bun:test"
import { FakeGCRMainRepository } from "./fakeRepository"

// Loaded after the datasource stub is registered. Class-like default exports
// keep their PascalCase names.
/* eslint-disable @typescript-eslint/naming-convention */
const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

const DEPLOYER = "a".repeat(64)
const TARGET = "stor-" + "1".repeat(40)
const CREATE_TX = "1".repeat(64)
const OTHER_TX = "2".repeat(64)

function applyEdit(edit: any, repo: FakeGCRMainRepository, simulate = false) {
    // applyStorageProgramEdit is private; the tests drive it directly with a fake repository
    return (HandleGCR as any).applyStorageProgramEdit(edit, repo, simulate)
}

function edit(
    operation: string,
    txhash: string,
    data?: any,
    isRollback = false,
) {
    return {
        type: "storageProgram",
        target: TARGET,
        isRollback,
        txhash,
        context: { operation, sender: DEPLOYER, ...(data ? { data } : {}) },
    }
}

const createData = {
    variables: { a: 1 },
    metadata: {
        programName: "app",
        deployer: DEPLOYER,
        accessControl: "private",
        allowedAddresses: [],
        created: 1,
        lastModified: 1,
        size: 0,
    },
}
const writeData = { variables: { a: 2, b: 3 }, metadata: { lastModified: 2 } }
const aclData = {
    variables: {},
    metadata: {
        accessControl: "public",
        allowedAddresses: [],
        lastModified: 2,
    },
}

let repo: FakeGCRMainRepository
beforeEach(async () => {
    repo = new FakeGCRMainRepository()
    expect(
        (await applyEdit(edit("CREATE", CREATE_TX, createData), repo)).success,
    ).toBe(true)
})

describe("storage program rollback (finding 2)", () => {
    test("rolling back CREATE removes the row it created", async () => {
        const res = await applyEdit(
            edit("CREATE", CREATE_TX, createData, true),
            repo,
        )
        expect(res.success).toBe(true)
        expect(repo.rows.has(TARGET)).toBe(false)
    })

    test("rolling back a CREATE from another tx leaves the existing row alone", async () => {
        const res = await applyEdit(
            edit("CREATE", OTHER_TX, createData, true),
            repo,
        )
        expect(res.success).toBe(true)
        expect(repo.rows.has(TARGET)).toBe(true)
    })

    test("simulated CREATE rollback does not touch the row", async () => {
        await applyEdit(edit("CREATE", CREATE_TX, createData, true), repo, true)
        expect(repo.rows.has(TARGET)).toBe(true)
    })

    test("rolling back WRITE does not merge the data again and fails visibly", async () => {
        const before = repo.rows.get(TARGET).data
        const res = await applyEdit(
            edit("WRITE", OTHER_TX, writeData, true),
            repo,
        )
        expect(res.success).toBe(false)
        expect(res.message).toContain("not supported")
        expect(repo.rows.get(TARGET).data).toEqual(before)
    })

    test("rolling back UPDATE_ACCESS_CONTROL does not re-apply the ACL", async () => {
        const res = await applyEdit(
            edit("UPDATE_ACCESS_CONTROL", OTHER_TX, aclData, true),
            repo,
        )
        expect(res.success).toBe(false)
        expect(repo.rows.get(TARGET).data.metadata.accessControl).toBe(
            "private",
        )
    })

    test("rolling back DELETE does not delete the program", async () => {
        const res = await applyEdit(
            edit("DELETE", OTHER_TX, undefined, true),
            repo,
        )
        expect(res.success).toBe(false)
        expect(repo.rows.get(TARGET).data.metadata).not.toBeNull()
    })
})

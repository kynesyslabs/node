import "./mockDatasource"
import { beforeEach, describe, expect, test } from "bun:test"
import { FakeGCRMainRepository } from "./fakeRepository"

// Loaded after the datasource stub is registered
const { default: HandleGCR } = await import("@/libs/blockchain/gcr/handleGCR")

const DEPLOYER = "a".repeat(64)
const TARGET = "stor-" + "1".repeat(40)

function applyEdit(edit: any, repo: FakeGCRMainRepository, simulate = false) {
    // applyStorageProgramEdit is private; the tests drive it directly with a fake repository
    return (HandleGCR as any).applyStorageProgramEdit(edit, repo, simulate)
}

function storageEdit(operation: string, data?: any, isRollback = false) {
    return {
        type: "storageProgram",
        target: TARGET,
        isRollback,
        txhash: "f".repeat(64),
        context: { operation, sender: DEPLOYER, ...(data ? { data } : {}) },
    }
}

function createEdit(variables: any) {
    return storageEdit("CREATE", {
        variables,
        metadata: {
            programName: "app",
            deployer: DEPLOYER,
            accessControl: "private",
            allowedAddresses: [],
            created: 1,
            lastModified: 1,
            size: 0,
        },
    })
}

function nested(depth: number) {
    let obj: any = { leaf: true }
    for (let i = 0; i < depth; i++) obj = { n: obj }
    return obj
}

let repo: FakeGCRMainRepository
beforeEach(() => {
    repo = new FakeGCRMainRepository()
})

describe("data limits at GCR apply (finding 6)", () => {
    test("CREATE edit with a key over 256 chars is rejected", async () => {
        const res = await applyEdit(createEdit({ ["k".repeat(300)]: 1 }), repo)
        expect(res.success).toBe(false)
        expect(repo.rows.size).toBe(0)
    })

    test("CREATE edit nested deeper than 64 levels is rejected", async () => {
        const res = await applyEdit(createEdit(nested(70)), repo)
        expect(res.success).toBe(false)
        expect(repo.rows.size).toBe(0)
    })

    test("WRITE edit with a key over 256 chars is rejected", async () => {
        expect((await applyEdit(createEdit({ a: 1 }), repo)).success).toBe(true)
        const res = await applyEdit(
            storageEdit("WRITE", {
                variables: { ["k".repeat(300)]: 1 },
                metadata: { lastModified: 2 },
            }),
            repo,
        )
        expect(res.success).toBe(false)
        expect(repo.rows.get(TARGET).data.variables).toEqual({ a: 1 })
    })

    test("valid CREATE and WRITE edits still apply", async () => {
        expect((await applyEdit(createEdit({ a: 1 }), repo)).success).toBe(true)
        const res = await applyEdit(
            storageEdit("WRITE", { variables: { b: 2 }, metadata: { lastModified: 2 } }),
            repo,
        )
        expect(res.success).toBe(true)
        expect(repo.rows.get(TARGET).data.variables).toEqual({ a: 1, b: 2 })
    })
})

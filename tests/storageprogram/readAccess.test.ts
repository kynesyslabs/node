import { testDatabase } from "./mockDatasource"
import { beforeEach, describe, expect, test } from "bun:test"
import { FakeGCRMainRepository } from "./fakeRepository"

// Loaded after the datasource stub is registered
const { manageNodeCall } = await import("@/libs/network/manageNodeCall")

const DEPLOYER = "a".repeat(64)
const PUBLIC_ADDR = "stor-" + "1".repeat(40)
const PRIVATE_ADDR = "stor-" + "2".repeat(40)

function program(pubkey: string, accessControl: string) {
    return {
        pubkey,
        data: {
            variables: { secret: "v" },
            metadata: { deployer: DEPLOYER, accessControl, allowedAddresses: [] },
        },
    }
}

function read(storageAddress: string, extra: Record<string, unknown> = {}) {
    return manageNodeCall(
        { message: "getStorageProgram", data: { storageAddress, ...extra }, muid: "" } as any,
        // nodeCall is a no-auth RPC method, so server_rpc always passes ""
        "",
    )
}

beforeEach(async () => {
    const repo = new FakeGCRMainRepository()
    await repo.save(program(PUBLIC_ADDR, "public"))
    await repo.save(program(PRIVATE_ADDR, "private"))
    testDatabase.repository = repo
})

// Finding 5 is left unresolved (see report): these tests pin the current
// fail-closed behaviour so a future read-auth change cannot open a bypass.
describe("getStorageProgram read access (finding 5, current behaviour)", () => {
    test("anonymous read of a public program succeeds", async () => {
        const res = await read(PUBLIC_ADDR)
        expect(res.result).toBe(200)
    })

    test("anonymous read of a private program is refused", async () => {
        const res = await read(PRIVATE_ADDR)
        expect(res.result).toBe(403)
    })

    test("a caller-supplied sender/requester value does not grant access", async () => {
        const res = await read(PRIVATE_ADDR, {
            sender: DEPLOYER,
            requesterAddress: DEPLOYER,
        })
        expect(res.result).toBe(403)
    })
})

import "./mockDatasource"
import { describe, expect, test } from "bun:test"
import { StorageProgram } from "@kynesyslabs/demosdk/storage"

// Loaded after the datasource stub is registered
const { default: handleStorageProgramTransaction } = await import(
    "@/libs/network/routines/transactions/handleStorageProgramTransaction"
)

const VICTIM = "a".repeat(64)
const SQUATTER = "b".repeat(64)
const TX_HASH = "c".repeat(64)

function createPayload(deployer: string, storageAddress?: string) {
    const payload = StorageProgram.createStorageProgram(
        deployer,
        "myApp",
        { k: "v" },
        "public",
        "salt1",
    )
    if (storageAddress) payload.storageAddress = storageAddress
    return payload
}

describe("storage program address derivation (finding 3)", () => {
    test("CREATE with the address derived from the sender is accepted", async () => {
        const res = await handleStorageProgramTransaction(
            createPayload(VICTIM),
            VICTIM,
            TX_HASH,
        )
        expect(res.success).toBe(true)
        expect(res.gcrEdits?.[0].target).toBe(
            StorageProgram.deriveStorageAddress(VICTIM, "myApp", "salt1"),
        )
    })

    test("squatter cannot CREATE at the address the victim will derive", async () => {
        const victimAddress = StorageProgram.deriveStorageAddress(VICTIM, "myApp", "salt1")
        const res = await handleStorageProgramTransaction(
            createPayload(SQUATTER, victimAddress),
            SQUATTER,
            TX_HASH,
        )
        expect(res.success).toBe(false)
        expect(res.message).toContain("does not match")
    })

    test("CREATE targeting a regular account pubkey is rejected", async () => {
        const res = await handleStorageProgramTransaction(
            createPayload(SQUATTER, VICTIM),
            SQUATTER,
            TX_HASH,
        )
        expect(res.success).toBe(false)
        expect(res.message).toContain("Invalid storageAddress")
    })

    test("WRITE/DELETE on a non-stor- address are rejected", async () => {
        for (const payload of [
            StorageProgram.writeStorage(VICTIM, { k: "v" }),
            StorageProgram.deleteStorageProgram(VICTIM),
        ]) {
            const res = await handleStorageProgramTransaction(
                payload,
                SQUATTER,
                TX_HASH,
            )
            expect(res.success).toBe(false)
        }
    })
})

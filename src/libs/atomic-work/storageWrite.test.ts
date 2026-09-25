import { describe, expect, it } from "bun:test"

import {
    assertDerivedAddress,
    assertStorageWriteAllowed,
    deriveStorageAddress,
    isDerivedStorageAddress,
    STORAGE_ADDRESS_PREFIX,
    storageValueDigest,
    storageWriteOutput,
    StorageWriteError,
    type StorageWriteIntent,
} from "@/libs/atomic-work/storageWrite"

const DOMAIN = "test-storage:v1:"
const WRITER = "aa".repeat(32)
const OTHER = "bb".repeat(32)

const address = deriveStorageAddress(DOMAIN, WRITER, "commitment", "1")
const intent = (over: Partial<StorageWriteIntent> = {}): StorageWriteIntent => ({
    address,
    valueDigest: storageValueDigest({ paid: true }),
    mode: "create-only",
    ...over,
})

describe("address derivation", () => {
    it("is deterministic and prefixed", () => {
        expect(deriveStorageAddress(DOMAIN, WRITER, "commitment", "1")).toBe(address)
        expect(address.startsWith(STORAGE_ADDRESS_PREFIX)).toBe(true)
    })

    it("separates writers, names and discriminators", () => {
        const others = [
            deriveStorageAddress(DOMAIN, OTHER, "commitment", "1"),
            deriveStorageAddress(DOMAIN, WRITER, "receipt", "1"),
            deriveStorageAddress(DOMAIN, WRITER, "commitment", "2"),
            deriveStorageAddress("other-domain:v1:", WRITER, "commitment", "1"),
        ]

        expect(new Set([address, ...others]).size).toBe(5)
    })

    it("refuses an address the writer could not have derived", () => {
        // A caller naming its own address could write over someone else's
        // entry, or squat the address a later Work would derive.
        let thrown: StorageWriteError | undefined
        try {
            assertDerivedAddress(
                intent({ address: `${STORAGE_ADDRESS_PREFIX}${"0".repeat(40)}` }),
                DOMAIN, WRITER, "commitment", "1",
            )
        } catch (error) {
            thrown = error as StorageWriteError
        }

        expect(thrown?.reason).toBe("address-not-derived")
    })

    it("refuses another writer's address even with the same name", () => {
        expect(
            isDerivedStorageAddress(
                deriveStorageAddress(DOMAIN, OTHER, "commitment", "1"),
                DOMAIN, WRITER, "commitment", "1",
            ),
        ).toBe(false)
    })
})

describe("create-only", () => {
    it("writes into a vacant address", () => {
        expect(() => assertStorageWriteAllowed(undefined, intent())).not.toThrow()
    })

    it("refuses to replace an existing value", () => {
        expect(() =>
            assertStorageWriteAllowed({ valueDigest: "whatever" }, intent()),
        ).toThrow(/already holds a value/)
    })
})

describe("compare-and-set", () => {
    const prior = storageValueDigest({ paid: false })

    it("replaces exactly what the writer expected", () => {
        expect(() =>
            assertStorageWriteAllowed(
                { valueDigest: prior },
                intent({ mode: "compare-and-set", expectedPriorDigest: prior }),
            ),
        ).not.toThrow()
    })

    it("refuses when the value moved since the write was prepared", () => {
        expect(() =>
            assertStorageWriteAllowed(
                { valueDigest: storageValueDigest({ paid: true }) },
                intent({ mode: "compare-and-set", expectedPriorDigest: prior }),
            ),
        ).toThrow(/changed since this write was prepared/)
    })

    it("refuses a blind overwrite dressed as a compare-and-set", () => {
        // Without an expectation this is just an overwrite, and an overwrite
        // inside a Work that may roll back destroys the state another attempt
        // is about to be judged against.
        expect(() =>
            assertStorageWriteAllowed({ valueDigest: prior }, intent({ mode: "compare-and-set" })),
        ).toThrow(/must say what it expects to replace/)
    })

    it("refuses when there is nothing to compare against", () => {
        expect(() =>
            assertStorageWriteAllowed(
                undefined,
                intent({ mode: "compare-and-set", expectedPriorDigest: prior }),
            ),
        ).toThrow(/holds nothing to compare against/)
    })
})

describe("what the receipt binds", () => {
    it("names what was replaced, not only what was written", () => {
        const prior = storageValueDigest({ paid: false })
        const created = storageWriteOutput(intent(), undefined, DOMAIN)
        const replaced = storageWriteOutput(
            intent({ mode: "compare-and-set", expectedPriorDigest: prior }),
            { valueDigest: prior },
            DOMAIN,
        )

        expect(created.priorDigest).toBeNull()
        expect(replaced.priorDigest).toBe(prior)
        // "Created" and "overwrote something" must not prove the same thing.
        expect(created.outputHash).not.toBe(replaced.outputHash)
    })

    it("changes when the written value changes", () => {
        const a = storageWriteOutput(intent(), undefined, DOMAIN)
        const b = storageWriteOutput(
            intent({ valueDigest: storageValueDigest({ paid: false }) }),
            undefined,
            DOMAIN,
        )

        expect(a.outputHash).not.toBe(b.outputHash)
    })
})

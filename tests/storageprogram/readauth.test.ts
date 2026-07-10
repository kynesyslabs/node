import { beforeAll, describe, expect, it, jest } from "@jest/globals"

// Mock logger (matches the other storageprogram suites)
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))

// Mock SDK barrel + datasource so importing the routines module is side-effect
// free (no real DB). The demosdk/encryption mock's ucrypto.verify returns true,
// so a well-formed envelope verifies; freshness/parse checks run before it.
jest.mock("@kynesyslabs/demosdk", () => ({
    __esModule: true,
    types: {},
    storage: {},
}))
jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

let resolveReadRequester: typeof import("src/libs/network/routines/nodecalls/storageReadAuth")["resolveReadRequester"]
let readAuthScope: typeof import("src/libs/network/routines/nodecalls/storageReadAuth")["readAuthScope"]
let READ_AUTH_MAX_SKEW_MS: number
let GCRStorageProgramRoutines: typeof import("src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines")["GCRStorageProgramRoutines"]

// An allowlisted address = the raw public-key hex (the ACL address form).
const ALLOWED_HEX = "aa".repeat(32)
const STORAGE_ADDRESS = "stor-" + "0".repeat(40)

function restrictedProgram() {
    return {
        storageAddress: STORAGE_ADDRESS,
        owner: "bb".repeat(32),
        acl: { mode: "restricted", allowed: [ALLOWED_HEX] },
    } as any
}

function publicProgram() {
    return {
        storageAddress: STORAGE_ADDRESS,
        owner: "bb".repeat(32),
        acl: { mode: "public" },
    } as any
}

// A well-formed, fresh auth envelope naming ALLOWED_HEX. ucrypto.verify is
// mocked to true, so this stands in for a real signature.
function validAuth(scope = readAuthScope.program(STORAGE_ADDRESS)) {
    void scope
    return {
        identity: `ed25519:${ALLOWED_HEX}`,
        signature: "cc".repeat(64),
        timestamp: Date.now(),
    }
}

beforeAll(async () => {
    ;({ resolveReadRequester, readAuthScope, READ_AUTH_MAX_SKEW_MS } =
        await import("src/libs/network/routines/nodecalls/storageReadAuth"))
    ;({ GCRStorageProgramRoutines } = await import(
        "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
    ))
})

describe("storage read-auth: resolveReadRequester", () => {
    const scope = () => readAuthScope.program(STORAGE_ADDRESS)

    it("returns undefined when no auth envelope is supplied", async () => {
        expect(await resolveReadRequester(scope(), undefined)).toBeUndefined()
    })

    it("ignores a caller-supplied address string with no signature", async () => {
        // The core of the fix: a bare requesterAddress-style value is never
        // trusted for authorization.
        expect(
            await resolveReadRequester(scope(), { identity: ALLOWED_HEX }),
        ).toBeUndefined()
    })

    it("rejects a malformed identity (no algorithm prefix)", async () => {
        const auth = { ...validAuth(), identity: ALLOWED_HEX }
        expect(await resolveReadRequester(scope(), auth)).toBeUndefined()
    })

    it("rejects a stale timestamp (outside the freshness window)", async () => {
        const auth = {
            ...validAuth(),
            timestamp: Date.now() - (READ_AUTH_MAX_SKEW_MS + 1000),
        }
        expect(await resolveReadRequester(scope(), auth)).toBeUndefined()
    })

    it("rejects a future timestamp (outside the freshness window)", async () => {
        const auth = {
            ...validAuth(),
            timestamp: Date.now() + (READ_AUTH_MAX_SKEW_MS + 1000),
        }
        expect(await resolveReadRequester(scope(), auth)).toBeUndefined()
    })

    it("returns the verified public key for a fresh, valid signature", async () => {
        const requester = await resolveReadRequester(scope(), validAuth())
        expect(requester).toBe(ALLOWED_HEX)
    })
})

describe("storage read-auth: end-to-end ACL enforcement", () => {
    const scope = () => readAuthScope.program(STORAGE_ADDRESS)

    it("denies a restricted read with no auth (anonymous)", async () => {
        const requester = await resolveReadRequester(scope(), undefined)
        expect(
            GCRStorageProgramRoutines.checkReadPermission(
                restrictedProgram(),
                requester,
            ),
        ).toBe(false)
    })

    it("denies a restricted read that only names an allowed address", async () => {
        // Bypass attempt: name the allowlisted address but provide no signature.
        const requester = await resolveReadRequester(scope(), {
            identity: ALLOWED_HEX,
        })
        expect(
            GCRStorageProgramRoutines.checkReadPermission(
                restrictedProgram(),
                requester,
            ),
        ).toBe(false)
    })

    it("allows a restricted read with a valid signature for an allowed address", async () => {
        const requester = await resolveReadRequester(scope(), validAuth())
        expect(
            GCRStorageProgramRoutines.checkReadPermission(
                restrictedProgram(),
                requester,
            ),
        ).toBe(true)
    })

    it("allows a public read with no auth", async () => {
        const requester = await resolveReadRequester(scope(), undefined)
        expect(
            GCRStorageProgramRoutines.checkReadPermission(
                publicProgram(),
                requester,
            ),
        ).toBe(true)
    })
})

import { describe, expect, it, jest } from "@jest/globals"

// The two read surfaces #970 did not cover — the HTTP route layer and the
// `gcr_routine` dispatcher — must derive the ACL requester from a VERIFIED
// identity, never a caller-supplied value. These lock that in.
//
// Mock only the heavy/side-effectful imports so the modules load without a DB
// or SDK. authContext is left REAL: the whole point is that the HTTP handler
// reads the middleware-verified context, so the test drives that real context.
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("@kynesyslabs/demosdk", () => ({ __esModule: true, types: {}, storage: {} }))
jest.mock("@/model/datasource", () => ({ __esModule: true, default: { getInstance: jest.fn() } }))
jest.mock("@/libs/network/bunServer", () => ({
    __esModule: true,
    jsonResponse: (body: unknown, status = 200) => ({ body, status }),
}))

let getRequesterAddress: typeof import("@/features/storageprogram/routes")["getRequesterAddress"]
let setAuthContext: typeof import("@/libs/network/authContext")["setAuthContext"]

const KEY = "aa".repeat(32) // raw public-key hex — the ACL address form

beforeAll(async () => {
    ;({ getRequesterAddress } = await import("@/features/storageprogram/routes"))
    ;({ setAuthContext } = await import("@/libs/network/authContext"))
})

function reqNamingAllowed(): Request {
    // A caller that NAMES an allowlisted address in the raw `identity` header,
    // with no signature — the exact bypass attempt.
    return new Request("http://node/storage-program/stor-" + "0".repeat(40), {
        headers: { identity: `ed25519:${KEY}` },
    })
}

describe("HTTP read surface: getRequesterAddress", () => {
    it("ignores the raw identity header — an unsigned caller is anonymous", () => {
        // No auth context set (middleware never verified a signature), so even
        // though the header names an allowed address, the requester is anonymous.
        expect(getRequesterAddress(reqNamingAllowed())).toBeUndefined()
    })

    it("returns the requester only from the middleware-verified context", () => {
        const req = reqNamingAllowed()
        setAuthContext(req, {
            verified: true,
            identity: `ed25519:${KEY}`,
            publicKey: KEY,
            algorithm: "ed25519",
        })
        expect(getRequesterAddress(req)).toBe(KEY)
    })

    it("stays anonymous when the context carries no public key", () => {
        const req = reqNamingAllowed()
        setAuthContext(req, {
            verified: false,
            identity: null,
            publicKey: null,
            algorithm: null,
        })
        expect(getRequesterAddress(req)).toBeUndefined()
    })
})

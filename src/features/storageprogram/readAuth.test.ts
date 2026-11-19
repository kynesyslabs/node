/**
 * A storage program's read ACL is checked against the requester that a
 * verified signature proves, never against an address the request names
 * about itself (an `identity` header without a signature, or a
 * `requesterAddress` field in the body). An unproven requester is anonymous
 * and reads public programs only. Covers the HTTP routes, nodeCall over
 * HTTP and Omni, and gcr_routine.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const OWNER = "0x" + "0a".repeat(32)
const ADDR = "stor-" + "ab".repeat(20)

const logger = {
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
        custom: jest.fn(),
    },
}
jest.mock("src/utilities/logger", () => logger)
jest.mock("@/utilities/logger", () => logger)

const realDatasource = await import("src/model/datasource")
const datasource = {
    ...realDatasource,
    __esModule: true,
    default: {
        getInstance: async () => ({
            getDataSource: () => ({ getRepository: () => ({}) }),
        }),
    },
}
jest.mock("src/model/datasource", () => datasource)
jest.mock("@/model/datasource", () => datasource)

const { GCRStorageProgramRoutines } = await import(
    "src/libs/blockchain/gcr/gcr_routines/GCRStorageProgramRoutines"
)

const program = {
    storageAddress: ADDR,
    owner: OWNER,
    programName: "secret",
    encoding: "json",
    data: { secret: 1 },
    metadata: null,
    acl: { mode: "owner" },
    storageLocation: "onchain",
    sizeBytes: 12,
    isDeleted: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
}

// What the list queries were asked to filter for.
const listedFor: (string | undefined)[] = []
const routines = GCRStorageProgramRoutines as any
routines.getStorageProgram = async () => program
routines.getStorageProgramsByOwner = async (
    _owner: string,
    _repo: unknown,
    requesterAddress?: string,
) => {
    listedFor.push(requesterAddress)
    return []
}
routines.searchStorageProgramsByName = async (
    _q: string,
    _repo: unknown,
    options?: { requesterAddress?: string },
) => {
    listedFor.push(options?.requesterAddress)
    return []
}

const { registerStorageProgramRoutes } = await import("./routes")
const { setAuthContext } = await import("src/libs/network/authContext")
const { manageNodeCall } = await import("src/libs/network/manageNodeCall")
const { default: manageGCRRoutines } = await import(
    "src/libs/network/manageGCRRoutines"
)
const { handleNodeCall } = await import(
    "src/libs/omniprotocol/protocol/handlers/control"
)
const { encodeNodeCallRequest, decodeNodeCallResponse } = await import(
    "src/libs/omniprotocol/serialization/control"
)

const routes = new Map<string, (req: Request) => Promise<Response>>()
registerStorageProgramRoutes({
    get(path: string, handler: any) {
        routes.set(path, handler)
        return this
    },
} as any)

async function httpGet(path: string, route: string, verifiedAs?: string) {
    const req = new Request("http://node" + path, {
        headers: { identity: "ed25519:" + OWNER },
    })
    if (verifiedAs) {
        setAuthContext(req, {
            verified: true,
            identity: "ed25519:" + verifiedAs,
            publicKey: verifiedAs,
            algorithm: "ed25519",
        })
    }
    return (await routes.get(route)!(req)).status
}

async function omniNodeCall(data: unknown, peerIdentity = "") {
    const reply = await handleNodeCall({
        message: {
            payload: encodeNodeCallRequest({
                method: "nodeCall",
                params: [{ message: "getStorageProgram", data, muid: "" }],
            }),
        },
        context: { isAuthenticated: peerIdentity !== "", peerIdentity },
    } as any)
    return decodeNodeCallResponse(reply).status
}

beforeEach(() => {
    listedFor.length = 0
})

describe("HTTP storage routes", () => {
    it("treat an unsigned identity header as anonymous", async () => {
        expect(await httpGet(`/storage-program/${ADDR}`, "/storage-program/*")).toBe(403)
    })

    it("serve the owner proven by a verified signature", async () => {
        expect(
            await httpGet(`/storage-program/${ADDR}`, "/storage-program/*", OWNER),
        ).toBe(200)
    })

    it("list by owner as anonymous for an unsigned identity header", async () => {
        await httpGet(`/storage-program/owner/${OWNER}`, "/storage-program/owner/*")
        expect(listedFor).toEqual([undefined])
    })
})

describe("nodeCall storage reads", () => {
    it("ignore a requesterAddress the caller names", async () => {
        const res = await manageNodeCall({
            message: "getStorageProgram",
            data: { storageAddress: ADDR, requesterAddress: OWNER },
            muid: "",
        })
        expect(res.result).toBe(403)
    })

    it("serve the verified sender", async () => {
        const res = await (manageNodeCall as any)(
            { message: "getStorageProgram", data: { storageAddress: ADDR }, muid: "" },
            OWNER,
        )
        expect(res.result).toBe(200)
    })

    it("list and search as anonymous without a verified sender", async () => {
        await manageNodeCall({
            message: "getStorageProgramsByOwner",
            data: { owner: OWNER, requesterAddress: OWNER },
            muid: "",
        })
        await manageNodeCall({
            message: "searchStoragePrograms",
            data: { query: "secret", requesterAddress: OWNER },
            muid: "",
        })
        expect(listedFor).toEqual([undefined, undefined])
    })

    it("over Omni ignore the named requester and serve the authenticated peer", async () => {
        expect(await omniNodeCall({ storageAddress: ADDR, requesterAddress: OWNER })).toBe(403)
        expect(await omniNodeCall({ storageAddress: ADDR }, OWNER)).toBe(200)
    })
})

describe("gcr_routine storage reads", () => {
    it("ignore a requester address in the params", async () => {
        const res = await manageGCRRoutines("", {
            method: "getStorageProgram",
            params: [ADDR, OWNER],
        } as any)
        expect(res.result).toBe(403)
    })

    it("serve the verified sender", async () => {
        const res = await manageGCRRoutines(OWNER, {
            method: "getStorageProgram",
            params: [ADDR],
        } as any)
        expect(res.result).toBe(200)
    })

    it("list and search as anonymous without a verified sender", async () => {
        await manageGCRRoutines("", {
            method: "getStorageProgramsByOwner",
            params: [OWNER, OWNER],
        } as any)
        await manageGCRRoutines("", {
            method: "searchStoragePrograms",
            params: ["secret", {}, OWNER],
        } as any)
        expect(listedFor).toEqual([undefined, undefined])
    })
})

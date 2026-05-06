import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        custom: jest.fn(),
    },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

// sharedState drags in the whole framework (Chain → Peer → SDK/utils). For a
// unit test of the loader we only need the `networkParameters` slot, so we
// substitute a minimal stand-in.
const sharedStateStub: { networkParameters: unknown } = { networkParameters: null }
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
    default: class SharedState {
        static getInstance() {
            return sharedStateStub
        }
    },
}))

import { getGenesisNetworkParameters } from "@/features/networkUpgrade/constants"
import type { NetworkParameters } from "@/features/networkUpgrade/types"
// Snapshot of the env-resolved genesis used by the loader. Captured once so
// the assertions stay stable even if Config is re-read.
const GENESIS = getGenesisNetworkParameters()

let loadNetworkParameters: typeof import("@/libs/blockchain/routines/loadNetworkParameters").loadNetworkParameters

beforeAll(async () => {
    ({ loadNetworkParameters } = await import(
        "@/libs/blockchain/routines/loadNetworkParameters"
    ))
})

function makeRepo(rows: Array<Record<string, unknown>>) {
    return {
        find: jest.fn(async () => rows),
    } as any
}

describe("loadNetworkParameters", () => {
    beforeEach(() => {
        sharedStateStub.networkParameters = null
    })

    it("returns genesis defaults when no active upgrades exist", async () => {
        const repo = makeRepo([])
        const params = await loadNetworkParameters(repo)
        expect(params).toEqual(GENESIS)
        expect(sharedStateStub.networkParameters).toEqual(
            GENESIS,
        )
    })

    it("applies a single active upgrade on top of genesis", async () => {
        const repo = makeRepo([
            {
                proposalId: "p1",
                effectiveAtBlock: 100,
                proposedParameters: { networkFee: 25 },
            },
        ])
        const params = await loadNetworkParameters(repo)
        expect(params.networkFee).toBe(25)
        // untouched keys unchanged
        expect(params.rpcFee).toBe(GENESIS.rpcFee)
        expect(params.minValidatorStake).toBe(
            GENESIS.minValidatorStake,
        )
    })

    it("folds multiple upgrades in (effectiveAtBlock, proposalId) order — later wins", async () => {
        const repo = makeRepo([
            {
                proposalId: "p_A",
                effectiveAtBlock: 100,
                proposedParameters: { networkFee: 30 },
            },
            {
                proposalId: "p_B",
                effectiveAtBlock: 200,
                proposedParameters: { networkFee: 60, rpcFee: 20 },
            },
        ])
        const params = await loadNetworkParameters(repo)
        expect(params.networkFee).toBe(60)
        expect(params.rpcFee).toBe(20)
    })

    it("merges featureFlags key-by-key instead of overwriting the whole map", async () => {
        const repo = makeRepo([
            {
                proposalId: "p1",
                effectiveAtBlock: 100,
                proposedParameters: { featureFlags: { tlsn: false } },
            },
        ])
        const params = await loadNetworkParameters(repo)
        expect(params.featureFlags).toEqual({
            ...GENESIS.featureFlags,
            tlsn: false,
        })
    })

    it("falls back to genesis defaults when the DB query throws", async () => {
        const repo = {
            find: jest.fn(async () => {
                throw new Error("db down")
            }),
        } as any
        const params = await loadNetworkParameters(repo)
        expect(params).toEqual(GENESIS)
    })

    it("writes the loaded parameters into shared state", async () => {
        const repo = makeRepo([
            {
                proposalId: "p1",
                effectiveAtBlock: 100,
                proposedParameters: { minValidatorStake: "42" },
            },
        ])
        await loadNetworkParameters(repo)
        const stored = sharedStateStub.networkParameters as NetworkParameters
        expect(stored.minValidatorStake).toBe("42")
    })
})

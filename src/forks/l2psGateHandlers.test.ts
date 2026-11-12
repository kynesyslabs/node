/**
 * Under `l2psGate` every L2PS entry point answers 403 before it reads its
 * input: the client RPC routes, the node calls, the omni opcodes; and the
 * L2PS services do not start when the node becomes staked. While the gate is
 * dormant the same calls reach their own input checks.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"

const repoFor = (name: string) => ({
    target: { name },
    create: (row: unknown) => ({ ...(row as object) }),
    findOneBy: async () => null,
    findOne: async () => null,
    find: async () => [],
    save: async (row: unknown) => row,
})
const fakeDataSource = {
    getRepository: (entity: any) => repoFor(entity?.name ?? String(entity)),
}
const datasourceModule = () => ({
    __esModule: true,
    dataSource: fakeDataSource,
    default: { getInstance: async () => ({ getDataSource: () => fakeDataSource }) },
})
mock.module("src/model/datasource", datasourceModule)
mock.module("@/model/datasource", datasourceModule)

const { mainnetForks, mockChainAndLogger, restoreForkConfigAfterEach } = await import(
    "@/libs/blockchain/testSupport/forkGates"
)
mockChainAndLogger()

const { L2PS_GATE_REFUSAL } = await import("./l2psGate")
const { default: handleL2PS } = await import("@/libs/network/routines/transactions/handleL2PS")
const { handleL2PSHashUpdate } = await import("@/libs/network/endpointL2PSHash")
const { l2psHandlers } = await import("@/libs/network/handlers/l2psHandlers")
const omni = await import("@/libs/omniprotocol/protocol/handlers/l2ps")
const { decodeRpcResponse } = await import("@/libs/omniprotocol/serialization/jsonEnvelope")
const { syncL2PSServices } = await import("@/libs/l2ps/roleServices")
const { L2PSHashService } = await import("@/libs/l2ps/L2PSHashService")
const { L2PSBatchAggregator } = await import("@/libs/l2ps/L2PSBatchAggregator")
const { getSharedState } = await import("@/utilities/sharedState")

restoreForkConfigAfterEach()

const gate = (height: number | null) => mainnetForks({ l2psGate: height })
const emptyResponse = () => ({ result: 200, response: "", require_reply: false, extra: null }) as any

const omniHandlers = Object.entries(omni).filter(([name]) => name.startsWith("handleL2PS")) as [string, any][]
const callOmni = async (handler: any) => decodeRpcResponse(await handler({ message: { payload: Buffer.alloc(0) }, context: {} }))

describe("client RPC under l2psGate", () => {
    it("refuses an L2PS submission and a hash update with 403", async () => {
        gate(0)
        expect(await handleL2PS({} as any)).toMatchObject({ result: 403, extra: L2PS_GATE_REFUSAL })
        expect(await handleL2PSHashUpdate({} as any)).toMatchObject({ result: 403, extra: L2PS_GATE_REFUSAL })
    })

    it("reaches the input checks while the gate is dormant", async () => {
        gate(null)
        expect((await handleL2PS({} as any)).result).toBe(400)
        expect((await handleL2PSHashUpdate({} as any)).result).toBe(400)
    })
})

describe("node calls under l2psGate", () => {
    it("refuses every L2PS node call with 403", async () => {
        gate(0)
        expect(Object.keys(l2psHandlers).length).toBeGreaterThan(0)
        for (const [name, handler] of Object.entries(l2psHandlers)) {
            const out = await handler({}, emptyResponse(), "peer")
            expect({ name, result: out.result, response: out.response }).toEqual({
                name,
                result: 403,
                response: L2PS_GATE_REFUSAL,
            })
        }
    })

    it("passes them through while the gate is dormant", async () => {
        gate(null)
        const out = await l2psHandlers.getL2PSParticipationById({}, emptyResponse(), "peer")
        expect(out).toMatchObject({ result: 400, response: "No L2PS UID specified" })
    })
})

describe("omni opcodes under l2psGate", () => {
    it("refuses all seven L2PS opcodes with 403", async () => {
        gate(0)
        expect(omniHandlers).toHaveLength(7)
        for (const [name, handler] of omniHandlers) {
            const out = await callOmni(handler)
            expect({ name, result: out.result, response: out.response }).toEqual({
                name,
                result: 403,
                response: L2PS_GATE_REFUSAL,
            })
        }
    })

    it("reaches the payload check while the gate is dormant", async () => {
        gate(null)
        for (const [, handler] of omniHandlers) {
            expect((await callOmni(handler)).result).toBe(400)
        }
    })
})

describe("L2PS services under l2psGate", () => {
    const spies: { mockRestore(): void }[] = []
    afterEach(() => spies.splice(0).forEach(s => s.mockRestore()))
    const savedJoined = getSharedState.l2psJoinedUids
    afterEach(() => {
        getSharedState.l2psJoinedUids = savedJoined
    })

    const stubServices = () => {
        const hash = L2PSHashService.getInstance()
        const aggregator = L2PSBatchAggregator.getInstance()
        const s = {
            hashStart: spyOn(hash, "start").mockResolvedValue(undefined as any),
            hashStop: spyOn(hash, "stop").mockResolvedValue(undefined as any),
            aggStart: spyOn(aggregator, "start").mockResolvedValue(undefined as any),
            aggStop: spyOn(aggregator, "stop").mockResolvedValue(undefined as any),
        }
        spies.push(...Object.values(s))
        getSharedState.l2psJoinedUids = ["net"]
        return s
    }

    it("stops them on a staked node that joined a network", async () => {
        gate(0)
        const s = stubServices()
        await syncL2PSServices(true)
        expect(s.hashStart).not.toHaveBeenCalled()
        expect(s.aggStart).not.toHaveBeenCalled()
        expect(s.hashStop).toHaveBeenCalled()
        expect(s.aggStop).toHaveBeenCalled()
    })

    it("stops a running service on its next cycle once a later gate height is reached", async () => {
        gate(150)
        const hash = L2PSHashService.getInstance() as any
        const aggregator = L2PSBatchAggregator.getInstance() as any
        const work = {
            hash: spyOn(hash, "generateAndRelayHashes").mockResolvedValue(undefined),
            batch: spyOn(aggregator, "aggregateAndSubmitBatches").mockResolvedValue(undefined),
            cleanup: spyOn(aggregator, "cleanupOldBatchedTransactions").mockResolvedValue(undefined),
            prune: spyOn(aggregator, "pruneHistoryRetention").mockResolvedValue(undefined),
        }
        spies.push(...Object.values(work))
        hash.isRunning = true
        aggregator.isRunning = true

        await hash.safeGenerateAndRelayHashes()
        await aggregator.safeAggregateAndSubmit()
        expect(work.hash).toHaveBeenCalledTimes(1)
        expect(work.batch).toHaveBeenCalledTimes(1)

        getSharedState.lastBlockNumber = 150
        await hash.safeGenerateAndRelayHashes()
        await aggregator.safeAggregateAndSubmit()
        expect(work.hash).toHaveBeenCalledTimes(1)
        expect(work.batch).toHaveBeenCalledTimes(1)
        expect(hash.isRunning).toBe(false)
        expect(aggregator.isRunning).toBe(false)
    })

    it("starts them as before while the gate is dormant", async () => {
        gate(null)
        const s = stubServices()
        await syncL2PSServices(true)
        expect(s.hashStart).toHaveBeenCalled()
        expect(s.aggStart).toHaveBeenCalled()
    })
})

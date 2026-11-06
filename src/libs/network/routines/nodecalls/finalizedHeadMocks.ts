/**
 * What getFinalizedHead reads (the chain head, the ahead-peer veto, the
 * network clock, the sync flags), replaced for a test. Call it before
 * getFinalizedHead is imported.
 */
import { jest } from "bun:test"

export function mockFinalizedHeadReads(networkTime = 0) {
    const getLastBlock = jest.fn(async () => null as any)
    const getAheadValidatorPeers = jest.fn(async () => [] as unknown[])
    const getNetworkTimestamp = jest.fn(() => networkTime)
    const sharedState: Record<string, unknown> = { syncStatus: true, inSyncLoop: false }
    jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getLastBlock } }))
    jest.mock("src/libs/consensus/v2/routines/networkAheadVeto", () => ({ __esModule: true, getAheadValidatorPeers }))
    jest.mock("src/libs/utils/calibrateTime", () => ({ __esModule: true, getNetworkTimestamp }))
    jest.mock("src/utilities/sharedState", () => ({ __esModule: true, getSharedState: sharedState }))
    jest.mock("src/utilities/logger", () => ({
        __esModule: true,
        default: new Proxy({}, { get: () => jest.fn() }),
    }))
    return { getLastBlock, getAheadValidatorPeers, getNetworkTimestamp, sharedState }
}

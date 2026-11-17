/**
 * `tlsnotary.getInfo` tells the SDK the presentation cap the chain verifies
 * with under `tlsnVerified`, so a store over it is refused before signing.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("@/features/tlsnotary", () => ({
    __esModule: true,
    getTLSNotaryService: () => ({
        isRunning: () => true,
        getPublicKeyHex: () => "notary-key",
        getPort: () => 7047,
    }),
}))
mock.module("@/features/tlsnotary/proxyManager", () => ({
    __esModule: true,
    getPublicUrl: (port: number) => `ws://node.test:${port}`,
}))

import { cloneDefaultForkConfig } from "@/forks/forkConfig"
import { tlsnVerifiedPayload } from "@/libs/blockchain/testSupport/tlsnVerifiedFixtures"
import { getSharedState } from "@/utilities/sharedState"
import { tlsnotaryHandlers } from "./tlsnotaryHandlers"

const savedForks = getSharedState.forkConfig
const savedTip = getSharedState.lastBlockNumber

const getInfo = async () => {
    const response = { result: 200, response: null, require_reply: false, extra: null } as any
    return (await tlsnotaryHandlers["tlsnotary.getInfo"]({}, response, "")).response
}

beforeEach(() => {
    getSharedState.forkConfig = cloneDefaultForkConfig()
    getSharedState.lastBlockNumber = 100
})

afterEach(() => {
    getSharedState.forkConfig = savedForks
    getSharedState.lastBlockNumber = savedTip
})

describe("tlsnotary.getInfo", () => {
    it("carries the fork's maxPresentationBytes under tlsnVerified", async () => {
        const forks = getSharedState.forkConfig as any
        forks.tlsnVerified = {
            ...forks.tlsnVerified,
            activationHeight: 0,
            ...tlsnVerifiedPayload({ maxPresentationBytes: 32768 }),
        }

        const info = await getInfo()

        expect(info.maxPresentationBytes).toBe(32768)
        expect(info.publicKey).toBe("notary-key")
    })

    it("carries no cap before the fork", async () => {
        const info = await getInfo()

        expect(info.maxPresentationBytes).toBeUndefined()
        expect(info.notaryUrl).toBe("ws://node.test:7047")
    })
})

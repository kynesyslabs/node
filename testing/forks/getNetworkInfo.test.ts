/**
 * P3c — `getNetworkInfo` RPC handler tests.
 *
 * Contract (SPEC.md §3 P3, "Fork-status RPC"): the handler returns
 *   { forks: { osDenomination: { activationHeight, activated, currentHeight } } }
 *
 *   - `activationHeight` mirrors `SharedState.forkConfig.osDenomination.activationHeight`
 *     and is `null` when the fork is unconfigured.
 *   - `currentHeight` is the in-memory `SharedState.lastBlockNumber`.
 *   - `activated` is true iff `activationHeight !== null && currentHeight >= activationHeight`,
 *     computed via the canonical `isForkActive` gate.
 *
 * Test isolation: snapshot/restore both `forkConfig` and `lastBlockNumber`
 * around each test so state cannot bleed into other suites that share the
 * SharedState singleton (e.g. forkGates.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
// REVIEW: Import via the registry rather than directly from
// `@/libs/network/handlers/forkHandlers` to avoid an ESM circular import.
// The cycle is:
//   forkHandlers → sharedState → Peer → manageNodeCall → handlers/index
//                                                               ↑
//   ─────────────── back to forkHandlers (still mid-evaluation) ┘
// Importing the registry as the entry point lets all the leaf handler
// modules complete their evaluation before we resolve `getNetworkInfo`.
import { handlerRegistry } from "@/libs/network/handlers"
import {
    cloneDefaultForkConfig,
    type ForkConfigByName,
} from "@/forks/forkConfig"
import { getSharedState } from "@/utilities/sharedState"
import type { RPCResponse } from "@kynesyslabs/demosdk/types"

const getNetworkInfo = handlerRegistry.getNetworkInfo

// REVIEW: Fresh response object per call — same shape as `emptyResponse`
// from rpcDispatch.ts. Inlined here so the test does not import the heavy
// network module graph.
function makeResponse(): RPCResponse {
    return {
        result: 0,
        response: "",
        require_reply: false,
        extra: null,
    }
}

interface NetworkInfoResponse {
    forks: {
        osDenomination: {
            activationHeight: number | null
            activated: boolean
            currentHeight: number
        }
    }
}

describe("getNetworkInfo RPC handler", () => {
    let forkSnapshot: ForkConfigByName
    let blockNumberSnapshot: number

    beforeEach(() => {
        // Capture and reset to a clean default before each case. Other
        // suites that mutate forkConfig (e.g. forkGates.test.ts) are
        // already snapshotting in their own beforeEach/afterEach, but we
        // double-down here so this file is independently safe.
        forkSnapshot = cloneDefaultForkConfig()
        blockNumberSnapshot = getSharedState.lastBlockNumber
        getSharedState.forkConfig = cloneDefaultForkConfig()
    })

    afterEach(() => {
        getSharedState.forkConfig = forkSnapshot
        getSharedState.lastBlockNumber = blockNumberSnapshot
    })

    it("default state — activationHeight null, fork inactive", async () => {
        // Fresh defaults: activationHeight === null. currentHeight can be
        // anything; assert only that the response surfaces it faithfully.
        getSharedState.lastBlockNumber = 0

        const response = await getNetworkInfo(
            {},
            makeResponse(),
        )
        const body = response.response as NetworkInfoResponse

        expect(body.forks.osDenomination.activationHeight).toBeNull()
        expect(body.forks.osDenomination.activated).toBe(false)
        expect(body.forks.osDenomination.currentHeight).toBe(0)
    })

    it("default state — surfaces non-zero currentHeight while inactive", async () => {
        // Mid-life node, fork still unconfigured.
        getSharedState.lastBlockNumber = 12_345

        const response = await getNetworkInfo(
            {},
            makeResponse(),
        )
        const body = response.response as NetworkInfoResponse

        expect(body.forks.osDenomination.activationHeight).toBeNull()
        expect(body.forks.osDenomination.activated).toBe(false)
        expect(body.forks.osDenomination.currentHeight).toBe(12_345)
    })

    it("fork configured but not yet active (currentHeight < activationHeight)", async () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 1000
        getSharedState.lastBlockNumber = 500

        const response = await getNetworkInfo(
            {},
            makeResponse(),
        )
        const body = response.response as NetworkInfoResponse

        expect(body.forks.osDenomination.activationHeight).toBe(1000)
        expect(body.forks.osDenomination.activated).toBe(false)
        expect(body.forks.osDenomination.currentHeight).toBe(500)
    })

    it("fork active at the boundary (currentHeight === activationHeight)", async () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 1000
        getSharedState.lastBlockNumber = 1000

        const response = await getNetworkInfo(
            {},
            makeResponse(),
        )
        const body = response.response as NetworkInfoResponse

        expect(body.forks.osDenomination.activationHeight).toBe(1000)
        expect(body.forks.osDenomination.activated).toBe(true)
        expect(body.forks.osDenomination.currentHeight).toBe(1000)
    })

    it("fork active, well past activation height", async () => {
        getSharedState.forkConfig.osDenomination.activationHeight = 1000
        getSharedState.lastBlockNumber = 5000

        const response = await getNetworkInfo(
            {},
            makeResponse(),
        )
        const body = response.response as NetworkInfoResponse

        expect(body.forks.osDenomination.activationHeight).toBe(1000)
        expect(body.forks.osDenomination.activated).toBe(true)
        expect(body.forks.osDenomination.currentHeight).toBe(5000)
    })

    it("ignores extras on the request payload", async () => {
        // Forward-compat: clients shipping extra fields must not break the
        // handler. The contract is "no arguments"; any data is discarded.
        getSharedState.forkConfig.osDenomination.activationHeight = 1000
        getSharedState.lastBlockNumber = 1500

        const response = await getNetworkInfo(
            { unexpectedField: "bogus", more: { nested: true } },
            makeResponse(),
        )
        const body = response.response as NetworkInfoResponse

        expect(body.forks.osDenomination.activationHeight).toBe(1000)
        expect(body.forks.osDenomination.activated).toBe(true)
        expect(body.forks.osDenomination.currentHeight).toBe(1500)
    })

    it("does not mutate the response status fields when successful", async () => {
        // Sanity-check: handler should leave result/require_reply/extra
        // untouched on the happy path (matches the convention of
        // miscHandlers.hots / blockHandlers.getLastBlockNumber).
        getSharedState.lastBlockNumber = 42

        const baseline = makeResponse()
        const response = await getNetworkInfo({}, baseline)

        expect(response.result).toBe(0)
        expect(response.require_reply).toBe(false)
        expect(response.extra).toBeNull()
    })
})

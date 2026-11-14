/**
 * The block a transaction admitted now is queued for. broadcastTx judges the
 * reference block against the window of this block, so it follows the
 * mempool's own choice: during a consensus round, the block after the one
 * being forged.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { getSharedState } from "@/utilities/sharedState"

import { installPoolStorageMocks } from "./mempool.fixtures"

installPoolStorageMocks()

import SecretaryManager from "src/libs/consensus/v2/types/secretaryManager"
import Mempool from "./mempool"

const HEAD = 100
const saved = {
    lastBlockNumber: getSharedState.lastBlockNumber,
    inConsensusLoop: getSharedState.inConsensusLoop,
    lastBlockRef: SecretaryManager.lastBlockRef,
}

function at(head: number, forging: number | null): void {
    getSharedState.lastBlockNumber = head
    getSharedState.inConsensusLoop = forging !== null
    ;(SecretaryManager as any).lastBlockRef = forging ?? head
}

afterEach(() => {
    getSharedState.lastBlockNumber = saved.lastBlockNumber
    getSharedState.inConsensusLoop = saved.inConsensusLoop
    ;(SecretaryManager as any).lastBlockRef = saved.lastBlockRef
})

describe("Mempool.nextBlockRef", () => {
    it("queues for the block after the head when no round runs", () => {
        at(HEAD, null)
        expect(Mempool.nextBlockRef()).toBe(HEAD + 1)
    })

    it("queues for the block after the one a running round forges", () => {
        at(HEAD, HEAD + 1)
        expect(Mempool.nextBlockRef()).toBe(HEAD + 2)
    })
})

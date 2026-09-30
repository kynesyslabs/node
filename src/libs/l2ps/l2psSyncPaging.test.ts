/**
 * How far one sync run follows a peer's pages.
 *
 * The peer decides what "more" means, so the node has to bound the run
 * itself: it continues only while the peer's cursor moves, and never past a
 * fixed number of pages.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"

const addTransaction = jest.fn(async () => ({ success: true }))

jest.mock("@/libs/blockchain/l2ps_mempool", () => ({
    __esModule: true,
    default: { addTransaction },
}))

jest.mock("@/libs/peer", () => ({ Peer: class {} }))

jest.mock("@/utilities/sharedState", () => ({ getSharedState: {} }))

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        only: jest.fn(),
    },
}))

import {
    clearL2PSSyncCursors,
    MAX_SYNC_CONTINUATIONS,
    MAX_SYNC_PAGES_PER_RUN,
    SYNC_PAGE_LIMIT,
    setL2PSSyncContinueDelay,
    syncL2PSWithPeer,
} from "./L2PSConcurrentSync"

type Page = { transactions: unknown[]; nextCursor?: number; hasMore?: boolean }

function peerServing(pageFor: (cursor: number) => Page) {
    const cursors: number[] = []
    const peer = {
        identity: "peer-1",
        call: jest.fn(async (request: any) => {
            const cursor = request.params[0].data.cursor
            cursors.push(cursor)
            return { result: 200, response: pageFor(cursor) }
        }),
    }
    return { peer: peer as never, cursors }
}

const tx = (n: number) => ({
    original_hash: `orig-${n}`,
    encrypted_tx: { hash: `enc-${n}`, content: { data: [] } },
})

beforeEach(() => {
    clearL2PSSyncCursors()
    addTransaction.mockClear()
    // Far enough out that a continuation never fires inside a case that
    // does not wait for it.
    setL2PSSyncContinueDelay(60_000)
})

describe("syncL2PSWithPeer", () => {
    it("follows the peer's cursor until it says there is no more", async () => {
        const { peer, cursors } = peerServing(cursor =>
            cursor < 3
                ? { transactions: [tx(cursor + 1)], nextCursor: cursor + 1, hasMore: true }
                : { transactions: [], nextCursor: 3, hasMore: false },
        )

        await syncL2PSWithPeer(peer, "subnet-1")

        expect(cursors).toEqual([0, 1, 2, 3])
        expect(addTransaction).toHaveBeenCalledTimes(3)
    })

    it("stops when the peer claims more but its cursor does not move", async () => {
        const { peer, cursors } = peerServing(() => ({
            transactions: [tx(1)],
            nextCursor: 0,
            hasMore: true,
        }))

        await syncL2PSWithPeer(peer, "subnet-1")

        expect(cursors).toEqual([0])
    })

    it("stops when the peer claims more and sends no cursor", async () => {
        const { peer, cursors } = peerServing(() => ({ transactions: [tx(1)], hasMore: true }))

        await syncL2PSWithPeer(peer, "subnet-1")

        expect(cursors).toEqual([0])
    })

    it("carries on by itself after the cap until the backlog is drained", async () => {
        setL2PSSyncContinueDelay(1)
        const total = MAX_SYNC_PAGES_PER_RUN * 2 + 5
        const { peer, cursors } = peerServing(cursor => ({
            transactions: [tx(cursor + 1)],
            nextCursor: cursor + 1,
            hasMore: cursor + 1 < total,
        }))

        await syncL2PSWithPeer(peer, "subnet-1")
        expect(cursors).toHaveLength(MAX_SYNC_PAGES_PER_RUN)

        for (let i = 0; i < 200 && addTransaction.mock.calls.length < total; i++) {
            await new Promise(r => setTimeout(r, 5))
        }
        expect(addTransaction).toHaveBeenCalledTimes(total)
        expect(new Set(cursors).size).toBe(cursors.length)
    })

    it("does not start a second run for a peer while one is in progress", async () => {
        let release!: () => void
        const gate = new Promise<void>(r => (release = r))
        const peer = {
            identity: "peer-1",
            call: jest.fn(async () => {
                await gate
                return { result: 200, response: { transactions: [], nextCursor: 0, hasMore: false } }
            }),
        }
        const first = syncL2PSWithPeer(peer as never, "subnet-1")
        await syncL2PSWithPeer(peer as never, "subnet-1")
        release()
        await first
        expect(peer.call).toHaveBeenCalledTimes(1)
    })

    it("pulls at most a bounded number of pages per run, and resumes where it stopped", async () => {
        const { peer, cursors } = peerServing(cursor => ({
            transactions: [tx(cursor + 1)],
            nextCursor: cursor + 1,
            hasMore: true,
        }))

        await syncL2PSWithPeer(peer, "subnet-1")
        expect(cursors).toHaveLength(MAX_SYNC_PAGES_PER_RUN)

        await syncL2PSWithPeer(peer, "subnet-1")
        expect(cursors[MAX_SYNC_PAGES_PER_RUN]).toBe(MAX_SYNC_PAGES_PER_RUN)
    })

    it("moves past a page of rows the peer could not serve", async () => {
        const { peer, cursors } = peerServing(cursor =>
            cursor === 0
                ? { transactions: [], nextCursor: 5, hasMore: true }
                : { transactions: [tx(6)], nextCursor: 6, hasMore: false },
        )

        await syncL2PSWithPeer(peer, "subnet-1")

        expect(cursors).toEqual([0, 5])
        expect(addTransaction).toHaveBeenCalledTimes(1)
    })

    it("asks for a bounded page and stores no more than that of the answer", async () => {
        const { peer } = peerServing(() => ({
            transactions: Array.from({ length: SYNC_PAGE_LIMIT * 3 }, (_, i) => tx(i + 1)),
            nextCursor: SYNC_PAGE_LIMIT * 3,
            hasMore: false,
        }))

        await syncL2PSWithPeer(peer, "subnet-1")

        const request = (peer as any).call.mock.calls[0][0]
        expect(request.params[0].data.limit).toBe(SYNC_PAGE_LIMIT)
        expect(addTransaction).toHaveBeenCalledTimes(SYNC_PAGE_LIMIT)
    })

    it("stops scheduling its own runs against a peer that never runs out", async () => {
        // A peer answering "more" with a rising cursor for ever would keep
        // this node pulling and storing its pages without end.
        setL2PSSyncContinueDelay(1)
        const { peer, cursors } = peerServing(cursor => ({
            transactions: [tx(cursor + 1)],
            nextCursor: cursor + 1,
            hasMore: true,
        }))
        const bound = MAX_SYNC_PAGES_PER_RUN * (MAX_SYNC_CONTINUATIONS + 1)

        await syncL2PSWithPeer(peer, "subnet-1")
        for (let i = 0; i < 400 && cursors.length < bound; i++) {
            await new Promise(r => setTimeout(r, 5))
        }
        await new Promise(r => setTimeout(r, 100))
        expect(cursors).toHaveLength(bound)

        // The regular triggers still get their run, but it does not restart
        // the self-scheduled chain.
        await syncL2PSWithPeer(peer, "subnet-1")
        await new Promise(r => setTimeout(r, 100))
        expect(cursors).toHaveLength(bound + MAX_SYNC_PAGES_PER_RUN)
    })
})

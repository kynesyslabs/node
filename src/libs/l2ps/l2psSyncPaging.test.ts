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
    MAX_SYNC_PAGES_PER_RUN,
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
})

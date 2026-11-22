import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { ValidityData } from "@kynesyslabs/demosdk/types"
import { mockCore } from "src/utilities/testSupport/coreMocks"

// The sidecar publishes to a topic even with no peer on it, and the heights
// subscribers that make the sidecar ready say nothing about the tx topic. A
// tx publish that reaches no tx-topic peer must count as not published, so
// the client is told so and the tx is held for the retry on the heights tick.

const state = { publicKeyHex: "00", exposedUrl: "", lastBlockNumber: 100 }
mockCore(state)
const stakedSet = await import("src/libs/consensus/stakedSet")
mock.module("src/libs/consensus/stakedSet", () => ({
    ...stakedSet,
    isSelfStaked: async () => true,
}))
const editBinding = await import("src/libs/blockchain/validation/editBinding")
mock.module("src/libs/blockchain/validation/editBinding", () => ({
    ...editBinding,
    verifyRpcEdits: async () => ({ ok: true }),
}))
const estimate = await import("src/libs/consensus/confirmationEstimate")
mock.module("src/libs/consensus/confirmationEstimate", () => ({
    ...estimate,
    estimateNextConfirmationBlock: async () => 101,
}))

const { default: GossipManager } = await import("./GossipManager")
const { BLOCKS_TOPIC, HEIGHTS_TOPIC, TXS_TOPIC } = await import("./topics")
const { default: Mempool } = await import("src/libs/blockchain/mempool")
const { default: Chain } = await import("src/libs/blockchain/chain")
const { default: log } = await import("src/utilities/logger")
const { __resetUnpublished, retryUnpublishedTxs, submitValidatedTx, unpublishedCount } =
    await import("src/libs/network/txSubmission")

const proto = GossipManager.prototype as any

/** A started, staked manager whose sidecar sees one heights and one blocks peer. */
function fakeManager(txSubscribers: number) {
    const sent: { topic: string }[] = []
    const topic = (subscribers: number) => ({ subscribers, mesh: subscribers })
    const self = {
        started: true,
        restarting: false,
        readyInfo: { peerId: "peer", addrs: [] },
        lastStatsAt: Date.now(),
        lastStats: {
            connections: 1,
            perTopic: {
                [HEIGHTS_TOPIC]: topic(1),
                [BLOCKS_TOPIC]: topic(1),
                [TXS_TOPIC]: topic(txSubscribers),
            },
        },
        lastSkipLog: new Map<string, number>(),
        sidecarUp: proto.sidecarUp,
        mayPublish: proto.mayPublish,
        logPublishSkipped: proto.logPublishSkipped,
        publishTx: proto.publishTx,
        send: (msg: { topic: string }) => sent.push(msg),
    }
    const setTxSubscribers = (n: number) => {
        self.lastStats.perTopic[TXS_TOPIC] = topic(n)
    }
    return { self, sent, setTxSubscribers }
}

function envelope(hash: string): ValidityData {
    return {
        data: {
            transaction: { hash, content: { type: "native", reference_block: 100 } },
            reference_block: 100,
        },
    } as unknown as ValidityData
}

const sentTo = (sent: { topic: string }[], topic: string) =>
    sent.filter(m => m.topic === topic).length

const spies: { mockRestore: () => void }[] = []

/**
 * Routes submitValidatedTx to `self`, backs the mempool with `pool` and the
 * chain with `chain`. A hash in `poolDown` or `chainDown` makes that lookup
 * throw, as on a database blip.
 */
function wireSubmission(
    self: object,
    pool: Set<string>,
    {
        chain = new Set<string>(),
        poolDown = new Set<string>(),
        chainDown = new Set<string>(),
    } = {},
) {
    const lookup = (set: Set<string>, down: Set<string>) => async (hash: string) => {
        if (down.has(hash)) throw new Error("connection reset")
        return set.has(hash)
    }
    spies.push(
        spyOn(GossipManager, "isEnabled").mockReturnValue(true),
        spyOn(GossipManager, "getInstance").mockReturnValue(self as any),
        spyOn(Mempool, "addTransactionWithLock").mockImplementation(async tx => {
            pool.add(tx.hash)
            return {} as any
        }),
        spyOn(Mempool, "checkTransactionByHash").mockImplementation(
            lookup(pool, poolDown),
        ),
        spyOn(Chain, "checkTxExists").mockImplementation(lookup(chain, chainDown)),
    )
}

afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
    __resetUnpublished()
    state.lastBlockNumber = 100
})

describe("tx publishing and tx-topic peers", () => {
    it("does not publish a tx when no peer is subscribed to the tx topic", async () => {
        const { self, sent } = fakeManager(0)
        expect(await proto.publishTx.call(self, envelope("0xaa"))).toBe(false)
        expect(sentTo(sent, TXS_TOPIC)).toBe(0)
    })

    it("publishes a tx once a peer is subscribed to the tx topic", async () => {
        const { self, sent } = fakeManager(1)
        expect(await proto.publishTx.call(self, envelope("0xaa"))).toBe(true)
        expect(sentTo(sent, TXS_TOPIC)).toBe(1)
    })

    it("still publishes blocks with no tx-topic peer", async () => {
        const { self, sent } = fakeManager(0)
        const block = { number: 1, hash: "0xb1" }
        expect(await proto.publishBlock.call(self, block)).toBe(true)
        expect(sentTo(sent, BLOCKS_TOPIC)).toBe(1)
    })

    it("tells the client the tx is not published, holds it, and publishes it once a peer subscribes", async () => {
        const { self, sent, setTxSubscribers } = fakeManager(0)
        wireSubmission(self, new Set())

        const validity = envelope("0xcc")
        const out = await submitValidatedTx(validity)
        expect(out).toMatchObject({ ok: true, published: false })
        expect(unpublishedCount()).toBe(1)
        expect(sentTo(sent, TXS_TOPIC)).toBe(0)

        await retryUnpublishedTxs()
        expect(unpublishedCount()).toBe(1)

        setTxSubscribers(1)
        await retryUnpublishedTxs()
        expect(unpublishedCount()).toBe(0)
        expect(sentTo(sent, TXS_TOPIC)).toBe(1)
    })

    // A lone staked validator with unstaked followers: no tx-topic peer
    // ever appears, and the validator includes the tx from its own pool.
    it("stops holding a tx once a block includes it, without a warning", async () => {
        const { self, sent, setTxSubscribers } = fakeManager(0)
        const pool = new Set<string>()
        const chain = new Set<string>()
        wireSubmission(self, pool, { chain })
        const warning = spyOn(log, "warning")
        spies.push(warning)

        expect(await submitValidatedTx(envelope("0xdd"))).toMatchObject({
            ok: true,
            published: false,
        })
        expect(unpublishedCount()).toBe(1)

        pool.delete("0xdd") // a block included it
        chain.add("0xdd")
        warning.mockClear()
        await retryUnpublishedTxs()
        expect(unpublishedCount()).toBe(0)

        // Later the reference block leaves the window, and a peer appears.
        state.lastBlockNumber = 1_000
        setTxSubscribers(1)
        await retryUnpublishedTxs()
        expect(warning).not.toHaveBeenCalled()
        expect(sentTo(sent, TXS_TOPIC)).toBe(0)
    })

    // The pool aged it out or evicted it: the client was told success and
    // no other node has the tx, so the operator must hear about it.
    it("warns when a held tx leaves our mempool without reaching the chain", async () => {
        const { self, sent } = fakeManager(0)
        const pool = new Set<string>()
        wireSubmission(self, pool)
        const warning = spyOn(log, "warning")
        spies.push(warning)

        await submitValidatedTx(envelope("0xde"))
        expect(unpublishedCount()).toBe(1)

        pool.delete("0xde")
        warning.mockClear()
        await retryUnpublishedTxs()
        expect(unpublishedCount()).toBe(0)
        expect(warning).toHaveBeenCalledWith(
            "[TX SUBMIT] 0xde left our mempool without reaching the chain (expired, evicted or failed); no longer held",
        )
        expect(sentTo(sent, TXS_TOPIC)).toBe(0)
    })

    it("still offers every held tx when a pool or chain lookup fails", async () => {
        const { self, sent, setTxSubscribers } = fakeManager(0)
        const pool = new Set<string>()
        const poolDown = new Set<string>()
        const chainDown = new Set<string>()
        wireSubmission(self, pool, { poolDown, chainDown })
        for (const hash of ["0xe1", "0xe2", "0xe3"]) {
            await submitValidatedTx(envelope(hash))
        }
        expect(unpublishedCount()).toBe(3)

        poolDown.add("0xe1") // the mempool lookup throws
        pool.delete("0xe2")
        chainDown.add("0xe2") // the chain lookup throws
        setTxSubscribers(1)
        await retryUnpublishedTxs()
        expect(unpublishedCount()).toBe(0)
        expect(sentTo(sent, TXS_TOPIC)).toBe(3)
    })
})

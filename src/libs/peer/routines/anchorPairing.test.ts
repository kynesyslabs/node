/**
 * An anchor that does not answer must not stop the boot; one that answers and
 * refuses must. Anchors left behind at boot get the same checks once they
 * answer.
 */

import { beforeEach, describe, expect, it, jest, mock } from "bun:test"

mock.module("src/utilities/logger", () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    },
}))

const {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    AnchorRefusal,
    BOOT_RETRY_DELAYS_MS,
    DEFERRED_FIRST_DELAY_MS,
    DEFERRED_MAX_DELAY_MS,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    DeferredAnchorChecks,
    pairAnchorsAtBoot,
    pairWithAnchor,
} = await import("./anchorPairing")
const peerModule = await import("../Peer")
// eslint-disable-next-line @typescript-eslint/naming-convention
const Peer = peerModule.default
type HelloVerdict = import("../PeerManager").HelloVerdict
type PeerT = InstanceType<typeof Peer>

const CHAIN = "0xchain"
const anchor = (n: number) => new Peer(`http://node-${n}:53550`, `0xanchor${n}`)

/** A network where each anchor answers with the verdicts queued for it, then repeats the last one. */
function network(script: Record<string, HelloVerdict[]>) {
    const paired = new Set<string>()
    const sleeps: number[] = []
    let clock = 0
    const sayHello = jest.fn(async (peer: PeerT): Promise<HelloVerdict> => {
        const queue = script[peer.identity] ?? ["unreachable"]
        const verdict = queue.length > 1 ? (queue.shift() as HelloVerdict) : queue[0]
        if (verdict === "verified") paired.add(peer.identity)
        return verdict
    })
    return {
        paired,
        sleeps,
        advance: (ms: number) => {
            clock += ms
        },
        deps: {
            sayHello,
            isPaired: (identity: string) => paired.has(identity),
            sleep: async (ms: number) => {
                sleeps.push(ms)
            },
            now: () => clock,
        },
    }
}

describe("pairWithAnchor at boot", () => {
    it("leaves an anchor that never answers behind instead of failing", async () => {
        const net = network({})
        const outcome = await pairWithAnchor(anchor(1), net.deps, CHAIN)
        expect(outcome).toBe("unreachable")
        expect(net.deps.sayHello).toHaveBeenCalledTimes(BOOT_RETRY_DELAYS_MS.length + 1)
        expect(net.sleeps).toEqual(BOOT_RETRY_DELAYS_MS)
    })

    it("pairs with an anchor that is still booting when it first answers", async () => {
        const net = network({ "0xanchor1": ["unreachable", "unreachable", "verified"] })
        expect(await pairWithAnchor(anchor(1), net.deps, CHAIN)).toBe("paired")
        expect(net.deps.sayHello).toHaveBeenCalledTimes(3)
    })

    it("treats a hello already in flight as not answered yet", async () => {
        const net = network({ "0xanchor1": ["skipped", "verified"] })
        expect(await pairWithAnchor(anchor(1), net.deps, CHAIN)).toBe("paired")
    })

    for (const [verdict, text] of [
        ["unsigned", "without a signed hello"],
        ["invalid", "failed identity verification"],
        ["other-genesis", "runs another chain"],
    ] as const) {
        it(`refuses at once on ${verdict}`, async () => {
            const net = network({ "0xanchor1": [verdict] })
            const attempt = pairWithAnchor(anchor(1), net.deps, CHAIN)
            await expect(attempt).rejects.toBeInstanceOf(AnchorRefusal)
            await expect(pairWithAnchor(anchor(1), net.deps, CHAIN)).rejects.toThrow(text)
            expect(net.sleeps).toEqual([])
        })
    }

    it("refuses an anchor that answers signed but never joins the table", async () => {
        const net = network({ "0xanchor1": ["verified"] })
        net.deps.isPaired = () => false
        await expect(pairWithAnchor(anchor(1), net.deps, CHAIN)).rejects.toThrow(
            "Failed to pair with anchor peer",
        )
    })

    it("refuses when an anchor that did not answer later answers with a refusal", async () => {
        const net = network({ "0xanchor1": ["unreachable", "other-genesis"] })
        await expect(pairWithAnchor(anchor(1), net.deps, CHAIN)).rejects.toBeInstanceOf(
            AnchorRefusal,
        )
    })
})

describe("pairAnchorsAtBoot", () => {
    it("boots with every anchor down", async () => {
        const net = network({})
        const { paired, unreachable } = await pairAnchorsAtBoot(
            [anchor(1), anchor(2), anchor(3)],
            net.deps,
            CHAIN,
        )
        expect(paired).toEqual([])
        expect(unreachable.map(p => p.identity)).toEqual(["0xanchor1", "0xanchor2", "0xanchor3"])
    })

    it("splits answering and silent anchors", async () => {
        const net = network({ "0xanchor2": ["verified"] })
        const { paired, unreachable } = await pairAnchorsAtBoot(
            [anchor(1), anchor(2), anchor(3)],
            net.deps,
            CHAIN,
        )
        expect(paired.map(p => p.identity)).toEqual(["0xanchor2"])
        expect(unreachable.map(p => p.identity)).toEqual(["0xanchor1", "0xanchor3"])
    })

    it("stops the boot when any answering anchor refuses, even with another one down", async () => {
        const net = network({ "0xanchor2": ["invalid"], "0xanchor3": ["verified"] })
        await expect(
            pairAnchorsAtBoot([anchor(1), anchor(2), anchor(3)], net.deps, CHAIN),
        ).rejects.toThrow("failed identity verification")
    })

    it("tries the anchors at the same time, so boot waits for one retry window", async () => {
        let inFlight = 0
        let maxInFlight = 0
        const deps = {
            sayHello: async () => {
                inFlight++
                maxInFlight = Math.max(maxInFlight, inFlight)
                await new Promise(r => setTimeout(r, 1))
                inFlight--
                return "unreachable" as HelloVerdict
            },
            isPaired: () => false,
            sleep: async () => {},
        }
        await pairAnchorsAtBoot([anchor(1), anchor(2), anchor(3)], deps, CHAIN)
        expect(maxInFlight).toBe(3)
    })
})

describe("DeferredAnchorChecks", () => {
    let confirm: ReturnType<typeof jest.fn>
    let refusals: { identity: string; message: string; fatal: boolean }[]

    beforeEach(() => {
        confirm = jest.fn(async () => {})
        refusals = []
    })

    function checks(net: ReturnType<typeof network>, anchors: PeerT[], confirmed: boolean) {
        return new DeferredAnchorChecks(
            anchors,
            {
                ...net.deps,
                confirm,
                onRefusal: (peer, refusal, fatal) =>
                    refusals.push({ identity: peer.identity, message: refusal.message, fatal }),
            },
            CHAIN,
            confirmed,
        )
    }

    it("runs the bootstrap genesis checks on an anchor once it comes up", async () => {
        const net = network({ "0xanchor1": ["unreachable", "verified"] })
        const deferred = checks(net, [anchor(1)], false)

        net.advance(DEFERRED_FIRST_DELAY_MS)
        await deferred.tick()
        expect(confirm).not.toHaveBeenCalled()
        expect(deferred.pendingIdentities).toEqual(["0xanchor1"])

        net.advance(DEFERRED_MAX_DELAY_MS)
        await deferred.tick()
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(deferred.pendingIdentities).toEqual([])
        expect(deferred.isConfirmed).toBe(true)
        expect(refusals).toEqual([])
    })

    it("does not wait out the backoff once the anchor has paired by its own hello", async () => {
        const net = network({ "0xanchor1": ["verified"] })
        const deferred = checks(net, [anchor(1)], true)
        await deferred.tick()
        expect(net.deps.sayHello).not.toHaveBeenCalled()

        net.paired.add("0xanchor1")
        await deferred.tick()
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(deferred.pendingIdentities).toEqual([])
    })

    it("backs off up to the cap while an anchor stays down", async () => {
        const net = network({})
        const deferred = checks(net, [anchor(1)], true)
        let calls = 0
        for (let i = 0; i < 12; i++) {
            net.advance(DEFERRED_MAX_DELAY_MS)
            await deferred.tick()
            calls++
            expect(net.deps.sayHello).toHaveBeenCalledTimes(calls)
        }
        net.advance(DEFERRED_MAX_DELAY_MS - 1)
        await deferred.tick()
        expect(net.deps.sayHello).toHaveBeenCalledTimes(calls)
    })

    it("stops the node when the first anchor to answer refuses it", async () => {
        const net = network({ "0xanchor1": ["other-genesis"], "0xanchor2": ["verified"] })
        const deferred = checks(net, [anchor(1), anchor(2)], false)
        net.advance(DEFERRED_FIRST_DELAY_MS)
        await deferred.run()
        expect(refusals).toEqual([
            { identity: "0xanchor1", message: expect.stringContaining("runs another chain"), fatal: true },
        ])
        // Nothing else is checked once the node is stopping.
        expect(confirm).not.toHaveBeenCalled()
    })

    it("stops the node when the genesis checks refuse and nothing confirmed it", async () => {
        const net = network({ "0xanchor1": ["verified"] })
        confirm.mockImplementation(async () => {
            throw new AnchorRefusal("Genesis data match failed for peer http://node-1:53550: mismatch")
        })
        const deferred = checks(net, [anchor(1)], false)
        net.advance(DEFERRED_FIRST_DELAY_MS)
        await deferred.tick()
        expect(refusals).toEqual([
            { identity: "0xanchor1", message: expect.stringContaining("Genesis data match failed"), fatal: true },
        ])
    })

    it("drops a refusing anchor without stopping a node another anchor confirmed", async () => {
        const net = network({ "0xanchor1": ["invalid"], "0xanchor2": ["verified"] })
        const deferred = checks(net, [anchor(1), anchor(2)], true)
        net.advance(DEFERRED_FIRST_DELAY_MS)
        await deferred.tick()
        expect(refusals).toEqual([
            { identity: "0xanchor1", message: expect.stringContaining("identity verification"), fatal: false },
        ])
        expect(confirm).toHaveBeenCalledTimes(1)
        expect(deferred.pendingIdentities).toEqual([])
    })

    it("counts an anchor that came up later as confirming the node", async () => {
        const net = network({ "0xanchor1": ["verified"], "0xanchor2": ["unreachable", "invalid"] })
        const deferred = checks(net, [anchor(1), anchor(2)], false)
        net.advance(DEFERRED_FIRST_DELAY_MS)
        await deferred.tick()
        net.advance(DEFERRED_MAX_DELAY_MS)
        await deferred.tick()
        expect(refusals).toEqual([
            { identity: "0xanchor2", message: expect.stringContaining("identity verification"), fatal: false },
        ])
    })

    it("retries instead of refusing when a check fails for another reason", async () => {
        const net = network({ "0xanchor1": ["verified"] })
        confirm.mockImplementationOnce(async () => {
            throw new Error("socket hang up")
        })
        const deferred = checks(net, [anchor(1)], false)
        net.advance(DEFERRED_FIRST_DELAY_MS)
        await deferred.tick()
        expect(refusals).toEqual([])
        expect(deferred.pendingIdentities).toEqual(["0xanchor1"])
        net.advance(DEFERRED_MAX_DELAY_MS)
        await deferred.tick()
        expect(deferred.pendingIdentities).toEqual([])
    })

    it("ends its loop once every anchor is settled", async () => {
        const net = network({ "0xanchor1": ["verified"] })
        net.deps.sleep = async (ms: number) => {
            net.advance(ms)
        }
        const deferred = checks(net, [anchor(1)], true)
        await deferred.run()
        expect(deferred.pendingIdentities).toEqual([])
    })
})

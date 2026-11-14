import { afterEach, describe, expect, it, mock } from "bun:test"
import { mockCore } from "src/utilities/testSupport/coreMocks"

// Peers send a key's consensus calls to the URL in its latest heights
// record, so a copy of the key that stopped signing must not publish one.

mockCore({ publicKeyHex: "00", exposedUrl: "" })
const records = await import("./records")
let buildGate: Promise<void> | null = null
let buildStarted: (() => void) | null = null
mock.module("./records", () => ({
    ...records,
    buildHeightsRecord: async () => {
        buildStarted?.()
        if (buildGate) await buildGate
        return { height: 1, seq: 1 }
    },
}))

const { default: GossipManager } = await import("./GossipManager")
const { haltSigning, __resetSigningHalt } = await import(
    "src/libs/identity/signingRecord"
)

function fakeManager() {
    const sent: { topic: string }[] = []
    const self = {
        mayPublish: async () => true,
        logPublishSkipped: () => undefined,
        getListenAddr: () => null,
        getPeerId: () => "peer",
        readyInfo: { addrs: [] },
        lastStats: null,
        send: (msg: { topic: string }) => sent.push(msg),
    }
    const publish = () =>
        (GossipManager.prototype as any).publishOwnHeights.call(self)
    return { sent, publish }
}

afterEach(() => {
    buildGate = null
    buildStarted = null
    __resetSigningHalt()
})

describe("heights publishing", () => {
    it("publishes while the node signs", async () => {
        const { sent, publish } = fakeManager()
        expect(await publish()).toBe(true)
        expect(sent).toHaveLength(1)
    })

    it("stops once signing is stopped for a second copy of the key", async () => {
        const { sent, publish } = fakeManager()
        haltSigning("test: another process signs with this key")
        expect(await publish()).toBe(false)
        expect(sent).toHaveLength(0)
    })

    it("drops a record whose build was pending when signing stopped", async () => {
        const { sent, publish } = fakeManager()
        let finishBuild!: () => void
        buildGate = new Promise<void>(resolve => {
            finishBuild = resolve
        })
        const started = new Promise<void>(resolve => {
            buildStarted = resolve
        })
        const published = publish()
        await started
        haltSigning("test: a received block shows another copy signing")
        finishBuild()
        expect(await published).toBe(false)
        expect(sent).toHaveLength(0)
    })
})

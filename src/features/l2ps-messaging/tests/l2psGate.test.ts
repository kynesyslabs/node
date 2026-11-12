/**
 * The messaging relay under an `l2psGate` scheduled above the height the
 * server started at: once the tip reaches the gate, every frame is refused,
 * so a connected peer can no longer queue L2PS traffic the pool would refuse.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import {
    Client,
    encrypted,
    identity,
    proofFor,
    register,
    resetRelay,
    rows,
    sendAndWait,
    sharedState,
    startRelayServer,
    stopRelayServer,
    submitToL2PS,
} from "./relayHarness"

const { L2PS_GATE_REFUSAL } = await import("@/forks/l2psGate")

const GATE_HEIGHT = 50
const clients: Client[] = []

beforeAll(() => {
    sharedState.forkConfig = { l2psGate: { activationHeight: GATE_HEIGHT } }
    startRelayServer()
})
afterAll(() => {
    clients.splice(0).forEach(c => c.close())
    stopRelayServer()
    delete sharedState.forkConfig
    delete sharedState.lastBlockNumber
})
beforeEach(() => {
    resetRelay()
    sharedState.lastBlockNumber = 10
})

describe("messaging relay when l2psGate activates after startup", () => {
    it("relays below the gate height and refuses a registered peer's send once the tip reaches it", async () => {
        const alice = identity()
        const bob = identity()
        const a = await register(alice)
        const b = await register(bob)
        clients.push(a.client, b.client)
        expect(a.reply.type).toBe("registered")
        expect(b.reply.type).toBe("registered")

        expect((await sendAndWait(a.client, bob, "before")).type).toBe("message_sent")
        expect(submitToL2PS).toHaveBeenCalledTimes(1)

        sharedState.lastBlockNumber = GATE_HEIGHT
        a.client.frame("send", { to: bob.publicKey, encrypted, messageHash: "after" }, Date.now(), "after")
        const refused = await a.client.next("message_sent")

        expect(refused.type).toBe("error")
        expect(refused.payload).toMatchObject({ code: "L2PS_DISABLED", message: L2PS_GATE_REFUSAL })
        expect(refused.requestId).toBe("after")
        expect(submitToL2PS).toHaveBeenCalledTimes(1)
        expect(rows.size).toBe(1)
    })

    it("refuses a new registration once the gate is active", async () => {
        sharedState.lastBlockNumber = GATE_HEIGHT + 1
        const id = identity()
        const timestamp = Date.now()
        const c = await Client.open()
        clients.push(c)
        c.frame("register", { publicKey: id.publicKey, l2psUid: "subnet_a", proof: proofFor(id, timestamp) }, timestamp, "reg")
        const refused = await c.next("registered")

        expect(refused.type).toBe("error")
        expect(refused.payload.code).toBe("L2PS_DISABLED")
        expect(refused.requestId).toBe("reg")
    })
})

/**
 * The dry-run admission a cross-chain, DemosWork or web2 broadcast runs
 * before its outbound calls, and the per-hash claim that keeps a re-broadcast
 * from running a tx's outbound operations twice.
 */

import { beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test"

const onChain = new Set<string>()
const inMempool = new Set<string>()
let readFails = false
let gossipOn = true
let editsVerdict: { ok: boolean; reason?: string } = { ok: true }
let typeRefusal: string | null = null
let sizeRefusal: string | null = null

const editBinding = await import("src/libs/blockchain/validation/editBinding")
mock.module("src/libs/blockchain/validation/editBinding", () => ({
    ...editBinding,
    verifyRpcEdits: async () => editsVerdict,
}))
const txTypes = await import("src/libs/blockchain/validation/txTypes")
mock.module("src/libs/blockchain/validation/txTypes", () => ({
    ...txTypes,
    clientTxTypeRefusal: () => typeRefusal,
}))
const txSubmission = await import("./txSubmission")
const gossipSizeRefusal = jest.fn(() => sizeRefusal)
mock.module("./txSubmission", () => ({ ...txSubmission, gossipSizeRefusal }))

const Chain = (await import("src/libs/blockchain/chain")).default
const Mempool = (await import("src/libs/blockchain/mempool")).default
const GossipManager = (await import("src/libs/gossip/GossipManager")).default
spyOn(Chain, "checkTxExists").mockImplementation(async (h: string) => {
    if (readFails) throw new Error("db down")
    return onChain.has(h)
})
spyOn(Mempool, "checkTransactionByHash").mockImplementation(
    async (h: string) => inMempool.has(h) as any,
)
spyOn(GossipManager, "isEnabled").mockImplementation(() => gossipOn)

const {
    outboundAdmissionRefusal,
    claimOutboundRun,
    __resetOutboundClaims,
    OUTBOUND_CLAIMS_MAX,
} = await import("./outboundAdmission")

const HASH = "0x" + "11".repeat(32)
const tx: any = { hash: HASH, content: { type: "crosschainOperation" } }
const envelope: any = { data: { transaction: tx } }

beforeEach(() => {
    onChain.clear()
    inMempool.clear()
    readFails = false
    gossipOn = true
    editsVerdict = { ok: true }
    typeRefusal = null
    sizeRefusal = null
    gossipSizeRefusal.mockClear()
    __resetOutboundClaims()
})

describe("outboundAdmissionRefusal", () => {
    it("lets an admissible tx through", async () => {
        expect(await outboundAdmissionRefusal(envelope, tx)).toBeNull()
    })

    it("refuses what submitValidatedTx would refuse", async () => {
        typeRefusal = "type not accepted from clients"
        expect(await outboundAdmissionRefusal(envelope, tx)).toBe(typeRefusal)
        typeRefusal = null
        sizeRefusal = "too large"
        expect(await outboundAdmissionRefusal(envelope, tx)).toBe("too large")
        sizeRefusal = null
        editsVerdict = { ok: false, reason: "edits do not match" }
        expect(await outboundAdmissionRefusal(envelope, tx)).toBe("edits do not match")
    })

    it("skips the size check with gossip off", async () => {
        gossipOn = false
        sizeRefusal = "too large"
        expect(await outboundAdmissionRefusal(envelope, tx)).toBeNull()
        expect(gossipSizeRefusal).not.toHaveBeenCalled()
    })

    it("refuses a tx already on chain or in the mempool", async () => {
        onChain.add(HASH)
        expect(await outboundAdmissionRefusal(envelope, tx)).toContain("on chain")
        onChain.clear()
        inMempool.add(HASH)
        expect(await outboundAdmissionRefusal(envelope, tx)).toContain("in mempool")
    })

    it("refuses when a read fails", async () => {
        readFails = true
        expect(await outboundAdmissionRefusal(envelope, tx)).toContain("db down")
    })
})

describe("claimOutboundRun", () => {
    it("lets each hash run once", () => {
        expect(claimOutboundRun(HASH, 100, 100)).toBe(true)
        expect(claimOutboundRun(HASH, 100, 100)).toBe(false)
        expect(claimOutboundRun(HASH, 100, 500)).toBe(false)
        expect(claimOutboundRun("0x22", 100, 100)).toBe(true)
    })

    it("at the cap, drops claims whose reference block left the window first", () => {
        for (let i = 0; i < OUTBOUND_CLAIMS_MAX; i++) claimOutboundRun(`old${i}`, 1, 1)
        claimOutboundRun("live", 1000, 1000)
        // the old claims could no longer be broadcast at head 1000; the live one stays
        expect(claimOutboundRun("live", 1000, 1000)).toBe(false)
        expect(claimOutboundRun("old0", 1, 1000)).toBe(true)
    })
})

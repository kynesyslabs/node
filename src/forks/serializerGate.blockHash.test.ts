// Guards the `deterministicBlockHash` fork in serializeBlockContent: the
// node-local `peerlist` must not enter the block-hash input once the fork
// is active, otherwise validators with divergent peer views hash the same
// (height, tx-set) differently and consensus can never reach quorum
// (observed as a liveness stall at height 249445).

// Control the fork gate directly — mirrors the real isForkActive semantics
// (active iff activationHeight !== null && height >= activationHeight)
// without dragging in SharedState.
let activationHeight: number | null = null
jest.mock("./forkGates", () => ({
    isForkActive: (_name: string, height: number) =>
        activationHeight !== null && height >= activationHeight,
}))

import { serializeBlockContent } from "./serializerGate"

function content(peerlist: unknown[], orderedTransactions = ["tx1", "tx2"]) {
    return {
        ordered_transactions: orderedTransactions,
        previousHash: "prev-hash",
        timestamp: 1_700_000_000,
        peerlist,
        native_tables_hashes: { native_gcr: "gcr-digest" },
    } as any
}

// Same block, but each node holds a different live peer list.
const nodeA = content([{ identity: "A", url: "http://a:53550" }])
const nodeB = content([
    { identity: "B", url: "http://b:53550" },
    { identity: "C", url: "http://c:53550" },
])

describe("serializeBlockContent — deterministicBlockHash fork", () => {
    beforeEach(() => {
        activationHeight = null
    })

    it("pre-fork: peerlist is part of the hash input (nodes diverge)", () => {
        activationHeight = null
        expect(serializeBlockContent(nodeA, 100)).not.toBe(
            serializeBlockContent(nodeB, 100),
        )
    })

    it("post-fork: peerlist is excluded → identical bytes across peer views", () => {
        activationHeight = 0
        expect(serializeBlockContent(nodeA, 100)).toBe(
            serializeBlockContent(nodeB, 100),
        )
    })

    it("post-fork: non-peerlist content still changes the hash", () => {
        activationHeight = 0
        const differentTxs = content(
            [{ identity: "A", url: "http://a:53550" }],
            ["tx1", "tx3"],
        )
        expect(serializeBlockContent(nodeA, 100)).not.toBe(
            serializeBlockContent(differentTxs, 100),
        )
    })

    it("honors the activation height boundary", () => {
        activationHeight = 200
        // below activation → pre-fork → peerlist still diverges
        expect(serializeBlockContent(nodeA, 199)).not.toBe(
            serializeBlockContent(nodeB, 199),
        )
        // at/above activation → post-fork → converges
        expect(serializeBlockContent(nodeA, 200)).toBe(
            serializeBlockContent(nodeB, 200),
        )
    })
})

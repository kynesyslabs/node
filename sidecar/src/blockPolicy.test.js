import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { BlockPolicy } from "./blockPolicy.js"

const hash = "ab".repeat(32)
const ourKey = "cd".repeat(32)
const msg = (signatures = {}, blockHash = hash) => ({
    data: new TextEncoder().encode(JSON.stringify({ hash: blockHash, validation_data: { signatures } })),
})

describe("sidecar block policy", () => {
    it("dedups known blocks regardless of the signers in a later copy", () => {
        const policy = new BlockPolicy()
        policy.remember(hash)
        assert.equal(policy.validate("relay", msg({ a: "valid" })), "ignore")
        assert.equal(policy.validate("relay", msg({ [ourKey]: "signature" })), "ignore")
    })

    it("keeps unconfirmed block variants eligible", () => {
        const policy = new BlockPolicy()
        policy.remember("ef".repeat(32))
        assert.equal(policy.validate("relay1", msg({ a: "first" })), "accept")
        const honest = { number: 101, hash,
            content: { ordered_transactions: [], previousHash: "ef".repeat(32), timestamp: 1_700_000_000,
                peerlist: [], native_tables_hashes: { native_gcr: "placeholder" } },
            validation_data: { signatures: {} } }
        assert.equal(policy.validate("relay", { data: new TextEncoder().encode(JSON.stringify(honest)) }), "accept")
    })

    it("ignores BOM-prefixed and deeply nested known blocks before relay", () => {
        const policy = new BlockPolicy()
        policy.remember(hash)
        const encode = (value) => ({ data: new TextEncoder().encode(value) })
        assert.equal(policy.validate("relay", { data: Buffer.concat([Buffer.from([239, 187, 191]), msg().data]) }), "ignore")
        assert.equal(policy.validate("relay", encode(JSON.stringify({ hash, extra: Array(66).fill(0).reduce(v => [v], null) }))), "ignore")
        assert.equal(policy.validate("relay", encode("[".repeat(65) + "0" + "]".repeat(65))), "ignore")
    })
})

import { describe, expect, it } from "bun:test"
import { filterSignaturesByShardMembership } from "./signerMembership"

const member = (identity: string) => ({ identity })

describe("filterSignaturesByShardMembership", () => {
    it("drops valid-looking signatures from identities outside the shard", () => {
        const signatures = {
            "AA": "signature-a",
            "BB": "signature-b",
        }

        expect(
            filterSignaturesByShardMembership(signatures, [member("aa")]),
        ).toEqual({ "AA": "signature-a" })
    })

    it("preserves signatures from current shard members", () => {
        const signatures = { aa: "signature-a", bb: "signature-b" }

        expect(
            filterSignaturesByShardMembership(signatures, [
                member("AA"),
                member("bb"),
            ]),
        ).toEqual(signatures)
    })

    it("does not mutate the incoming signature map", () => {
        const signatures = { aa: "signature-a", cc: "signature-c" }

        filterSignaturesByShardMembership(signatures, [member("aa")])

        expect(signatures).toEqual({ aa: "signature-a", cc: "signature-c" })
    })
})
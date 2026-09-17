import {
    web2BoundProofMessage,
    WEB2_PROOF_DOMAIN,
} from "./boundMessage"

const SENDER = "0x" + "ab".repeat(32)

describe("web2BoundProofMessage", () => {
    it("names the domain, the context, the handle and the signer", () => {
        expect(web2BoundProofMessage("twitter", "someone", SENDER)).toBe(
            `${WEB2_PROOF_DOMAIN}:twitter:someone:${SENDER}`,
        )
    })

    it("separates handles, so a proof cannot be moved to another account", () => {
        expect(web2BoundProofMessage("twitter", "alice", SENDER)).not.toBe(
            web2BoundProofMessage("twitter", "bob", SENDER),
        )
    })

    it("separates contexts, so a Twitter proof is not a GitHub proof", () => {
        expect(web2BoundProofMessage("twitter", "alice", SENDER)).not.toBe(
            web2BoundProofMessage("github", "alice", SENDER),
        )
    })

    it("separates signers", () => {
        expect(
            web2BoundProofMessage("twitter", "alice", SENDER),
        ).not.toBe(
            web2BoundProofMessage("twitter", "alice", "0x" + "cd".repeat(32)),
        )
    })

    it("is case-insensitive on the handle and the signer", () => {
        expect(web2BoundProofMessage("twitter", "Alice", SENDER.toUpperCase()))
            .toBe(web2BoundProofMessage("twitter", "alice", SENDER))
    })

    it("never collides with the legacy constant", () => {
        expect(web2BoundProofMessage("twitter", "dw2p", SENDER)).not.toBe(
            "dw2p",
        )
    })
})

import { describe, expect, it } from "bun:test"

import { isOperatorRequest } from "./operatorAuth"

const SUDO = "0xabc123"
const anon = { verified: false, publicKey: null }

const input = (over: Partial<Parameters<typeof isOperatorRequest>[0]>) => ({
    auth: anon,
    sudoPubkey: SUDO,
    socketAddress: "203.0.113.7",
    headers: new Headers(),
    ...over,
})

describe("isOperatorRequest", () => {
    it("admits a request signed by the sudo key, with or without an algorithm prefix", () => {
        expect(
            isOperatorRequest(
                input({ auth: { verified: true, publicKey: SUDO } }),
            ),
        ).toBe(true)
        expect(
            isOperatorRequest(
                input({ auth: { verified: true, publicKey: `ed25519:${SUDO}` } }),
            ),
        ).toBe(true)
    })

    it("refuses another key, an unverified claim, and any key when no sudo key is set", () => {
        expect(
            isOperatorRequest(
                input({ auth: { verified: true, publicKey: "0xother" } }),
            ),
        ).toBe(false)
        expect(
            isOperatorRequest(
                input({ auth: { verified: false, publicKey: SUDO } }),
            ),
        ).toBe(false)
        expect(
            isOperatorRequest(
                input({
                    auth: { verified: true, publicKey: SUDO },
                    sudoPubkey: null,
                }),
            ),
        ).toBe(false)
    })

    it("refuses an anonymous remote caller", () => {
        expect(isOperatorRequest(input({}))).toBe(false)
    })

    it("admits an anonymous caller on the node's own host", () => {
        for (const socketAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
            expect(isOperatorRequest(input({ socketAddress }))).toBe(true)
        }
    })

    it("does not treat a proxy on the same host as the host itself", () => {
        for (const header of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded"]) {
            expect(
                isOperatorRequest(
                    input({
                        socketAddress: "127.0.0.1",
                        headers: new Headers({ [header]: "198.51.100.4" }),
                    }),
                ),
            ).toBe(false)
        }
    })

    it("still admits the sudo key through a proxy", () => {
        expect(
            isOperatorRequest(
                input({
                    auth: { verified: true, publicKey: SUDO },
                    socketAddress: "127.0.0.1",
                    headers: new Headers({ "x-forwarded-for": "198.51.100.4" }),
                }),
            ),
        ).toBe(true)
    })

    it("refuses when the socket address is unknown or unparseable", () => {
        expect(isOperatorRequest(input({ socketAddress: undefined }))).toBe(false)
        expect(isOperatorRequest(input({ socketAddress: "not-an-ip" }))).toBe(false)
    })
})

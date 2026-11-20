import { expect, it, spyOn } from "bun:test"
import forge from "node-forge"
import Cryptography from "./cryptography"
import { getNodePrivateKey } from "../omniprotocol/integration/keys"
import { PeerConnection } from "../omniprotocol/transport/PeerConnection"
import { ConnectionState } from "../omniprotocol/transport/types"
import { SigningError } from "../omniprotocol/types/errors"
import { handleError } from "src/errors"
import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { CategorizedLogger } from "src/utilities/tui"

it("keeps key-bearing error names and messages out of key-handling logs", () => {
    const marker = "SECRET_MARKER"
    const debug = spyOn(log, "debug").mockImplementation(() => undefined)
    const error = spyOn(log, "error").mockImplementation(() => null)
    const previousKeypair = getSharedState.keypair

    try {
        const privateKey = {
            get type() {
                throw Object.assign(new Error(marker), { name: marker })
            },
            decrypt: () => "ok",
        }
        expect(Cryptography.rsa.decrypt("", privateKey)).toEqual([true, "ok"])

        getSharedState.keypair = {
            get privateKey() {
                throw Object.assign(new Error(marker), { name: marker })
            },
            publicKey: new Uint8Array(32),
        } as typeof getSharedState.keypair
        expect(getNodePrivateKey()).toBeNull()

        expect(debug).toHaveBeenCalled()
        expect(error).toHaveBeenCalled()
        expect(debug.mock.calls.flat().join(" ")).toContain("(Error)")
        expect(error.mock.calls.flat().join(" ")).toContain("(Error)")
        expect(debug.mock.calls.flat().join(" ")).not.toContain(marker)
        expect(error.mock.calls.flat().join(" ")).not.toContain(marker)
    } finally {
        getSharedState.keypair = previousKeypair
        debug.mockRestore()
        error.mockRestore()
    }
})

it("logs the type of a non-Error failure without its value", () => {
    const marker = "private-key-byte-marker"
    const error = spyOn(log, "error").mockImplementation(() => null)
    const previousKeypair = getSharedState.keypair
    try {
        getSharedState.keypair = {
            get privateKey() {
                throw marker
            },
            publicKey: new Uint8Array(32),
        } as typeof getSharedState.keypair
        expect(getNodePrivateKey()).toBeNull()
        const logged = error.mock.calls.flat().join(" ")
        expect(logged).toContain("(string)")
        expect(logged).not.toContain(marker)
    } finally {
        getSharedState.keypair = previousKeypair
        error.mockRestore()
    }
})

it("keeps the signer's error text out of the Ed25519 signing error and its log", async () => {
    const marker = "SECRET_MARKER"
    const warning = spyOn(CategorizedLogger.getInstance(), "warning").mockImplementation(() => null)
    const previousGenesis = getSharedState.genesisBlockHash
    const thrownValues: [unknown, string][] = [
        [Object.assign(new Error(marker), { name: marker }), "(Error)"],
        [marker, "(string)"],
    ]
    try {
        getSharedState.genesisBlockHash = "d5".repeat(32)
        for (const [thrown, tag] of thrownValues) {
            const sign = spyOn(forge.pki.ed25519, "sign").mockImplementation(() => {
                throw thrown
            })
            let err: any
            try {
                const conn: any = new PeerConnection("0x" + "cd".repeat(32), "tcp://198.51.100.2:53551")
                conn._state = ConnectionState.READY
                err = await conn
                    .sendAuthenticated(0x10, Buffer.from("hi"), Buffer.alloc(64), Buffer.alloc(32))
                    .catch((e: unknown) => e)
                expect(sign).toHaveBeenCalled()
            } finally {
                sign.mockRestore()
            }

            expect(err).toBeInstanceOf(SigningError)
            expect(err.message).toContain(tag)
            expect(err.message).not.toContain(marker)
            // What PeerOmniAdapter does with it: logs the message and the cause chain
            handleError(err, "NETWORK", { source: "OmniProtocol PeerAdapter.adaptCall" })
        }
        const logged = warning.mock.calls.flat().join(" ")
        expect(logged).toContain("Ed25519 signing failed")
        expect(logged).not.toContain(marker)
    } finally {
        getSharedState.genesisBlockHash = previousGenesis
        warning.mockRestore()
    }
})

import * as nodeCrypto from "node:crypto"
import {
    txSignaturePreimage,
    TX_SIGNATURE_DOMAIN,
} from "../../crypto/txSignaturePreimage"
import type { Transaction } from "@kynesyslabs/demosdk/types"

// The validator imports the SDK's ESM build, which jest's CJS transform
// cannot load. Back it with real ed25519 from node:crypto instead of a stub,
// so these assertions still say something about signatures rather than about
// how the mock was wired.
jest.mock(
    "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js",
    () => {
        const crypto = jest.requireActual<typeof nodeCrypto>("node:crypto")
        const SPKI_ED25519_PREFIX = Buffer.from(
            "302a300506032b6570032100",
            "hex",
        )
        return {
            unifiedCrypto: {
                verify: async ({
                    message,
                    publicKey,
                    signature,
                }: {
                    message: Uint8Array
                    publicKey: Uint8Array
                    signature: Uint8Array
                }) => {
                    const key = crypto.createPublicKey({
                        key: Buffer.concat([
                            SPKI_ED25519_PREFIX,
                            Buffer.from(publicKey),
                        ]),
                        format: "der",
                        type: "spki",
                    })
                    return crypto.verify(
                        null,
                        Buffer.from(message),
                        key,
                        Buffer.from(signature),
                    )
                },
            },
            hexToUint8Array: (hex: string) =>
                Uint8Array.from(
                    Buffer.from(hex.replace(/^0x/, ""), "hex"),
                ),
        }
    },
)

jest.mock(
    "../../../../node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js",
    () => ({
        serializeTransactionContent: (content: unknown) =>
            JSON.stringify(content),
    }),
)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateTxSignature } = require("./txValidator")

const HASH = "7c".repeat(32)
const CHAIN_ID = 1

const keyPair = nodeCrypto.generateKeyPairSync("ed25519")
/** Raw 32-byte public key: the tail of the SPKI DER encoding. */
const ADDRESS = keyPair.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex")

function sign(bytes: Uint8Array): string {
    return nodeCrypto
        .sign(null, Buffer.from(bytes), keyPair.privateKey)
        .toString("hex")
}

/**
 * Only the fields the signature path reads. The ed25519 branch also requires
 * `from === from_ed25519_address` (the identity-confusion check).
 */
function signedTx(signature: string): Transaction {
    return {
        hash: HASH,
        signature: { type: "ed25519", data: signature },
        content: {
            from: ADDRESS,
            from_ed25519_address: ADDRESS,
        },
    } as unknown as Transaction
}

describe("txSignaturePreimage", () => {
    it("is the bare hash while the fork is inactive", () => {
        expect(
            new TextDecoder().decode(
                txSignaturePreimage(HASH, CHAIN_ID, false),
            ),
        ).toBe(HASH)
    })

    it("names the domain and the chain once active", () => {
        expect(
            new TextDecoder().decode(
                txSignaturePreimage(HASH, CHAIN_ID, true),
            ),
        ).toBe(`${TX_SIGNATURE_DOMAIN}${CHAIN_ID}:${HASH}`)
    })

    it("separates chains", () => {
        expect(txSignaturePreimage(HASH, 1, true)).not.toEqual(
            txSignaturePreimage(HASH, 2, true),
        )
    })
})

describe("validateTxSignature with the signatureDomain fork", () => {
    it("accepts a legacy signature while the fork is inactive", async () => {
        const signature = sign(new TextEncoder().encode(HASH))

        const result = await validateTxSignature(signedTx(signature), null)

        expect(result.valid).toBe(true)
    })

    it("rejects a signature over the bare hash once the fork is active", async () => {
        // The wallet-confusion case: a site asks for a signature over a
        // "login nonce" that is really a transaction hash it computed. Those
        // bytes stop being a transaction signature.
        const signature = sign(new TextEncoder().encode(HASH))

        const result = await validateTxSignature(signedTx(signature), null, {
            active: true,
            chainId: CHAIN_ID,
        })

        expect(result.valid).toBe(false)
        expect(result.reason).toContain("signature verification failed")
    })

    it("accepts a domain-bound signature once the fork is active", async () => {
        const signature = sign(txSignaturePreimage(HASH, CHAIN_ID, true))

        const result = await validateTxSignature(signedTx(signature), null, {
            active: true,
            chainId: CHAIN_ID,
        })

        expect(result.valid).toBe(true)
    })

    it("rejects a signature bound to another chain", async () => {
        const signature = sign(txSignaturePreimage(HASH, 1, true))

        const result = await validateTxSignature(signedTx(signature), null, {
            active: true,
            chainId: 2,
        })

        expect(result.valid).toBe(false)
    })

    it("rejects a domain-bound signature on a node that has not forked", async () => {
        // The mirror case: a node must not accept the new preimage before it
        // activates the fork, or the two halves of the network disagree on
        // which transactions are valid.
        const signature = sign(txSignaturePreimage(HASH, CHAIN_ID, true))

        const result = await validateTxSignature(signedTx(signature), null)

        expect(result.valid).toBe(false)
    })
})

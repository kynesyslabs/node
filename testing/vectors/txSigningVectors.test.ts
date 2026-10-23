import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { Transaction } from "@kynesyslabs/demosdk/types"
import { txSignaturePreimage } from "../../src/libs/crypto/txSignaturePreimage"
import { serializeTxContent } from "../../src/libs/crypto/txContentSerializer"
import { validateTxSignature } from "../../src/libs/blockchain/validation/txValidator"
import { buildVectors, VECTORS_PATH } from "./generateTxSigningVectors"

const file = JSON.parse(readFileSync(VECTORS_PATH, "utf8"))

function txFor(vector: any): Transaction {
    return {
        hash: vector.hashPresented,
        content: {
            from: file.signer.publicKeyHex,
            from_ed25519_address: file.signer.publicKeyHex,
        },
        signature: { type: "ed25519", data: vector.signatureHex },
    } as unknown as Transaction
}

describe("shared tx signing vectors", () => {
    it("is self-describing", () => {
        expect(file.format).toBe("demos-tx-signing-vectors")
        expect(file.version).toBe(1)
        for (const field of [
            "preimageUtf8",
            "contentJsonUtf8Hex",
            "hashPresented",
            "expectedValid",
            "signer.seedLabel",
            "legacy preimage",
            "os-string",
            "demos-tx:v1:<chainId>:<hash>",
        ]) {
            expect(file.description).toContain(field)
        }
    })

    it("covers the cases the SDK and wallet have to agree on", () => {
        const ids = file.vectors.map((v: any) => v.id)
        expect(ids).toContain("legacy-bare-hash")
        expect(ids).toContain("domain-chain-1337")
        expect(ids).toContain("domain-chain-1")
        expect(ids).toContain("non-ascii-content-utf8")
        const replay = file.vectors.find(
            (v: any) => v.id === "cross-chain-replay-1-on-1337",
        )
        expect(replay.signedWith.chainId).toBe(1)
        expect(
            replay.verify.find((c: any) => c.chainId === 1337).expectedValid,
        ).toBe(false)
    })

    it("is exactly what the node's primitives produce today", async () => {
        // Ed25519 is deterministic, so any difference means the preimage
        // builder, the serialization or the key derivation changed.
        expect(file).toEqual(await buildVectors())
    })

    for (const vector of file.vectors) {
        describe(vector.id, () => {
            it("hashes the content as UTF-8", () => {
                expect(vector.contentJson).toBe(
                    serializeTxContent(
                        vector.content,
                        vector.serialization === "os-string",
                    ),
                )
                const bytes = Buffer.from(vector.contentJsonUtf8Hex, "hex")
                expect(bytes.toString("utf8")).toBe(vector.contentJson)
                expect(vector.hash).toBe(
                    createHash("sha256").update(bytes).digest("hex"),
                )
            })

            it("signs the preimage the builder produces", () => {
                const preimage = txSignaturePreimage(
                    vector.hash,
                    vector.signedWith.chainId ?? 0,
                    vector.signedWith.forkActive,
                )
                expect(Buffer.from(preimage).toString("hex")).toBe(
                    vector.preimageHex,
                )
                expect(Buffer.from(vector.preimageUtf8, "utf8")).toEqual(
                    Buffer.from(preimage),
                )
                expect(vector.preimageUtf8).toBe(
                    vector.signedWith.forkActive
                        ? `demos-tx:v1:${vector.signedWith.chainId}:${vector.hash}`
                        : vector.hash,
                )
            })

            for (const ctx of vector.verify) {
                const label = ctx.forkActive
                    ? `chain ${ctx.chainId}`
                    : "legacy verifier"
                it(`${ctx.expectedValid ? "accepts" : "rejects"} on ${label}`, async () => {
                    const result = await validateTxSignature(
                        txFor(vector),
                        null,
                        { active: ctx.forkActive, chainId: ctx.chainId ?? 0 },
                    )
                    expect(result.valid).toBe(ctx.expectedValid)
                })
            }
        })
    }

    it("pins the post-osDenomination serialization the SDK has to reproduce", () => {
        const transfer = file.vectors.find(
            (v: any) => v.id === "os-string-transfer-chain-1337",
        )
        const wire = JSON.parse(transfer.contentJson)
        expect(wire.amount).toBe("100000000000")
        expect(wire.transaction_fee.network_fee).toBe("1000000000")

        const edits = file.vectors.find(
            (v: any) => v.id === "os-string-gcr-edits-chain-1337",
        )
        const editsWire = JSON.parse(edits.contentJson)
        expect(editsWire.gcr_edits.map((e: any) => e.amount)).toEqual([
            "25000000000",
            "25000000000",
        ])
        expect(Object.keys(editsWire.transaction_fee)).toEqual([
            "network_fee",
            "rpc_fee",
            "additional_fee",
            "rpc_address",
        ])
        // The signer holds DEM numbers; the hash must not be over them.
        expect(edits.content.gcr_edits[0].amount).toBe(25)
        expect(edits.hash).not.toBe(
            createHash("sha256")
                .update(JSON.stringify(edits.content), "utf8")
                .digest("hex"),
        )
    })

    it("includes a vector whose bytes differ between UTF-8 and UTF-16", () => {
        const v = file.vectors.find((x: any) => x.id === "non-ascii-content-utf8")
        expect(/[^\x00-\x7f]/.test(v.contentJson)).toBe(true)
        const utf16 = createHash("sha256")
            .update(Buffer.from(v.contentJson, "utf16le"))
            .digest("hex")
        expect(utf16).not.toBe(v.hash)
    })
})

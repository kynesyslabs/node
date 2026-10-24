/**
 * Builds testing/vectors/tx-signing-vectors.v1.json from the node's own
 * primitives. Run `bun testing/vectors/generateTxSigningVectors.ts` to rewrite
 * the file; ed25519 is deterministic, so a rerun on unchanged code is a no-op
 * and the test that compares the two catches any drift in either direction.
 */
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { txSignaturePreimage } from "../../src/libs/crypto/txSignaturePreimage"
import { serializeTxContent } from "../../src/libs/crypto/txContentSerializer"
import { createTestSigner, VECTOR_SEED_LABEL } from "./testSigner"

export const VECTORS_PATH = resolve(import.meta.dir, "tx-signing-vectors.v1.json")

const DESCRIPTION = [
    "Shared transaction-signing vectors, format v1. Copy this file unchanged into the SDK and wallet CIs and check every vector against their own preimage builder and verifier.",
    "A Demos transaction signature covers the UTF-8 bytes of a preimage. Legacy preimage (signatureDomain inactive): the 64-char lowercase hex tx hash itself. Domain preimage (signatureDomain active): the string demos-tx:v1:<chainId>:<hash> where chainId is the decimal properties.id of the network's genesis. The hash is the lowercase hex SHA-256 of the UTF-8 bytes of contentJson.",
    "contentJson depends on the vector's serialization. 'json': contentJson is JSON.stringify(content) with no whitespace, the serialization where osDenomination is not active (amounts are plain numbers). 'os-string': osDenomination is active; content is what the signer holds (amounts and fees as DEM numbers) and contentJson is the canonical wire form: top-level amount, every transaction_fee field (network_fee, rpc_fee, additional_fee) and every gcr_edits[] amount (balance edits, escrow data.amount, validatorStake amount) become decimal OS strings (DEM x 10^9, no leading zeros), all other fields and the key order stay as they are, then JSON.stringify with no whitespace. Fee keys the signer added beyond the standard ones are kept as written. The two os-string vectors pin the serializer SDK and wallet signers must reproduce; the preimage rules are the same for both serializations.",
    "Top-level fields: signer.algorithm; signer.publicKeyHex (0x-prefixed ed25519 public key; the key controls nothing and exists only for these vectors); signer.seedLabel (an implementation that wants to regenerate the file derives the 128-byte master seed as SHA-512(seedLabel + ':a') followed by SHA-512(seedLabel + ':b') and passes it to unifiedCrypto.generateIdentity('ed25519', seed); checking the published signatures needs only signer.publicKeyHex).",
    "Per vector: id, description; serialization ('json' or 'os-string', see above); content (the transaction content object as the signer holds it); contentJson (exact string that was hashed); contentJsonUtf8Hex (the bytes that were hashed, so a non-ASCII vector is unambiguous); hash; signedWith.forkActive and signedWith.chainId (what the signer committed to; chainId is null for the legacy preimage); preimageUtf8 and preimageHex (the exact bytes that were signed); signatureHex (0x-prefixed ed25519 signature over those bytes); hashPresented (the hash the verifier is given, normally equal to hash); verify[] (verifier contexts).",
    "Each verify entry is { forkActive, chainId, expectedValid }: a verifier whose signatureDomain is (in)active at the transaction's block height and whose genesis properties.id is chainId (null when forkActive is false) must return expectedValid for this signature, using hashPresented as the hash. A conforming implementation builds the preimage from the context, verifies the signature against signer.publicKeyHex and compares with expectedValid. Vectors with expectedValid false are negative vectors and are as binding as the positive ones.",
].join("\n")

interface Context {
    forkActive: boolean
    chainId: number | null
}

function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex")
}

function baseContent(publicKeyHex: string, overrides: Record<string, unknown> = {}) {
    return {
        type: "native",
        from: publicKeyHex,
        from_ed25519_address: publicKeyHex,
        to: "0x" + "ef".repeat(32),
        amount: 100,
        data: ["native", { nativeOperation: "send", args: ["0x" + "ef".repeat(32), 100] }],
        gcr_edits: [],
        nonce: 7,
        timestamp: 1_760_000_000_000,
        transaction_fee: {
            network_fee: 1,
            rpc_fee: 2,
            additional_fee: 3,
            rpc_address: null,
        },
        ...overrides,
    }
}

export async function buildVectors() {
    const signer = await createTestSigner()
    const pub = signer.publicKeyHex
    const enc = new TextEncoder()

    async function make(
        id: string,
        description: string,
        content: Record<string, unknown>,
        signedWith: Context,
        verify: Array<Context & { expectedValid: boolean }>,
        hashPresentedOverride?: string,
        osDenomination = false,
    ) {
        const contentJson = serializeTxContent(content as any, osDenomination)
        const contentBytes = enc.encode(contentJson)
        const hash = sha256Hex(contentBytes)
        const preimage = txSignaturePreimage(
            hash,
            signedWith.chainId ?? 0,
            signedWith.forkActive,
        )
        return {
            id,
            description,
            serialization: osDenomination ? "os-string" : "json",
            content,
            contentJson,
            contentJsonUtf8Hex: Buffer.from(contentBytes).toString("hex"),
            hash,
            signedWith,
            preimageUtf8: new TextDecoder().decode(preimage),
            preimageHex: Buffer.from(preimage).toString("hex"),
            signatureHex: await signer.sign(preimage),
            hashPresented: hashPresentedOverride ?? hash,
            verify,
        }
    }

    const legacy: Context = { forkActive: false, chainId: null }
    const dom = (chainId: number): Context => ({ forkActive: true, chainId })

    const vectors = [
        await make(
            "legacy-bare-hash",
            "Signed over the bare hash. Valid only where signatureDomain is inactive; a network that has it active must reject it whatever its chain id.",
            baseContent(pub),
            legacy,
            [
                { ...legacy, expectedValid: true },
                { ...dom(1337), expectedValid: false },
                { ...dom(1), expectedValid: false },
            ],
        ),
        await make(
            "domain-chain-1337",
            "Signed for chain id 1337 (devnet). Valid on 1337 only; a legacy verifier and every other chain id must reject it.",
            baseContent(pub, { nonce: 8 }),
            dom(1337),
            [
                { ...dom(1337), expectedValid: true },
                { ...dom(1), expectedValid: false },
                { ...dom(31337), expectedValid: false },
                { ...legacy, expectedValid: false },
            ],
        ),
        await make(
            "domain-chain-1",
            "Signed for chain id 1. Valid on 1 only, in particular not on 1337.",
            baseContent(pub, { nonce: 9 }),
            dom(1),
            [
                { ...dom(1), expectedValid: true },
                { ...dom(1337), expectedValid: false },
                { ...legacy, expectedValid: false },
            ],
        ),
        await make(
            "non-ascii-content-utf8",
            "Content with non-ASCII text. The hash is SHA-256 over the UTF-8 bytes (contentJsonUtf8Hex), not over UTF-16 code units or Latin-1. Signed for chain id 1337.",
            baseContent(pub, {
                nonce: 10,
                data: [
                    "native",
                    { nativeOperation: "send", memo: "Zahlung für Übergabe 東京 \u{1F680}" },
                ],
            }),
            dom(1337),
            [
                { ...dom(1337), expectedValid: true },
                { ...dom(1), expectedValid: false },
            ],
        ),
        await make(
            "cross-chain-replay-1-on-1337",
            "A transaction signed for chain id 1 replayed onto chain id 1337. Must FAIL on 1337; this is the replay the chain id exists to stop.",
            baseContent(pub, { nonce: 11, amount: 5 }),
            dom(1),
            [
                { ...dom(1337), expectedValid: false },
                { ...dom(1), expectedValid: true },
            ],
        ),
        await make(
            "signature-over-another-hash",
            "A valid chain-1337 signature presented with a different hash (hashPresented). The signature covers the hash, so it must FAIL.",
            baseContent(pub, { nonce: 12 }),
            dom(1337),
            [{ ...dom(1337), expectedValid: false }],
            "00".repeat(32),
        ),
        await make(
            "os-string-transfer-chain-1337",
            "osDenomination active: amount 100 DEM and fees 1, 2 and 3 DEM are hashed as OS strings. Signed for chain id 1337.",
            baseContent(pub, { nonce: 13 }),
            dom(1337),
            [
                { ...dom(1337), expectedValid: true },
                { ...dom(1), expectedValid: false },
            ],
            undefined,
            true,
        ),
        await make(
            "os-string-gcr-edits-chain-1337",
            "osDenomination active with a transaction carrying balance gcr_edits and a fee that names an rpc_address: edit amounts are hashed as OS strings too, and the key order of fee and edits is kept. Signed for chain id 1337.",
            baseContent(pub, {
                nonce: 14,
                amount: 25,
                gcr_edits: [
                    {
                        type: "balance",
                        operation: "remove",
                        account: pub,
                        amount: 25,
                        txhash: "",
                        isRollback: false,
                    },
                    {
                        type: "balance",
                        operation: "add",
                        account: "0x" + "ef".repeat(32),
                        amount: 25,
                        txhash: "",
                        isRollback: false,
                    },
                ],
                transaction_fee: {
                    network_fee: 1,
                    rpc_fee: 2,
                    additional_fee: 3,
                    rpc_address: "0x" + "12".repeat(32),
                },
            }),
            dom(1337),
            [
                { ...dom(1337), expectedValid: true },
                { ...dom(1), expectedValid: false },
            ],
            undefined,
            true,
        ),
    ]

    return {
        format: "demos-tx-signing-vectors",
        version: 1,
        description: DESCRIPTION,
        signer: {
            algorithm: "ed25519",
            publicKeyHex: pub,
            seedLabel: VECTOR_SEED_LABEL,
        },
        vectors,
    }
}

if (import.meta.main) {
    const file = await buildVectors()
    writeFileSync(VECTORS_PATH, JSON.stringify(file, null, 2) + "\n")
    console.log(`wrote ${VECTORS_PATH} (${file.vectors.length} vectors)`)
}

import { createHash } from "node:crypto"
// Direct build path, as in txValidator.ts: the SDK barrel pulls in zK.
import {
    unifiedCrypto as ucrypto,
    uint8ArrayToHex,
} from "../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto.js"

/**
 * Seed for the key every shared vector is signed with. Public on purpose: the
 * key controls nothing, and publishing the seed lets the SDK and wallet CIs
 * re-derive the key and regenerate the file to compare.
 */
export const VECTOR_SEED_LABEL = "demos-tx-signing-vectors-v1 test key, controls nothing"

export function vectorSeed(): Uint8Array {
    // 128 bytes: the crypto primitive warns on shorter master seeds.
    const part = (n: string) =>
        createHash("sha512").update(`${VECTOR_SEED_LABEL}:${n}`, "utf8").digest()
    return new Uint8Array(Buffer.concat([part("a"), part("b")]))
}

export interface TestSigner {
    publicKeyHex: string
    /** ed25519 signature over the exact bytes, 0x-prefixed hex. */
    sign(bytes: Uint8Array): Promise<string>
}

/**
 * An ed25519 signer built from the node's own crypto primitive, the one the
 * node signs and verifies transactions with.
 */
export async function createTestSigner(
    seed: Uint8Array = vectorSeed(),
): Promise<TestSigner> {
    await ucrypto.generateIdentity("ed25519", seed)
    const identity = await ucrypto.getIdentity("ed25519")
    const publicKeyHex = uint8ArrayToHex(identity.publicKey as Uint8Array)
    return {
        publicKeyHex,
        async sign(bytes: Uint8Array): Promise<string> {
            const signed = await ucrypto.sign("ed25519", bytes)
            return uint8ArrayToHex(signed.signature as Uint8Array)
        },
    }
}

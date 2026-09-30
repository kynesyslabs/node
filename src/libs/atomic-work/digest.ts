import crypto from "crypto"
import Hashing from "@/libs/crypto/hashing"
import { jcsCanonicalize } from "@/libs/crypto/jcs"

/**
 * The two digest shapes an atomic Work is built from.
 *
 * Both are domain-separated: the tag is a parameter, never a constant here,
 * because the tags belong to a profile and this module must not know which
 * profiles exist. A digest computed under one tag can then never verify as a
 * digest under another, which is the whole point of separating them.
 */

/** digest = sha256(domain ‖ JCS(value)). */
export function domainDigest(domain: string, value: unknown): string {
    return Hashing.sha256(domain + jcsCanonicalize(value))
}

/** A merkle leaf: sha256(0x00 ‖ domain ‖ JCS(value)), tagged apart from a node. */
export function leafDigest(domain: string, value: unknown): Buffer {
    return crypto
        .createHash("sha256")
        .update(
            Buffer.concat([
                Buffer.from([0x00]),
                Buffer.from(domain, "ascii"),
                Buffer.from(jcsCanonicalize(value), "utf-8"),
            ]),
        )
        .digest()
}

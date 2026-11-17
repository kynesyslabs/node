/* LICENSE

© 2026 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { tlsnVerifiedParams } from "@/forks/tlsnVerifiedGate"
import { judgeStoreTranscript } from "./identityPolicy"
import { judgePresentation } from "./presentationGate"

/**
 * The checks a `tlsn_store` presentation must pass under `tlsnVerified`
 * before its proof row can be written: the presentation gate every TLSN
 * verdict goes through, then the store's transcript rules. The token checks
 * (owner, expiry, domain, single use) need the chain's rows and are made
 * where the row is written.
 */

/** Room for the JSON envelope around the hex presentation (`version`, `meta`). */
export const STORED_PROOF_ENVELOPE_CHARS = 4096

export interface StoredPresentationInput {
    /** The `proof` arg of the store: JSON of a tlsn-js presentation `{version, data, meta}`. */
    proof: string
    /** Sender of the store, as the bind header must name it. */
    sender: string
    /** The `tlsn_request` tx hash the store names: 64 lowercase hex, no 0x. */
    requestTxHash: string
    /** Tip the fork payload (keys, caps) is read at. */
    tip: number
    /** Block time, unix seconds, that freshness is judged against. */
    blockTimeSec: number
}

export interface StoredPresentationFacts {
    attestationId: string
    /** Lowercase; the token's domain must equal it. */
    serverName: string
    /** Notary-attested connection time, unix seconds. */
    attestedTimeSec: number
    /** What the chain stores: `{version, data}` with lowercase hex, without the unsigned `meta`. */
    canonicalProof: string
}

export type StoredPresentationVerdict =
    | ({ ok: true } & StoredPresentationFacts)
    | { ok: false; reason: string }

const refuse = (reason: string): StoredPresentationVerdict => ({ ok: false, reason })

const HEX = /^(?:[0-9a-fA-F]{2})*$/

/** The presentation bytes and canonical proof of a store's `proof` arg, or why it is refused. */
function decodeProof(
    proof: string,
    maxBytes: number,
): { ok: true; data: string; canonical: string } | { ok: false; reason: string } {
    // Checked before parsing, so a huge arg costs no parse.
    if (proof.length > maxBytes * 2 + STORED_PROOF_ENVELOPE_CHARS) {
        return { ok: false, reason: `proof is larger than the ${maxBytes}-byte presentation cap` }
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(proof)
    } catch {
        return { ok: false, reason: "proof is not JSON" }
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "proof is not a presentation object" }
    }
    const { version, data } = parsed as { version?: unknown; data?: unknown }
    if (typeof version !== "string" || version.length === 0 || version.length > 64) {
        return { ok: false, reason: "proof has no version" }
    }
    if (typeof data !== "string" || data.length === 0 || !HEX.test(data)) {
        return { ok: false, reason: "proof data is not hex" }
    }
    // The byte cap itself is the gate's, judged on this same hex.
    const hex = data.toLowerCase()
    return { ok: true, data: hex, canonical: JSON.stringify({ version, data: hex }) }
}

/**
 * Verifies the presentation of a `tlsn_store` under `tlsnVerified`.
 *
 * A refusal is a verdict. A throw is none: the verifier cannot give the
 * chain's verdict on this node (TlsnVerifierUnavailableError), or the fork
 * is not active at `tip`, and the caller must not judge the transaction on it.
 */
export function verifyStoredPresentation(input: StoredPresentationInput): StoredPresentationVerdict {
    const params = tlsnVerifiedParams(input.tip)
    if (!params) throw new Error(`[TLSNotary] tlsnVerified is not active at ${input.tip}`)

    const decoded = decodeProof(input.proof, params.maxPresentationBytes)
    if (decoded.ok === false) return refuse(decoded.reason)

    const verdict = judgePresentation(decoded.data, { height: input.tip, blockTimeSec: input.blockTimeSec })
    if (verdict.ok === false) return refuse(verdict.reason)
    const p = verdict.presentation

    const transcript = judgeStoreTranscript(p, input.sender, input.requestTxHash)
    if (transcript.ok === false) return refuse(transcript.reason)

    return {
        ok: true,
        attestationId: p.attestationId,
        serverName: p.serverName.toLowerCase(),
        attestedTimeSec: p.time,
        canonicalProof: decoded.canonical,
    }
}

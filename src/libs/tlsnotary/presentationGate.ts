/**
 * The node's verdict on a TLSNotary presentation under the `tlsnVerified`
 * fork: the pinned wasm verifier, the notary keys and limits of the fork
 * payload, and the block's time. The verdict is consensus (it runs at apply),
 * so:
 * - every input is judged by values every node holds for the same block:
 *   the payload at the tip and the time of the block being applied, never
 *   this node's clock;
 * - only `ok` is a consensus value; `reason` is for logs and RPC replies, and
 *   no rule may branch on it;
 * - a node that cannot run the verifier (instance exhaustion, a verifier
 *   other than the one the chain pins) has no verdict and throws
 *   TlsnVerifierUnavailableError instead of refusing.
 */
import { isTrustedNotaryKey, tlsnVerifiedParams } from "@/forks/tlsnVerifiedGate"
import type { TlsnVerifiedParams } from "@/forks/forkConfig"
import {
    TLSN_VERIFY_WASM_SHA256,
    TlsnVerifierLoadError,
    TlsnVerifierUnavailableError,
    loadTlsnVerifier,
    type TlsnVerifiedPresentation,
    type TlsnVerifyResult,
} from "./wasmVerifier"

/** Facts of a presentation the node accepted, with the transcript as bytes. */
export interface AcceptedPresentation {
    attestationId: string
    serverName: string
    /** Notary-attested connection time, unix seconds. */
    time: number
    verifyingKey: { alg: string; hex: string }
    sent: Uint8Array
    sentAuthed: readonly (readonly [number, number])[]
    recv: Uint8Array
    recvAuthed: readonly (readonly [number, number])[]
}

export type PresentationVerdict =
    | { ok: true; presentation: AcceptedPresentation }
    | { ok: false; reason: string }

/** Where in the chain the presentation is judged. */
export interface PresentationClock {
    /** The tip the block is applied on; fork rules are judged there. */
    height: number
    /** Time of the block the transaction lands in, unix seconds. */
    blockTimeSec: number
}

/** The verifier a node runs, named by the sha256 of its wasm. */
export interface PresentationVerifier {
    wasmSha256: string
    verify(bytes: Uint8Array, onRefusal: (reason: string) => void): TlsnVerifyResult
}

const pinnedVerifier: PresentationVerifier = {
    wasmSha256: TLSN_VERIFY_WASM_SHA256,
    verify: (bytes, onRefusal) => loadTlsnVerifier().verifyPresentation(bytes, { onRefusal }),
}

let activeVerifier: PresentationVerifier = pinnedVerifier

/**
 * Replaces the verifier, for tests that verify vectors issued under a test
 * CA; null restores the pinned one.
 */
export function setPresentationVerifierForTests(v: PresentationVerifier | null): void {
    activeVerifier = v ?? pinnedVerifier
}

const refuse = (reason: string): PresentationVerdict => ({ ok: false, reason })

const HEX = /^[0-9a-fA-F]*$/

function hexToBytes(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, "hex"))
}

function rangesOf(
    raw: [number, number][] | null,
    length: number,
): (readonly [number, number])[] | null {
    if (raw === null) return []
    const out: (readonly [number, number])[] = []
    for (const r of raw) {
        if (
            !Array.isArray(r) ||
            !Number.isSafeInteger(r[0]) ||
            !Number.isSafeInteger(r[1]) ||
            r[0] < 0 ||
            r[0] > r[1] ||
            r[1] > length
        ) {
            return null
        }
        out.push([r[0], r[1]] as const)
    }
    return out
}

/**
 * The transcript of a verified presentation as bytes plus authed ranges.
 * Null when the verifier's output is not self-consistent, which is no
 * verdict on the input: the pinned build always emits a consistent one.
 */
function transcriptOf(out: TlsnVerifiedPresentation): {
    sent: Uint8Array
    sentAuthed: (readonly [number, number])[]
    recv: Uint8Array
    recvAuthed: (readonly [number, number])[]
} | null {
    const sent = out.sent === null ? new Uint8Array(0) : hexToBytes(out.sent)
    const recv = out.recv === null ? new Uint8Array(0) : hexToBytes(out.recv)
    const sentAuthed = rangesOf(out.sentAuthed, sent.length)
    const recvAuthed = rangesOf(out.recvAuthed, recv.length)
    if (!sentAuthed || !recvAuthed) return null
    return { sent, sentAuthed, recv, recvAuthed }
}

/**
 * Judges presentation bytes, given as the hex `data` of a tlsn-js
 * presentation, against the payload of the `tlsnVerified` fork at
 * `clock.height`. Throws TlsnVerifierUnavailableError when this node has no
 * verdict; throws a plain Error when the fork is not active there (the
 * caller must keep the pre-fork path).
 */
export function judgePresentation(dataHex: unknown, clock: PresentationClock): PresentationVerdict {
    const params = tlsnVerifiedParams(clock.height)
    if (!params) {
        throw new Error(`tlsnVerified is not active at ${clock.height}`)
    }
    return judgeWith(params, dataHex, clock)
}

function judgeWith(
    params: TlsnVerifiedParams,
    dataHex: unknown,
    clock: PresentationClock,
): PresentationVerdict {
    if (typeof dataHex !== "string" || dataHex.length === 0) {
        return refuse("presentation data must be a non-empty hex string")
    }
    // Before any decode: the cap bounds what the node copies and hands to
    // the verifier, whose decode allocates by sizes the input declares.
    if (dataHex.length > params.maxPresentationBytes * 2) {
        return refuse(
            `presentation is larger than the ${params.maxPresentationBytes} bytes the chain verifies`,
        )
    }
    if (dataHex.length % 2 !== 0 || !HEX.test(dataHex)) {
        return refuse("presentation data is not hex")
    }

    const verifier = activeVerifier
    // The chain pins the verifier it judges with; this node's verifier is a
    // different one, so whatever it said would be no verdict of the chain's.
    if (verifier.wasmSha256 !== params.verifierWasmSha256) {
        throw new TlsnVerifierUnavailableError(
            `this node's TLSN verifier ${verifier.wasmSha256} is not the one the chain pins (${params.verifierWasmSha256})`,
        )
    }

    let refusal = "presentation does not verify"
    let result: TlsnVerifyResult
    try {
        result = verifier.verify(hexToBytes(dataHex), reason => {
            refusal = `presentation does not verify: ${reason}`
        })
    } catch (err) {
        if (err instanceof TlsnVerifierUnavailableError) throw err
        if (err instanceof TlsnVerifierLoadError) {
            throw new TlsnVerifierUnavailableError(`verifier does not load: ${err.message}`)
        }
        throw new TlsnVerifierUnavailableError(
            `verifier failed: ${err instanceof Error ? err.message : String(err)}`,
        )
    }
    if (result.ok === false) return refuse(refusal)
    const out = result.out

    // The server identity proof is optional in TLSN: without it the
    // presentation proves a transcript with an unnamed server.
    if (typeof out.serverName !== "string" || out.serverName.length === 0) {
        return refuse("presentation omits the server identity proof")
    }
    if (out.verifyingKey.alg !== "k256") {
        return refuse(`notary key algorithm ${out.verifyingKey.alg} is not k256`)
    }
    if (!isTrustedNotaryKey(clock.height, out.verifyingKey.alg, out.verifyingKey.hex)) {
        return refuse("presentation is not signed by a notary key the chain trusts at this height")
    }
    if (out.attestationVersionIsCurrent !== true) {
        return refuse("attestation header version is not the one the chain verifies")
    }
    if (!/^[0-9a-f]{2,128}$/.test(out.attestationId)) {
        return refuse("attestation id is malformed")
    }

    // The notary's clock is the only time source the attestation has; it is
    // judged against the block, and a notary running ahead must not mint
    // attestations that stay fresh for longer than the window.
    if (!Number.isSafeInteger(out.time)) {
        return refuse("attested time is not an integer")
    }
    if (out.time < clock.blockTimeSec - params.freshnessWindowSec) {
        return refuse(
            `attestation is stale: attested at ${out.time}, more than ${params.freshnessWindowSec}s before the block time ${clock.blockTimeSec}`,
        )
    }
    if (out.time > clock.blockTimeSec + params.futureSkewSec) {
        return refuse(
            `attestation is from the future: attested at ${out.time}, more than ${params.futureSkewSec}s after the block time ${clock.blockTimeSec}`,
        )
    }

    const transcript = transcriptOf(out)
    if (!transcript) {
        throw new TlsnVerifierUnavailableError("verifier output has inconsistent transcript ranges")
    }

    return {
        ok: true,
        presentation: {
            attestationId: out.attestationId,
            serverName: out.serverName,
            time: out.time,
            verifyingKey: { alg: out.verifyingKey.alg, hex: out.verifyingKey.hex },
            ...transcript,
        },
    }
}

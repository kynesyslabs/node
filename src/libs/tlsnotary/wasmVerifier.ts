/**
 * Loader for the deterministic TLSNotary presentation verifier
 * (native/tlsn-verify, tlsn v0.1.0-alpha.12, wasm32 with no host imports).
 *
 * The verifier runs inside block apply, so every rule here exists to keep
 * the verdict identical on every node:
 * - the wasm must hash to the pinned value, or it is not loaded at all;
 * - every call runs in a fresh instance, so the verdict cannot depend on the
 *   heap state earlier calls left behind (a near-limit allocation could
 *   otherwise pass on one node and fail on another);
 * - a wasm trap (panic, or an allocation past the 64 MiB cap a crafted
 *   presentation can force during decode) is a refusal, never a throw; a
 *   failure that depends on the host (instance or stack exhaustion) throws,
 *   because it is no verdict at all;
 * - the root store is the compiled-in one; a test root needs the separate,
 *   explicitly named verifyWithTestRoot;
 * - a refusal carries no reason: error texts are not stable between runs, so
 *   they reach only the optional log hook, never the result.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** sha256 of native/tlsn-verify/dist/demos_tlsn_verify.wasm. */
export const TLSN_VERIFY_WASM_SHA256 =
    "5ed9774dd485266227b633504beba4cb3bed47c26af01b817ed128ce8517e455"

export const TLSN_VERIFY_WASM_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../native/tlsn-verify/dist/demos_tlsn_verify.wasm",
)

export const TLSN_VERIFY_ABI_VERSION = 1

/** Same cap as the wasm (tv_max_input); checked before any copy into it. */
export const TLSN_MAX_PRESENTATION_BYTES = 1 << 20

/** A test root certificate is small; anything larger is not one. */
const MAX_PINNED_ROOT_BYTES = 16 << 10

/** Facts of a verified presentation, exactly as the wasm emits them. */
export interface TlsnVerifiedPresentation {
    ok: true
    /** Notary-chosen id in the signed header: the replay/uniqueness key. */
    attestationId: string
    attestationVersionIsCurrent: boolean
    signatureAlg: string
    /** alg is "k256" (33-byte compressed) or "p256" (65-byte uncompressed). */
    verifyingKey: { alg: string; hex: string }
    /** Null when the identity proof is omitted; policy must refuse that. */
    serverName: string | null
    /** Notary-attested connection time, unix seconds. */
    time: number
    tlsVersion: string
    transcriptLength: { sent: number; received: number }
    /** Hex; bytes outside the authed ranges are zero, never real data. */
    sent: string | null
    sentAuthed: [number, number][] | null
    recv: string | null
    recvAuthed: [number, number][] | null
    extensions: number
}

export type TlsnVerifyResult =
    | {
          ok: true
          out: TlsnVerifiedPresentation
          /** The exact JSON bytes the wasm produced (UTF-8 decoded). */
          raw: string
      }
    | { ok: false }

export interface TlsnVerifyOptions {
    /** Receives the refusal reason for logs. Never a consensus value. */
    onRefusal?: (reason: string) => void
}

export interface TlsnVerifierLoadOptions {
    wasmPath?: string
    /** Bytes to load instead of reading wasmPath (tests). */
    wasmBytes?: Uint8Array
    expectedSha256?: string
}

export class TlsnVerifierLoadError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "TlsnVerifierLoadError"
    }
}

/**
 * The verifier could not run on this node (instance or stack exhaustion, an
 * engine error), so there is no verdict. Not a refusal: other nodes may well
 * verify the same bytes, so the caller must not vote on them.
 */
export class TlsnVerifierUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "TlsnVerifierUnavailableError"
    }
}

// Names are fixed by the wasm's C ABI.
/* eslint-disable @typescript-eslint/naming-convention */
interface VerifierExports {
    memory: WebAssembly.Memory
    tv_abi_version(): number
    tv_max_input(): number
    tv_alloc(len: number): number
    tv_free(ptr: number, len: number): void
    tv_verify(pPtr: number, pLen: number, rPtr: number, rLen: number): number
    tv_out_ptr(): number
    tv_out_len(): number
}
/* eslint-enable @typescript-eslint/naming-convention */

const REQUIRED_EXPORTS = [
    "memory",
    "tv_abi_version",
    "tv_max_input",
    "tv_alloc",
    "tv_free",
    "tv_verify",
    "tv_out_ptr",
    "tv_out_len",
]

const REFUSED: { ok: false } = Object.freeze({ ok: false as const })

function readOut(e: VerifierExports): string | null {
    try {
        const ptr = e.tv_out_ptr()
        const len = e.tv_out_len()
        return new TextDecoder("utf-8", { fatal: true }).decode(
            new Uint8Array(e.memory.buffer, ptr, len).slice(),
        )
    } catch {
        return null
    }
}

/** The `error` field of a refusal JSON, for logs. */
function refusalText(raw: string | null): string {
    if (raw === null) return "unreadable"
    try {
        const v = JSON.parse(raw) as { error?: unknown }
        return typeof v.error === "string" ? v.error : raw
    } catch {
        return raw
    }
}

function isVerifiedShape(v: unknown): v is TlsnVerifiedPresentation {
    if (!v || typeof v !== "object") return false
    const o = v as Record<string, unknown>
    const key = o.verifyingKey as Record<string, unknown> | null
    return (
        o.ok === true &&
        typeof o.attestationId === "string" &&
        typeof o.time === "number" &&
        !!key &&
        typeof key.alg === "string" &&
        typeof key.hex === "string"
    )
}

export class TlsnWasmVerifier {
    private constructor(private readonly module: WebAssembly.Module) {}

    /**
     * Loads and checks the verifier. Throws TlsnVerifierLoadError when the
     * bytes do not hash to the pinned value or the module is not the
     * expected one: a node that cannot load the pinned verifier must not
     * judge TLSN presentations at all, rather than refuse every one of them.
     */
    static load(opts: TlsnVerifierLoadOptions = {}): TlsnWasmVerifier {
        const expected = opts.expectedSha256 ?? TLSN_VERIFY_WASM_SHA256
        let bytes: Uint8Array
        try {
            bytes = opts.wasmBytes ?? readFileSync(opts.wasmPath ?? TLSN_VERIFY_WASM_PATH)
        } catch (err) {
            throw new TlsnVerifierLoadError(
                `cannot read TLSN verifier wasm: ${(err as Error).message}`,
            )
        }
        const actual = createHash("sha256").update(bytes).digest("hex")
        if (actual !== expected) {
            throw new TlsnVerifierLoadError(
                `TLSN verifier wasm sha256 ${actual} does not match the pinned ${expected}`,
            )
        }
        let module: WebAssembly.Module
        try {
            module = new WebAssembly.Module(new Uint8Array(bytes))
        } catch (err) {
            throw new TlsnVerifierLoadError(`TLSN verifier wasm does not compile: ${(err as Error).message}`)
        }
        // The pinned hash already fixes these; checking them keeps a wrong
        // pin (or a test override) from running a module with host access.
        const imports = WebAssembly.Module.imports(module)
        if (imports.length !== 0) {
            throw new TlsnVerifierLoadError(
                `TLSN verifier wasm has ${imports.length} host imports, expected none`,
            )
        }
        const names = new Set(WebAssembly.Module.exports(module).map(x => x.name))
        const missing = REQUIRED_EXPORTS.filter(n => !names.has(n))
        if (missing.length) {
            throw new TlsnVerifierLoadError(
                `TLSN verifier wasm lacks exports: ${missing.join(", ")}`,
            )
        }
        const verifier = new TlsnWasmVerifier(module)
        let abi: number
        let cap: number
        try {
            const e = verifier.instantiate()
            abi = e.tv_abi_version()
            cap = e.tv_max_input()
        } catch (err) {
            throw new TlsnVerifierLoadError(`TLSN verifier wasm does not start: ${(err as Error).message}`)
        }
        if (abi !== TLSN_VERIFY_ABI_VERSION) {
            throw new TlsnVerifierLoadError(
                `TLSN verifier ABI ${abi}, expected ${TLSN_VERIFY_ABI_VERSION}`,
            )
        }
        if (cap !== TLSN_MAX_PRESENTATION_BYTES) {
            throw new TlsnVerifierLoadError(
                `TLSN verifier input cap ${cap}, expected ${TLSN_MAX_PRESENTATION_BYTES}`,
            )
        }
        return verifier
    }

    private instantiate(): VerifierExports {
        return new WebAssembly.Instance(this.module, {}).exports as unknown as VerifierExports
    }

    /**
     * Verifies serialized presentation bytes against the compiled-in root
     * store. Every refusal, including a wasm trap, is `{ ok: false }`.
     * Throws only TlsnVerifierUnavailableError, when this node could not run
     * the verifier at all and so has no verdict.
     */
    verifyPresentation(bytes: Uint8Array, opts: TlsnVerifyOptions = {}): TlsnVerifyResult {
        return this.run(bytes, undefined, opts)
    }

    /**
     * Same, with the root store replaced by exactly one DER root. For the
     * local test vectors, whose server uses a test CA; consensus code must
     * use verifyPresentation.
     */
    verifyWithTestRoot(
        bytes: Uint8Array,
        rootDer: Uint8Array,
        opts: TlsnVerifyOptions = {},
    ): TlsnVerifyResult {
        if (!(rootDer instanceof Uint8Array) || rootDer.length === 0) {
            throw new TypeError("verifyWithTestRoot needs a DER root")
        }
        if (rootDer.length > MAX_PINNED_ROOT_BYTES) {
            throw new TypeError("verifyWithTestRoot: root too large")
        }
        return this.run(bytes, rootDer, opts)
    }

    private run(
        bytes: Uint8Array,
        root: Uint8Array | undefined,
        opts: TlsnVerifyOptions,
    ): TlsnVerifyResult {
        const refuse = (reason: string): { ok: false } => {
            if (opts.onRefusal) {
                try {
                    opts.onRefusal(reason)
                } catch {
                    // A log hook must not turn a refusal into a throw.
                }
            }
            return REFUSED
        }

        if (!(bytes instanceof Uint8Array)) return refuse("input: not bytes")
        if (bytes.length === 0) return refuse("input: empty")
        if (bytes.length > TLSN_MAX_PRESENTATION_BYTES) {
            return refuse(`input: too_large ${bytes.length} bytes`)
        }

        let e: VerifierExports
        try {
            e = this.instantiate()
        } catch (err) {
            throw new TlsnVerifierUnavailableError(`instantiate: ${(err as Error).message}`)
        }

        let verified: number
        try {
            const pPtr = e.tv_alloc(bytes.length)
            new Uint8Array(e.memory.buffer, pPtr, bytes.length).set(bytes)
            let rPtr = 0
            let rLen = 0
            if (root) {
                rLen = root.length
                rPtr = e.tv_alloc(rLen)
                new Uint8Array(e.memory.buffer, rPtr, rLen).set(root)
            }
            verified = e.tv_verify(pPtr, bytes.length, rPtr, rLen)
        } catch (err) {
            // Only a wasm trap (panic=abort, or an allocation past the memory
            // cap) follows from the input alone. Anything else, such as a
            // RangeError from stack exhaustion, depends on this host.
            if (!(err instanceof WebAssembly.RuntimeError)) {
                throw new TlsnVerifierUnavailableError(`verify: ${(err as Error)?.message ?? String(err)}`)
            }
            // The instance is dropped here; the next call gets a new one.
            const text = refusalText(readOut(e))
            return refuse(text.startsWith("trap") ? text : `trap: ${text}`)
        }

        const raw = readOut(e)
        if (raw === null) return refuse("output: unreadable")
        if (verified !== 1) return refuse(refusalText(raw))
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            return refuse("output: not JSON")
        }
        if (!isVerifiedShape(parsed)) return refuse("output: unexpected shape")
        return { ok: true, out: parsed, raw }
    }
}

let defaultVerifier: TlsnWasmVerifier | null = null

/**
 * Loads the pinned verifier once. Call at startup to fail fast; throws
 * TlsnVerifierLoadError like TlsnWasmVerifier.load.
 */
export function loadTlsnVerifier(): TlsnWasmVerifier {
    if (!defaultVerifier) defaultVerifier = TlsnWasmVerifier.load()
    return defaultVerifier
}

/**
 * Verifies serialized presentation bytes (bincode, the `data` field of a
 * tlsn-js presentation) with the pinned verifier and the compiled-in root
 * store. Refusals are `{ ok: false }`. Throws TlsnVerifierLoadError when the
 * pinned verifier cannot be loaded and TlsnVerifierUnavailableError when it
 * cannot run on this node: in both cases the node has no verdict.
 */
export function verifyPresentation(
    bytes: Uint8Array,
    opts: TlsnVerifyOptions = {},
): TlsnVerifyResult {
    return loadTlsnVerifier().verifyPresentation(bytes, opts)
}

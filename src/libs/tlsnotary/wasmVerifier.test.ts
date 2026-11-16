import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
    TLSN_MAX_PRESENTATION_BYTES,
    TLSN_VERIFY_WASM_PATH,
    TLSN_VERIFY_WASM_SHA256,
    TlsnVerifierLoadError,
    TlsnVerifierUnavailableError,
    TlsnWasmVerifier,
    type TlsnVerifyOptions,
    verifyPresentation,
} from "./wasmVerifier"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const VECTORS = join(REPO, "testing/tlsn-vectors")

interface VectorMeta {
    description: string
    root: string | null
    verifier: "ok" | "refused"
    nodePolicy: "accept" | "refuse"
    /** Refusal class (the fixed prefix of the log reason) and a stable phase. */
    refusal?: { class: "decode" | "verify" | "trap"; contains?: string }
    sameOutputAs?: string
}

interface Vector {
    name: string
    meta: VectorMeta
    bytes: Uint8Array
    root: Uint8Array | undefined
    output: Buffer | null
}

function loadVectors(): Vector[] {
    return readdirSync(VECTORS)
        .filter(n => existsSync(join(VECTORS, n, "presentation.bin")))
        .sort()
        .map(name => {
            const dir = join(VECTORS, name)
            const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as VectorMeta
            const outPath = join(dir, "output.json")
            return {
                name,
                meta,
                bytes: new Uint8Array(readFileSync(join(dir, "presentation.bin"))),
                root: meta.root ? new Uint8Array(readFileSync(join(VECTORS, meta.root))) : undefined,
                output: existsSync(outPath) ? readFileSync(outPath) : null,
            }
        })
}

const vectors = loadVectors()
const byName = (n: string) => vectors.find(v => v.name === n)!
const verifier = TlsnWasmVerifier.load()

function run(v: Vector, inst: TlsnWasmVerifier = verifier, opts: TlsnVerifyOptions = {}) {
    return v.root
        ? inst.verifyWithTestRoot(v.bytes, v.root, opts)
        : inst.verifyPresentation(v.bytes, opts)
}

describe("pinned wasm", () => {
    it("the committed .sha256 file, the wasm and the TS pin agree", () => {
        const wasm = readFileSync(TLSN_VERIFY_WASM_PATH)
        const pinFile = readFileSync(`${TLSN_VERIFY_WASM_PATH}.sha256`, "utf8").trim()
        expect(pinFile).toBe(`${TLSN_VERIFY_WASM_SHA256}  demos_tlsn_verify.wasm`)
        expect(createHash("sha256").update(wasm).digest("hex")).toBe(TLSN_VERIFY_WASM_SHA256)
    })

    it("has no host imports, so it cannot read a clock, RNG, files or the network", () => {
        const module = new WebAssembly.Module(readFileSync(TLSN_VERIFY_WASM_PATH))
        expect(WebAssembly.Module.imports(module)).toEqual([])
    })

    it("refuses to load bytes that do not match the pin", () => {
        const tampered = new Uint8Array(readFileSync(TLSN_VERIFY_WASM_PATH))
        tampered[tampered.length - 1] ^= 0x01
        expect(() => TlsnWasmVerifier.load({ wasmBytes: tampered })).toThrow(TlsnVerifierLoadError)
        expect(() => TlsnWasmVerifier.load({ expectedSha256: "00".repeat(32) })).toThrow(
            TlsnVerifierLoadError,
        )
        expect(() => TlsnWasmVerifier.load({ wasmPath: join(VECTORS, "missing.wasm") })).toThrow(
            TlsnVerifierLoadError,
        )
    })
})

describe("golden vectors", () => {
    it("covers accepted, refused and trap cases", () => {
        expect(vectors.length).toBeGreaterThanOrEqual(14)
        expect(vectors.some(v => v.meta.verifier === "ok")).toBe(true)
        expect(vectors.some(v => v.meta.verifier === "refused")).toBe(true)
    })

    for (const v of vectors) {
        it(`${v.name}: ${v.meta.verifier}`, () => {
            const reasons: string[] = []
            const r = run(v, verifier, { onRefusal: reason => reasons.push(reason) })
            if (v.meta.verifier === "ok") {
                expect(r.ok).toBe(true)
                if (!r.ok) return
                // Byte-identical to the committed output, not just equal JSON.
                expect(Buffer.from(r.raw, "utf8").equals(v.output!)).toBe(true)
                expect(r.out.attestationId).toMatch(/^[0-9a-f]{32}$/)
            } else {
                expect(v.output).toBeNull()
                // No reason, no error text: only the verdict is a consensus value.
                expect(r).toEqual({ ok: false })
                expect(Object.keys(r)).toEqual(["ok"])
                // Refused for the reason the vector is named for, not any.
                expect(reasons).toHaveLength(1)
                expect(reasons[0].split(":")[0]).toBe(v.meta.refusal!.class)
                if (v.meta.refusal!.contains) expect(reasons[0]).toContain(v.meta.refusal!.contains)
            }
        })
    }

    it("a malleated presentation gives the same output as its original (F3)", () => {
        const m = byName("malleable-flip")
        const base = byName(m.meta.sameOutputAs!)
        expect(Buffer.from(m.bytes).equals(Buffer.from(base.bytes))).toBe(false)
        expect(m.output!.equals(base.output!)).toBe(true)
    })

    it("reports both key algorithms and a null server name without judging them", () => {
        const p256 = run(byName("valid-local"))
        const k256 = run(byName("valid-local-k256"))
        const noIdent = run(byName("no-server-identity"))
        expect(p256.ok && p256.out.verifyingKey.alg).toBe("p256")
        expect(p256.ok && p256.out.verifyingKey.hex).toMatch(/^04[0-9a-f]{128}$/)
        expect(k256.ok && k256.out.verifyingKey.alg).toBe("k256")
        expect(k256.ok && k256.out.verifyingKey.hex).toMatch(/^0[23][0-9a-f]{64}$/)
        expect(noIdent.ok && noIdent.out.serverName).toBeNull()
    })

    it("checks the certificate at the attested time, long after the leaf expired", () => {
        // The valid-local leaf was valid for 10 minutes on the day of the spike.
        const r = run(byName("valid-local"))
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.out.time).toBeLessThan(Math.floor(Date.now() / 1000) - 600)
    })

    it("uses the compiled-in root store unless a root is pinned", () => {
        const local = byName("valid-local")
        expect(verifier.verifyPresentation(local.bytes).ok).toBe(false)
        expect(byName("valid-github").root).toBeUndefined()
        expect(run(byName("valid-github")).ok).toBe(true)
    })
})

describe("refusals never escape as throws", () => {
    it("the allocation bomb traps into a refusal and the process keeps working (F1)", () => {
        const bomb = byName("alloc-bomb-recv-total")
        const reasons: string[] = []
        const r = run(bomb, verifier, { onRefusal: reason => reasons.push(reason) })
        expect(r).toEqual({ ok: false })
        expect(reasons).toHaveLength(1)
        expect(reasons[0]).toStartWith("trap: ")
        expect(reasons[0]).not.toStartWith("trap: trap")

        const valid = byName("valid-local")
        const after = run(valid)
        expect(after.ok && Buffer.from(after.raw).equals(valid.output!)).toBe(true)
    })

    it("refuses oversize, empty and non-byte input before entering the wasm", () => {
        const reasons: string[] = []
        const onRefusal = (r: string) => reasons.push(r)
        expect(
            verifier.verifyPresentation(new Uint8Array(TLSN_MAX_PRESENTATION_BYTES + 1), { onRefusal }),
        ).toEqual({ ok: false })
        expect(verifier.verifyPresentation(new Uint8Array(0), { onRefusal })).toEqual({ ok: false })
        expect(
            verifier.verifyPresentation("00" as unknown as Uint8Array, { onRefusal }),
        ).toEqual({ ok: false })
        expect(reasons).toEqual(["input: too_large 1048577 bytes", "input: empty", "input: not bytes"])
    })

    it("near the host stack limit a call verifies or throws, never refuses", () => {
        // Stack depth depends on the engine and the caller, so a stack
        // overflow is no verdict: it must not come back as { ok: false }.
        const v = byName("valid-local")
        const outcomes: ("ok" | "refused" | "threw")[] = []
        const attempt = () => {
            try {
                const r = run(v)
                if (r.ok) expect(Buffer.from(r.raw).equals(v.output!)).toBe(true)
                outcomes.push(r.ok ? "ok" : "refused")
            } catch (err) {
                expect(
                    err instanceof RangeError || err instanceof TlsnVerifierUnavailableError,
                ).toBe(true)
                outcomes.push("threw")
            }
        }
        const recurse = (): void => {
            try {
                recurse()
            } catch (err) {
                attempt()
                // Retry at each of the next frames up, closer to the limit's edge.
                if (outcomes.length < 200) throw err
            }
        }
        try {
            recurse()
        } catch {
            // The last rethrow after enough attempts.
        }
        expect(outcomes).toHaveLength(200)
        expect(outcomes).not.toContain("refused")
        expect(outcomes).toContain("threw")
        expect(run(v).ok).toBe(true)
    })

    it("a test root must be given explicitly", () => {
        const v = byName("valid-local")
        expect(() => verifier.verifyWithTestRoot(v.bytes, new Uint8Array(0))).toThrow(TypeError)
        expect(() => verifier.verifyWithTestRoot(v.bytes, new Uint8Array(32 << 10))).toThrow(TypeError)
    })

    it("a throwing log hook does not turn a refusal into a throw", () => {
        const r = verifier.verifyPresentation(byName("truncated").bytes, {
            onRefusal: () => {
                throw new Error("log sink down")
            },
        })
        expect(r).toEqual({ ok: false })
    })

    it("single-byte flips are refused or give the identical output, never other facts", () => {
        const v = byName("valid-local")
        let refused = 0
        let same = 0
        for (let off = 0; off < v.bytes.length; off += 13) {
            const m = v.bytes.slice()
            m[off] ^= 0x01
            const r = verifier.verifyWithTestRoot(m, v.root!)
            if (!r.ok) refused++
            else {
                expect(Buffer.from(r.raw).equals(v.output!)).toBe(true)
                same++
            }
        }
        expect(refused).toBeGreaterThan(0)
        expect(refused + same).toBe(Math.ceil(v.bytes.length / 13))
    })
})

describe("determinism", () => {
    it("repeat calls and fresh verifiers give identical bytes, whatever ran before", () => {
        const accepted = vectors.filter(v => v.meta.verifier === "ok")
        const bomb = byName("alloc-bomb-recv-total")
        const others = [TlsnWasmVerifier.load(), TlsnWasmVerifier.load()]
        for (const v of accepted) {
            for (let i = 0; i < 5; i++) {
                // A trap and a large refusal in between must not change the result.
                run(bomb)
                const r = run(v)
                expect(r.ok && Buffer.from(r.raw).equals(v.output!)).toBe(true)
            }
            for (const other of others) {
                const r = run(v, other)
                expect(r.ok && Buffer.from(r.raw).equals(v.output!)).toBe(true)
            }
        }
    })

    it("the module-level verifyPresentation uses the pinned verifier", () => {
        const v = byName("valid-github")
        const r = verifyPresentation(v.bytes)
        expect(r.ok && Buffer.from(r.raw).equals(v.output!)).toBe(true)
    })
})

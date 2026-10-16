import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { L2PS_ZK_DIR, ZK_IDENTITY_VKEY } from "./context"
import { sameJson } from "./l2ps"
import { trimTrailingSlashes } from "./validate"

export const BATCH_SIZES = [5, 10] as const
export type BatchSize = (typeof BATCH_SIZES)[number]

// Power of Tau file per circuit size; same pairing as setup_all_batches.sh.
const PTAU_POWER: Record<BatchSize, number> = { 5: 16, 10: 17 }
const PTAU_MIN_BYTES = 1_000_000

// The committed verification keys only match files from the Hermez ceremony,
// and the hosts serving them can disappear. Each one is tried in turn and the
// list can be replaced with --ptau-url, so a dead host never blocks the setup.
export const PTAU_BASE_URLS = [
    "https://storage.googleapis.com/zkevm/ptau",
    "https://hermez.s3-eu-west-1.amazonaws.com",
]

export interface BatchArtifacts {
    size: BatchSize
    zkey: boolean
    wasm: boolean
    vkey: boolean
    complete: boolean
}

export interface IdentityKeyState {
    state: "ok" | "missing" | "invalid"
    detail: string
}

const batchDir = (root: string, size: BatchSize) =>
    path.join(root, L2PS_ZK_DIR, "keys", `batch_${size}`)

/** A file that exists and holds something: an empty one is a copy that was cut short. */
const nonEmptyFile = (file: string): boolean => {
    try {
        return fs.statSync(file).size > 0
    } catch {
        return false
    }
}

/** Same files the prover needs at proof time: zkey + wasm, and the vkey to verify. */
export function inspectBatchArtifacts(root: string): BatchArtifacts[] {
    return BATCH_SIZES.map(size => {
        const dir = batchDir(root, size)
        const zkey = nonEmptyFile(path.join(dir, `l2ps_batch_${size}.zkey`))
        const wasm = nonEmptyFile(
            path.join(dir, `l2ps_batch_${size}_js`, `l2ps_batch_${size}.wasm`),
        )
        const vkey = fs.existsSync(path.join(dir, "verification_key.json"))
        return { size, zkey, wasm, vkey, complete: zkey && wasm && vkey }
    })
}

/**
 * SHA-256 of the identity verification key committed in this release, over its
 * canonical JSON (keys sorted, layout ignored). The file cannot be compared with
 * itself, so the release carries this digest: a well-formed but different key
 * (an edit, a key from another build) would otherwise pass the shape check and
 * make this validator reject proofs its peers accept. Changing the key means
 * changing this digest in the same commit; a test fails when they disagree.
 */
export const IDENTITY_CIRCUIT_DIGEST = "246abe5d7da79c64925375dd3e7360e82fa38e93a657132351e93461b407d622"

/**
 * A key rotation done on purpose (`zk:setup`, `zk:ceremony`) rewrites the
 * committed file, and every validator of the network must then run the same
 * new key. This variable replaces the release's digest so such a node can
 * start; it never relaxes the check to "any key".
 */
export const IDENTITY_DIGEST_ENV = "DEMOS_ZK_IDENTITY_KEY_DIGEST"

const SHA256_HEX = /^[0-9a-f]{64}$/

/** The digest the key must have, and whether the operator replaced the release's. Throws on a malformed override. */
export function expectedIdentityDigest(
    env: Record<string, string | undefined>,
): { digest: string; overridden: boolean } {
    const raw = env[IDENTITY_DIGEST_ENV]?.trim()
    if (raw === undefined || raw === "") return { digest: IDENTITY_CIRCUIT_DIGEST, overridden: false }
    const digest = raw.toLowerCase()
    if (!SHA256_HEX.test(digest)) {
        throw new Error(`${IDENTITY_DIGEST_ENV} must be a 64-character hex SHA-256 digest (got ${raw.length} characters)`)
    }
    return { digest, overridden: true }
}

/** Code-point order: the digest must not depend on the machine's locale. */
const byCodePoint = (a: string, b: string): number => {
    if (a === b) return 0
    return a < b ? -1 : 1
}

const sortedDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortedDeep)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
        Object.keys(value as object)
            .sort(byCodePoint)
            .map(k => [k, sortedDeep((value as Record<string, unknown>)[k])]),
    )
}

export function canonicalDigest(jsonText: string): string {
    return crypto.createHash("sha256").update(JSON.stringify(sortedDeep(JSON.parse(jsonText)))).digest("hex")
}

/**
 * The identity circuit needs only its committed verification key on a node;
 * the proving key lives with the client. It is consensus-critical, so it is
 * checked here but never regenerated.
 */
export function inspectIdentityKey(
    root: string,
    env: Record<string, string | undefined> = {},
): IdentityKeyState {
    let expected: ReturnType<typeof expectedIdentityDigest>
    try {
        expected = expectedIdentityDigest(env)
    } catch (e) {
        return { state: "invalid", detail: e instanceof Error ? e.message : String(e) }
    }
    const file = path.join(root, ZK_IDENTITY_VKEY)
    if (!fs.existsSync(file)) {
        return { state: "missing", detail: `${ZK_IDENTITY_VKEY} not found` }
    }
    try {
        const text = fs.readFileSync(file, "utf8")
        const vk = JSON.parse(text)
        if (vk.protocol !== "groth16" || !vk.vk_alpha_1 || !vk.IC) {
            return {
                state: "invalid",
                detail: "file is not a groth16 verification key",
            }
        }
        if (canonicalDigest(text) !== expected.digest) {
            return {
                state: "invalid",
                detail: expected.overridden
                    ? `does not match the digest in ${IDENTITY_DIGEST_ENV}`
                    : `does not match the verification key committed in this release (modified, or from another build; after a deliberate key rotation set ${IDENTITY_DIGEST_ENV} to the new key's digest)`,
            }
        }
        return {
            state: "ok",
            detail: expected.overridden
                ? `verification key present (pinned by ${IDENTITY_DIGEST_ENV})`
                : "verification key present",
        }
    } catch (e) {
        return {
            state: "invalid",
            detail: `not valid JSON (${e instanceof Error ? e.message : e})`,
        }
    }
}

export interface ZkRunner {
    download(url: string, dest: string, minBytes: number): Promise<void>
    exec(cmd: string, args: string[], cwd: string): Promise<number>
}

export interface ZkSetupResult {
    ok: boolean
    messages: string[]
}

export async function downloadWithFetch(
    url: string,
    dest: string,
    minBytes: number,
): Promise<void> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < minBytes) {
        throw new Error(`download of ${url} is too small (${buf.length} bytes)`)
    }
    const tmp = `${dest}.part`
    try {
        fs.writeFileSync(tmp, buf)
        fs.renameSync(tmp, dest)
    } catch (e) {
        // A cut-off write must not leave a partial file next to the real one.
        fs.rmSync(tmp, { force: true })
        throw e
    }
}

function vkeyParses(root: string, size: BatchSize): boolean {
    try {
        JSON.parse(fs.readFileSync(path.join(batchDir(root, size), "verification_key.json"), "utf8"))
        return true
    } catch {
        return false
    }
}

export function missingZkTools(root: string): string[] {
    const need = [
        path.join("node_modules", ".bin", "circom2"),
        path.join("node_modules", ".bin", "snarkjs"),
        path.join("node_modules", "circomlib", "circuits"),
    ]
    return need.filter(rel => !fs.existsSync(path.join(root, rel)))
}

/**
 * Puts a finished circuit directory and proving key at their final paths. The
 * new files are first renamed to a temporary name next to their destination, so
 * nothing at the final paths changes until both are ready. The old files are
 * then moved aside (the batch reads as unfinished from here until the very last
 * step, so a process killed halfway never leaves a new circuit next to an old
 * key), the new ones are renamed in, and only then are the old ones deleted. A
 * failed step puts the old files back; the previous keys survive.
 */
export function swapIntoPlace(
    newWasmDir: string,
    wasmDir: string,
    newZkey: string,
    zkey: string,
    rename: (from: string, to: string) => void = fs.renameSync,
): void {
    const pairs: Array<{ fresh: string; final: string; next: string; old: string }> = [
        { fresh: newWasmDir, final: wasmDir, next: `${wasmDir}.next`, old: `${wasmDir}.old` },
        { fresh: newZkey, final: zkey, next: `${zkey}.next`, old: `${zkey}.old` },
    ]
    const undo: Array<() => void> = []
    try {
        for (const p of pairs) {
            fs.rmSync(p.next, { recursive: true, force: true })
            fs.rmSync(p.old, { recursive: true, force: true })
            rename(p.fresh, p.next)
            undo.push(() => fs.rmSync(p.next, { recursive: true, force: true }))
        }
        const hadOld = new Set<string>()
        for (const p of pairs) {
            if (fs.existsSync(p.final)) {
                hadOld.add(p.final)
                rename(p.final, p.old)
                undo.push(() => {
                    fs.rmSync(p.final, { recursive: true, force: true })
                    rename(p.old, p.final)
                })
            }
        }
        for (const p of pairs) {
            rename(p.next, p.final)
            // With nothing to restore, a half-installed new file must go.
            if (!hadOld.has(p.final)) undo.push(() => fs.rmSync(p.final, { recursive: true, force: true }))
        }
    } catch (e) {
        for (const step of [...undo].reverse()) {
            try {
                step()
            } catch {
                /* keep restoring the rest */
            }
        }
        throw e
    }
    for (const p of pairs) fs.rmSync(p.old, { recursive: true, force: true })
}

/**
 * Builds the L2PS batch circuits (compile, PLONK setup, vkey export) with the
 * circom2 and snarkjs already in node_modules, so no native circom is needed.
 * The vkey it derives must equal the committed one: peers verify our proofs
 * with that file, so a mismatch is reported instead of overwriting it.
 */
export async function runL2psZkSetup(
    root: string,
    runner: ZkRunner,
    say: (line: string) => void,
    sizes: readonly BatchSize[] = BATCH_SIZES,
    ptauBaseUrls: readonly string[] = PTAU_BASE_URLS,
): Promise<ZkSetupResult> {
    const messages: string[] = []
    const unknown = sizes.filter(size => PTAU_POWER[size] === undefined)
    if (unknown.length > 0) {
        messages.push(`No circuit is configured for a batch of ${unknown.join(", ")}; the setup knows ${BATCH_SIZES.join(" and ")}.`)
        return { ok: false, messages }
    }
    const zkDir = path.join(root, L2PS_ZK_DIR)
    const ptauDir = path.join(zkDir, "ptau")
    const circomlib = path.join(root, "node_modules", "circomlib", "circuits")
    const circom2 = path.join(root, "node_modules", ".bin", "circom2")
    const snarkjs = path.join(root, "node_modules", ".bin", "snarkjs")
    fs.mkdirSync(ptauDir, { recursive: true })

    const existing = inspectBatchArtifacts(root)
    for (const size of sizes) {
        const have = existing.find(b => b.size === size)
        if (have?.complete && vkeyParses(root, size)) {
            say(`batch_${size} is already built, skipping`)
            messages.push(`batch_${size}: already built`)
            continue
        }
        const power = PTAU_POWER[size]
        const ptauName = `powersOfTau28_hez_final_${power}.ptau`
        const ptau = path.join(ptauDir, ptauName)
        if (
            !fs.existsSync(ptau) ||
            fs.statSync(ptau).size < PTAU_MIN_BYTES
        ) {
            say(`Downloading ${ptauName} (public Powers of Tau file)...`)
            const errors: string[] = []
            let got = false
            for (const base of ptauBaseUrls) {
                try {
                    await runner.download(
                        `${trimTrailingSlashes(base)}/${ptauName}`,
                        ptau,
                        PTAU_MIN_BYTES,
                    )
                    got = true
                    break
                } catch (e) {
                    errors.push(e instanceof Error ? e.message : String(e))
                }
            }
            if (!got) {
                messages.push(
                    `Could not download ${ptauName} (${errors.join("; ")}). Get it from another mirror of the Hermez Powers of Tau ceremony and save it as ${ptau}, or pass --ptau-url <base url>; then run the setup again.`,
                )
                return { ok: false, messages }
            }
        } else {
            say(`${ptauName} already downloaded`)
        }

        const name = `l2ps_batch_${size}`
        const out = batchDir(root, size)
        fs.mkdirSync(out, { recursive: true })
        // Everything is built in a staging directory and moved into place only
        // after the whole batch succeeded and its verification key matched. A
        // failure halfway can then never leave behind a wasm that makes an old
        // zkey look like a finished build.
        const staging = path.join(out, ".building")
        fs.rmSync(staging, { recursive: true, force: true })
        fs.mkdirSync(staging, { recursive: true })
        const r1cs = path.join(staging, `${name}.r1cs`)
        const zkeyNew = path.join(staging, `${name}.zkey`)
        const generatedVkey = path.join(staging, "verification_key.json")
        const zkey = path.join(out, `${name}.zkey`)
        const wasmDirName = `${name}_js`
        const committedVkey = path.join(out, "verification_key.json")
        const abandon = () => fs.rmSync(staging, { recursive: true, force: true })
        try {
            const steps: Array<[string, string, string[]]> = [
                [
                    `Compiling ${name}`,
                    circom2,
                    [
                        path.join(zkDir, "circuits", `${name}.circom`),
                        "--r1cs",
                        "--wasm",
                        "--sym",
                        "-o",
                        staging,
                        "-l",
                        circomlib,
                    ],
                ],
                [
                    `Generating the proving key for ${name}`,
                    snarkjs,
                    ["plonk", "setup", r1cs, ptau, zkeyNew],
                ],
                [
                    `Exporting the verification key for ${name}`,
                    snarkjs,
                    ["zkey", "export", "verificationkey", zkeyNew, generatedVkey],
                ],
            ]
            for (const [label, cmd, args] of steps) {
                say(`${label}...`)
                const code = await runner.exec(cmd, args, root)
                if (code !== 0) {
                    messages.push(`${label} failed (exit code ${code})`)
                    return { ok: false, messages }
                }
            }

            if (!vkeyParses(root, size)) {
                // The verification key is committed and shared by every peer, so a
                // missing or corrupt copy is a broken checkout, not something to
                // replace with a locally generated key that nobody else holds.
                messages.push(
                    `batch_${size}: the committed verification key is missing or unreadable; restore ${path.relative(root, committedVkey)} from the repository and run the setup again`,
                )
                return { ok: false, messages }
            }
            // Compared as data: the same key printed with another key order or
            // layout is still the same key.
            const same = sameJson(
                fs.readFileSync(committedVkey, "utf8"),
                fs.readFileSync(generatedVkey, "utf8"),
            )
            if (!same) {
                // Proofs from this key would be rejected by peers; whatever was
                // there before stays untouched.
                messages.push(
                    `batch_${size}: the verification key built here differs from the committed one, so proofs from it would be rejected by peers. The new proving key was discarded. Update the repository (git pull) and run the setup again.`,
                )
                return { ok: false, messages }
            }
            swapIntoPlace(path.join(staging, wasmDirName), path.join(out, wasmDirName), zkeyNew, zkey)
        } finally {
            // Whatever ended the batch, a staging directory must not outlive it.
            abandon()
        }
        messages.push(`batch_${size}: ready`)
    }
    return { ok: true, messages }
}

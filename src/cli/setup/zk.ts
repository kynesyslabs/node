import * as fs from "node:fs"
import * as path from "node:path"
import { L2PS_ZK_DIR, ZK_IDENTITY_VKEY } from "./context"

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

/** Same files the prover needs at proof time: zkey + wasm, and the vkey to verify. */
export function inspectBatchArtifacts(root: string): BatchArtifacts[] {
    return BATCH_SIZES.map(size => {
        const dir = batchDir(root, size)
        const zkey = fs.existsSync(path.join(dir, `l2ps_batch_${size}.zkey`))
        const wasm = fs.existsSync(
            path.join(dir, `l2ps_batch_${size}_js`, `l2ps_batch_${size}.wasm`),
        )
        const vkey = fs.existsSync(path.join(dir, "verification_key.json"))
        return { size, zkey, wasm, vkey, complete: zkey && wasm && vkey }
    })
}

/**
 * The identity circuit needs only its committed verification key on a node;
 * the proving key lives with the client. It is consensus-critical, so it is
 * checked here but never regenerated.
 */
export function inspectIdentityKey(root: string): IdentityKeyState {
    const file = path.join(root, ZK_IDENTITY_VKEY)
    if (!fs.existsSync(file)) {
        return { state: "missing", detail: `${ZK_IDENTITY_VKEY} not found` }
    }
    try {
        const vk = JSON.parse(fs.readFileSync(file, "utf8"))
        if (vk.protocol !== "groth16" || !vk.vk_alpha_1 || !vk.IC) {
            return {
                state: "invalid",
                detail: "file is not a groth16 verification key",
            }
        }
        return { state: "ok", detail: "verification key present" }
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
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, dest)
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
                        `${base.replace(/\/+$/, "")}/${ptauName}`,
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
        const r1cs = path.join(out, `${name}.r1cs`)
        const zkey = path.join(out, `${name}.zkey`)
        // Built under a temporary name: a good zkey is only ever replaced by a
        // new one that has been checked against the committed key.
        const zkeyTmp = `${zkey}.building`
        const generatedVkey = path.join(out, "verification_key.generated.json")
        const committedVkey = path.join(out, "verification_key.json")

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
                    out,
                    "-l",
                    circomlib,
                ],
            ],
            [
                `Generating the proving key for ${name}`,
                snarkjs,
                ["plonk", "setup", r1cs, ptau, zkeyTmp],
            ],
            [
                `Exporting the verification key for ${name}`,
                snarkjs,
                ["zkey", "export", "verificationkey", zkeyTmp, generatedVkey],
            ],
        ]
        for (const [label, cmd, args] of steps) {
            say(`${label}...`)
            const code = await runner.exec(cmd, args, root)
            if (code !== 0) {
                fs.rmSync(zkeyTmp, { force: true })
                fs.rmSync(generatedVkey, { force: true })
                messages.push(`${label} failed (exit code ${code})`)
                return { ok: false, messages }
            }
        }

        if (!vkeyParses(root, size)) {
            fs.renameSync(generatedVkey, committedVkey)
            messages.push(`batch_${size}: no usable verification key on disk, wrote the generated one`)
        } else {
            const same =
                JSON.stringify(JSON.parse(fs.readFileSync(committedVkey, "utf8"))) ===
                JSON.stringify(JSON.parse(fs.readFileSync(generatedVkey, "utf8")))
            fs.rmSync(generatedVkey, { force: true })
            if (!same) {
                // Proofs from this key would be rejected by peers; any earlier
                // zkey stays untouched.
                fs.rmSync(zkeyTmp, { force: true })
                messages.push(
                    `batch_${size}: the verification key built here differs from the committed one, so proofs from it would be rejected by peers. The new proving key was discarded. Update the repository (git pull) and run the setup again.`,
                )
                return { ok: false, messages }
            }
        }
        fs.renameSync(zkeyTmp, zkey)
        messages.push(`batch_${size}: ready`)
    }
    return { ok: true, messages }
}

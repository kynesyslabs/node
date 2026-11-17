import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Shared fixtures of the notary-service script tests. Every key is made at
 * run time with openssl and lives only in a per-test temp dir, so no key
 * material is committed.
 */

export const SERVICE_DIR = import.meta.dir
export const GUARD = path.join(SERVICE_DIR, "notary-guard.sh")
export const CHECK = path.join(SERVICE_DIR, "notary-check.sh")
export const CEREMONY = path.join(SERVICE_DIR, "notary-key-ceremony.sh")

export const hasTool = (tool: string) =>
    spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).status === 0

export function makeTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

function openssl(args: string[], input?: Buffer | string): Buffer {
    const r = spawnSync("openssl", args, { input })
    if (r.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${r.stderr.toString()}`)
    return r.stdout
}

/** A fresh PKCS#8 PEM key on `curve`, written with mode 0400, and its compressed public key. */
export function makeKey(dir: string, name: string, curve = "secp256k1"): { file: string; pub: string; pem: string } {
    const file = path.join(dir, name)
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", `ec_paramgen_curve:${curve}`, "-out", file])
    fs.chmodSync(file, 0o400)
    return { file, pub: compressedPubOf(file), pem: fs.readFileSync(file, "utf8") }
}

/** The compressed public key openssl derives from a private key file. */
export function compressedPubOf(file: string): string {
    const der = openssl(["pkey", "-in", file, "-pubout", "-outform", "DER", "-ec_conv_form", "compressed"])
    return der.subarray(der.length - 33).toString("hex")
}

/** SubjectPublicKeyInfo PEM of a key file, compressed or not. */
export function spkiPemOf(file: string, form: "compressed" | "uncompressed"): string {
    return openssl(["pkey", "-in", file, "-pubout", "-ec_conv_form", form]).toString()
}

/** Re-encodes a key file with openssl and writes it (mode 0400). */
export function rewriteKey(src: string, dest: string, args: string[]): string {
    const out = openssl([...args, "-in", src])
    fs.writeFileSync(dest, out, { mode: 0o400 })
    return dest
}

/** A key's 32-byte private scalar, hex, to prove it never reaches output. */
export function scalarOf(file: string): string {
    const text = openssl(["pkey", "-in", file, "-noout", "-text"]).toString()
    const m = /priv:\s*([\s\S]*?)\npub:/.exec(text)
    if (!m) throw new Error("no priv section")
    return m[1].replace(/[\s:]/g, "").replace(/^00(?=[0-9a-f]{64}$)/, "")
}

/** Writes an executable stub that prints `stdout` for the matching first-arg pattern. */
export function writeStub(dir: string, name: string, cases: Record<string, string>): string {
    // A directory per stub, so a later stub never rewrites one already handed out
    const file = path.join(fs.mkdtempSync(path.join(dir, "stub-")), name)
    const branches = Object.entries(cases)
        .map(([pattern, out]) => `    ${pattern}) cat <<'STUB_EOF'\n${out}\nSTUB_EOF\n    ;;`)
        .join("\n")
    fs.writeFileSync(file, `#!/bin/sh\ncase "$*" in\n${branches}\n    *) exit 1 ;;\nesac\n`, { mode: 0o755 })
    return file
}

/** timedatectl that reports `synced` and, when given, a timesyncd offset line. */
export function timedatectlStub(dir: string, synced: "yes" | "no", offset?: string): string {
    return writeStub(dir, "timedatectl", {
        "'show -p NTPSynchronized --value'": synced,
        "timesync-status": offset ? `       Server: 192.0.2.1\n       Offset: ${offset}\n` : "",
    })
}

/** chronyc tracking output with `leap` and a System time offset of `seconds` (negative = slow). */
export function chronycStub(dir: string, leap: string, seconds: number): string {
    const dirn = seconds < 0 ? "slow" : "fast"
    return writeStub(dir, "chronyc", {
        "'-n tracking'": [
            "Reference ID    : C0000201 (192.0.2.1)",
            "Stratum         : 3",
            `System time     : ${Math.abs(seconds).toFixed(9)} seconds ${dirn} of NTP time`,
            `Leap status     : ${leap}`,
        ].join("\n"),
    })
}

export interface Run {
    status: number | null
    stdout: string
    stderr: string
}

export function run(cmd: string[], env: Record<string, string | undefined>): Run {
    const r = spawnSync(cmd[0], cmd.slice(1), {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as NodeJS.ProcessEnv,
        timeout: 30_000,
    })
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** `run` without blocking the event loop, for a script that calls back into a server in this process. */
export async function runAsync(cmd: string[], env: Record<string, string | undefined>): Promise<Run> {
    const proc = Bun.spawn(cmd, {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
    })
    const [stdout, stderr, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    return { status, stdout, stderr }
}

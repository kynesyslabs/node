import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { committedVerifierSha256, tlsnNotaryReasons } from "../../scripts/launch-go-no-go"
import { isSecp256k1CompressedPoint } from "../../src/forks/tlsnVerifiedPayload"
import { CEREMONY, GUARD, compressedPubOf, hasTool, makeTmp, run, scalarOf } from "./testSupport"

const REAL_SOPS = hasTool("sops") && hasTool("age-keygen")
// CI installs both; there a missing tool must fail the run, not skip it
const SKIP_REAL_SOPS = !REAL_SOPS && !process.env.CI
const TEMPLATE = path.join(import.meta.dir, "../../docs/mainnet/genesis.template.json")

let dir: string
let out: string

beforeEach(() => {
    dir = makeTmp("notary-ceremony")
    out = path.join(dir, "out")
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** Two throwaway age recipients, valid in form; only the stub sops sees them. */
const FAKE_RECIPIENTS = ["age1" + "q".repeat(58), "age1" + "p".repeat(58)]

/**
 * A sops stand-in for hosts without sops: checks the recipients in the
 * --config the ceremony wrote, keeps a copy of the plaintext it was given so
 * the test can match it with the published key, and writes ciphertext-shaped
 * JSON naming the recipients.
 */
function stubSops(): Record<string, string> {
    const bin = path.join(dir, "bin")
    fs.mkdirSync(bin)
    fs.writeFileSync(
        path.join(bin, "sops"),
        `#!/bin/sh
cfg= ; in=
while [ $# -gt 0 ]; do
    case $1 in
        --config) cfg=$2; shift 2 ;;
        --encrypt) shift ;;
        --input-type|--output-type) shift 2 ;;
        *) in=$1; shift ;;
    esac
done
[ -n "$cfg" ] && [ -f "$in" ] || exit 9
cp "$in" "${dir}/plaintext-seen-by-sops.key"
recips=$(sed -n 's/.*age: "\\(.*\\)"/\\1/p' "$cfg")
# Real sops adds the recipients of these variables; STUB_EXTRA stands for
# any other source of an extra recipient
[ -n "\${SOPS_AGE_RECIPIENTS:-}" ] && recips="$recips,$SOPS_AGE_RECIPIENTS"
[ -n "\${STUB_EXTRA:-}" ] && recips="$recips,$STUB_EXTRA"
printf '{"data":"ENC[AES256_GCM,data:x,type:str]","sops":{"age":['
first=1
for r in $(printf '%s' "$recips" | tr ',' ' '); do
    [ $first = 1 ] || printf ','
    first=0
    printf '{"recipient":"%s","enc":"-----BEGIN AGE ENCRYPTED FILE-----"}' "$r"
done
printf ']}}\\n'
`,
        { mode: 0o755 },
    )
    return { PATH: `${bin}:${process.env.PATH}` }
}

const ceremony = (args: string[], env: Record<string, string> = {}) =>
    run([CEREMONY, ...args], { TMPDIR: dir, ...env })

const shmLeftovers = () =>
    fs.existsSync("/dev/shm") ? fs.readdirSync("/dev/shm").filter(n => n.startsWith("notary-ceremony.")) : []

describe("notary-key-ceremony.sh", () => {
    it("writes the notaryKeys entry for the encrypted key, prints only public material and wipes its temp files", () => {
        const before = shmLeftovers()
        const r = ceremony(
            ["--id", "rehearsal-notary-1", "--recipient", FAKE_RECIPIENTS[0], "--recipient", FAKE_RECIPIENTS[1], "--out-dir", out, "--allow-online"],
            stubSops(),
        )
        expect(r.stderr).toBe("")
        expect(r.status).toBe(0)

        const entry = JSON.parse(fs.readFileSync(path.join(out, "rehearsal-notary-1.notary-key.json"), "utf8"))
        expect(Object.keys(entry)).toEqual(["id", "alg", "hex"])
        expect(entry.id).toBe("rehearsal-notary-1")
        expect(entry.alg).toBe("k256")
        expect(isSecp256k1CompressedPoint(entry.hex)).toBe(true)

        // The published key is the key that was encrypted
        const seen = path.join(dir, "plaintext-seen-by-sops.key")
        expect(compressedPubOf(seen)).toBe(entry.hex)
        const scalar = scalarOf(seen)
        expect(r.stdout.toLowerCase()).not.toContain(scalar)
        expect(r.stdout).toContain(`notaryKeys entry: ${JSON.stringify(entry)}`)
        expect(r.stdout).toMatch(/fingerprint: +SHA256:[0-9a-f]{64}\n/)

        const enc = fs.readFileSync(path.join(out, "rehearsal-notary-1.key.sops.json"), "utf8")
        expect(enc).not.toContain("PRIVATE KEY")
        for (const rcp of FAKE_RECIPIENTS) expect(enc).toContain(rcp)

        // Nothing but the two outputs is left behind
        expect(fs.readdirSync(out).sort()).toEqual(["rehearsal-notary-1.key.sops.json", "rehearsal-notary-1.notary-key.json"])
        expect(fs.readdirSync(dir).filter(n => n.startsWith("notary-ceremony."))).toEqual([])
        expect(shmLeftovers()).toEqual(before)

        // The start guard accepts the key with the published public key
        fs.chmodSync(seen, 0o400)
        const guard = run([GUARD, "preflight"], {
            NOTARY_EXPECTED_PUBKEY: entry.hex,
            NOTARY_KEY_FILE: seen,
            NOTARY_ALLOW_UNSYNCED_CLOCK: "1",
            NOTARY_STAMP_DIR: path.join(dir, "stamp"),
            NOTARY_UID: String(process.getuid?.()),
            NOTARY_GID: String(process.getgid?.()),
        })
        expect(guard.status).toBe(0)
    })

    it("fills the mainnet template's notaryKeys so go/no-go has no notary-key reason left", () => {
        const env = stubSops()
        const entries = ["demos-notary-1", "demos-notary-standby"].map(id => {
            const r = ceremony(["--id", id, "--recipient", FAKE_RECIPIENTS[0], "--recipient", FAKE_RECIPIENTS[1], "--out-dir", out, "--allow-online"], env)
            expect(r.status).toBe(0)
            return JSON.parse(fs.readFileSync(path.join(out, `${id}.notary-key.json`), "utf8"))
        })
        const template = JSON.parse(fs.readFileSync(TEMPLATE, "utf8"))
        const fork = template.forks.tlsnVerified
        expect(tlsnNotaryReasons(fork).join("\n")).toContain("placeholder or unset notary keys")

        expect(fork.notaryKeys.map((k: { id: string }) => k.id)).toEqual(entries.map(e => e.id))
        const filled = { ...fork, notaryKeys: entries, verifierWasmSha256: committedVerifierSha256() }
        expect(tlsnNotaryReasons(filled)).toEqual([])
    })

    it("encrypts to exactly the holders given", () => {
        const env = stubSops()
        const extra = "age1" + "x".repeat(58)
        const args = (id: string) => ["--id", id, "--recipient", FAKE_RECIPIENTS[0], "--recipient", FAKE_RECIPIENTS[1], "--out-dir", out, "--allow-online"]
        // A recipient variable in the operator's shell is cleared for sops
        const r = ceremony(args("k-env"), { ...env, SOPS_AGE_RECIPIENTS: extra })
        expect(r.status).toBe(0)
        expect(fs.readFileSync(path.join(out, "k-env.key.sops.json"), "utf8")).not.toContain(extra)
        // Any other extra recipient fails the ceremony and leaves nothing behind
        const x = ceremony(args("k-extra"), { ...env, STUB_EXTRA: extra })
        expect(x.status).toBe(6)
        expect(x.stderr).toContain("names 3 recipients, not the 2 holders")
        expect(fs.readdirSync(out).filter(n => n.startsWith("k-extra"))).toEqual([])
    })

    it.skipIf(SKIP_REAL_SOPS)("encrypts with sops so that each holder alone can decrypt the key", () => {
        const holders = [0, 1].map(i => {
            const id = path.join(dir, `holder-${i}.agekey`)
            expect(run(["age-keygen", "-o", id], {}).status).toBe(0)
            return { id, recipient: run(["age-keygen", "-y", id], {}).stdout.trim() }
        })
        // A .sops.yaml in the working directory must not add a recipient
        fs.writeFileSync(path.join(dir, ".sops.yaml"), `creation_rules:\n  - age: ${"age1" + "z".repeat(58)}\n`)
        const r = run(
            ["sh", "-c", `cd "${dir}" && exec "$0" "$@"`, CEREMONY, "--id", "rehearsal-notary-2",
                "--recipient", holders[0].recipient, "--recipient", holders[1].recipient, "--out-dir", out, "--allow-online"],
            { TMPDIR: dir },
        )
        expect(r.status).toBe(0)
        const entry = JSON.parse(fs.readFileSync(path.join(out, "rehearsal-notary-2.notary-key.json"), "utf8"))
        const enc = path.join(out, "rehearsal-notary-2.key.sops.json")
        expect(fs.readFileSync(enc, "utf8")).not.toContain("z".repeat(58))
        for (const h of holders) {
            const plain = path.join(dir, `decrypted-${path.basename(h.id)}.key`)
            const d = run(["sh", "-c", `umask 077; sops decrypt --input-type json --output-type binary "$0" > "$1"`, enc, plain], {
                SOPS_AGE_KEY_FILE: h.id,
            })
            expect(d.status).toBe(0)
            expect(compressedPubOf(plain)).toBe(entry.hex)
            expect(r.stdout.toLowerCase()).not.toContain(scalarOf(plain))
        }
    })

    it("refuses bad arguments", () => {
        const [a, b] = FAKE_RECIPIENTS
        const cases: string[][] = [
            ["--recipient", a, "--recipient", b, "--out-dir", out],
            ["--id", "bad id", "--recipient", a, "--recipient", b, "--out-dir", out],
            ["--id", "-lead", "--recipient", a, "--recipient", b, "--out-dir", out],
            ["--id", "k", "--recipient", a, "--out-dir", out],
            ["--id", "k", "--recipient", a, "--recipient", a, "--out-dir", out],
            ["--id", "k", "--recipient", a, "--recipient", "ssh-ed25519 AAAA", "--out-dir", out],
            ["--id", "k", "--recipient", a, "--recipient", b],
            ["--id", "k", "--recipient", a, "--recipient", b, "--out-dir", out, "--force"],
            ["--id", "ok\n../../x", "--recipient", a, "--recipient", b, "--out-dir", out],
            ["--id", "k", "--recipient", `${a}\n${b}`, "--recipient", b, "--out-dir", out],
        ]
        for (const args of cases) {
            const r = ceremony([...args, "--allow-online"])
            expect({ args, status: r.status }).toEqual({ args, status: 2 })
        }
        expect(fs.existsSync(out)).toBe(false)
    })

    it("never overwrites a key id it already made", () => {
        const env = stubSops()
        const args = ["--id", "k1", "--recipient", FAKE_RECIPIENTS[0], "--recipient", FAKE_RECIPIENTS[1], "--out-dir", out, "--allow-online"]
        expect(ceremony(args, env).status).toBe(0)
        const first = fs.readFileSync(path.join(out, "k1.notary-key.json"), "utf8")
        expect(ceremony(args, env).status).toBe(5)
        expect(fs.readFileSync(path.join(out, "k1.notary-key.json"), "utf8")).toBe(first)
    })

    const online = fs.existsSync("/proc/net/route") &&
        fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1).some(l => l.split(/\s+/)[1] === "00000000")

    it.skipIf(!online)("refuses to make a key on a host with a default route unless told it is a rehearsal", () => {
        const r = ceremony(["--id", "k", "--recipient", FAKE_RECIPIENTS[0], "--recipient", FAKE_RECIPIENTS[1], "--out-dir", out], stubSops())
        expect(r.status).toBe(4)
        expect(r.stderr).toContain("offline")
        expect(fs.existsSync(out)).toBe(false)
    })
})

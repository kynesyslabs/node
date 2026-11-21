import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import {
    GUARD,
    SERVICE_DIR,
    chronycStub,
    makeKey,
    makeTmp,
    rewriteKey,
    run,
    scalarOf,
    timedatectlStub,
} from "./testSupport"

const ABSENT = "notary-test-no-such-command"

let dir: string
let key: { file: string; pub: string }
let stamp: string
let syncedClock: Record<string, string>

beforeEach(() => {
    dir = makeTmp("notary-guard")
    key = makeKey(dir, "notary.key")
    stamp = path.join(dir, "stamp", "clock.ok")
    syncedClock = { NOTARY_TIMEDATECTL: timedatectlStub(dir, "yes", "+2.5ms"), NOTARY_CHRONYC: ABSENT }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const preflight = (env: Record<string, string | undefined> = {}) =>
    run([GUARD, "preflight"], {
        NOTARY_EXPECTED_PUBKEY: key.pub,
        NOTARY_KEY_FILE: key.file,
        NOTARY_STAMP_FILE: stamp,
        // The test's own user stands for the container user
        NOTARY_UID: String(process.getuid?.()),
        NOTARY_GID: String(process.getgid?.()),
        ...syncedClock,
        ...env,
    })

const execGuard = (env: Record<string, string | undefined> = {}) =>
    run(["sh", GUARD, "exec", "--", "echo", "notary-server started"], {
        NOTARY_EXPECTED_PUBKEY: key.pub,
        NS_NOTARIZATION__PRIVATE_KEY_PATH: key.file,
        NOTARY_STAMP_FILE: stamp,
        ...env,
    })

const writeStamp = (ageSec: number, pub = key.pub) => {
    fs.mkdirSync(path.dirname(stamp), { recursive: true })
    fs.writeFileSync(stamp, `${Math.floor(Date.now() / 1000) - ageSec} ${pub}\n`)
}

describe("preflight then exec", () => {
    it("starts the notary on the pinned key and a synchronised clock", () => {
        const pre = preflight()
        expect(pre.stderr).toContain("preflight passed")
        expect(pre.status).toBe(0)
        const [time, pub] = fs.readFileSync(stamp, "utf8").trim().split(" ")
        expect(pub).toBe(key.pub)
        expect(Math.abs(Number(time) - Date.now() / 1000)).toBeLessThan(5)

        const r = execGuard()
        expect(r.status).toBe(0)
        expect(r.stdout.trim()).toBe("notary-server started")
    })

    it("never prints the private key, traced or not", () => {
        const scalar = scalarOf(key.file)
        const body = fs.readFileSync(key.file, "utf8").split("\n")[1]
        const out = [
            preflight(),
            execGuard(),
            execGuard({ NOTARY_EXPECTED_PUBKEY: "02" + "1".repeat(64) }),
            // An operator debugging the unit with sh -x
            run(["sh", "-x", GUARD, "preflight"], {
                NOTARY_EXPECTED_PUBKEY: key.pub,
                NOTARY_KEY_FILE: key.file,
                NOTARY_STAMP_FILE: stamp,
                NOTARY_UID: String(process.getuid?.()),
                NOTARY_GID: String(process.getgid?.()),
                ...syncedClock,
            }),
            // The parser itself traced: it must stream the key, never hold it
            run(["sh", "-c", `. "${SERVICE_DIR}/lib.sh"; set -x; k256_pkcs8_pubkey "$0"`, key.file], {}),
        ]
        expect(out[4].stdout).toBe(key.pub)
        for (const r of out) {
            const all = r.stdout + r.stderr
            expect(all.toLowerCase()).not.toContain(scalar)
            expect(all).not.toContain(body)
        }
    })
})

describe("key file refusals", () => {
    it("refuses a missing key file instead of letting the notary sign with a random key", () => {
        const r = preflight({ NOTARY_KEY_FILE: path.join(dir, "absent.key") })
        expect(r.status).toBe(3)
        expect(r.stderr).toContain("REFUSING TO START")
        expect(r.stderr).toContain("random key")
        writeStamp(0)
        expect(execGuard({ NS_NOTARIZATION__PRIVATE_KEY_PATH: path.join(dir, "absent.key") }).status).toBe(3)
        expect(execGuard({ NS_NOTARIZATION__PRIVATE_KEY_PATH: "" }).status).toBe(2)
    })

    it("refuses a directory, an empty file and an oversized file", () => {
        fs.mkdirSync(path.join(dir, "keydir"))
        expect(preflight({ NOTARY_KEY_FILE: path.join(dir, "keydir") }).status).toBe(3)
        fs.writeFileSync(path.join(dir, "empty.key"), "", { mode: 0o400 })
        expect(preflight({ NOTARY_KEY_FILE: path.join(dir, "empty.key") }).status).toBe(3)
        fs.writeFileSync(path.join(dir, "big.key"), "x".repeat(5000), { mode: 0o400 })
        expect(preflight({ NOTARY_KEY_FILE: path.join(dir, "big.key") }).status).toBe(3)
    })

    it.skipIf(process.getuid?.() === 0)("refuses a key file it cannot read", () => {
        fs.chmodSync(key.file, 0o000)
        const r = preflight()
        expect(r.status).toBe(3)
        expect(r.stderr).toContain("not readable")
    })

    it("refuses in the preflight a key file the container user could not read", () => {
        const r = preflight({ NOTARY_UID: "10001", NOTARY_GID: "10001" })
        expect(r.status).toBe(3)
        expect(r.stderr).toContain("could not read it")
        // Another owner, but the container's group with group read
        const gid = String(process.getgid?.())
        fs.chmodSync(key.file, 0o440)
        expect(preflight({ NOTARY_UID: "10001", NOTARY_GID: gid }).status).toBe(0)
        fs.chmodSync(key.file, 0o400)
        expect(preflight({ NOTARY_UID: "10001", NOTARY_GID: gid }).status).toBe(3)
    })

    it("refuses a key file others can read or its group can write", () => {
        for (const mode of [0o644, 0o604, 0o401, 0o460, 0o620]) {
            fs.chmodSync(key.file, mode)
            const r = preflight()
            expect(r.status).toBe(4)
            expect(r.stderr).toContain(`mode ${mode.toString(8)}`)
        }
        for (const mode of [0o400, 0o440, 0o600, 0o640]) {
            fs.chmodSync(key.file, mode)
            expect(preflight().status).toBe(0)
        }
    })

    it("refuses keys that are not PKCS#8 secp256k1 with the public key", () => {
        const p256 = makeKey(dir, "p256.key", "prime256v1")
        const cases: Record<string, string> = {
            p256: p256.file,
            sec1: rewriteKey(key.file, path.join(dir, "sec1.key"), ["ec", "-outform", "PEM"]),
            encrypted: rewriteKey(key.file, path.join(dir, "enc.key"), [
                "pkcs8", "-topk8", "-v2", "aes-256-cbc", "-passout", "pass:test-only",
            ]),
            noPublicKey: (() => {
                const sec1 = rewriteKey(key.file, path.join(dir, "nopub-sec1.key"), ["ec", "-no_public"])
                return rewriteKey(sec1, path.join(dir, "nopub.key"), ["pkcs8", "-topk8", "-nocrypt"])
            })(),
        }
        const twice = path.join(dir, "twice.key")
        fs.writeFileSync(twice, fs.readFileSync(key.file, "utf8") + fs.readFileSync(p256.file, "utf8"), { mode: 0o400 })
        cases.twoKeys = twice
        const garbage = path.join(dir, "garbage.key")
        fs.writeFileSync(garbage, "-----BEGIN PRIVATE KEY-----\n!!!notbase64!!!\n-----END PRIVATE KEY-----\n", { mode: 0o400 })
        cases.garbage = garbage
        const truncated = path.join(dir, "truncated.key")
        const lines = fs.readFileSync(key.file, "utf8").trim().split("\n")
        fs.writeFileSync(truncated, [lines[0], lines[1], lines[lines.length - 1]].join("\n") + "\n", { mode: 0o400 })
        cases.truncated = truncated
        const pem = fs.readFileSync(key.file, "utf8")
        const leading = path.join(dir, "leading.key")
        fs.writeFileSync(leading, "notary key\n" + pem, { mode: 0o400 })
        cases.leadingText = leading
        const trailing = path.join(dir, "trailing.key")
        fs.writeFileSync(trailing, pem + "copied from the ceremony\n", { mode: 0o400 })
        cases.trailingText = trailing

        for (const [name, file] of Object.entries(cases)) {
            const r = preflight({ NOTARY_KEY_FILE: file })
            expect({ name, status: r.status }).toEqual({ name, status: 5 })
        }
    })

    it("refuses a valid key that is not the pinned one", () => {
        const other = makeKey(dir, "other.key")
        const r = preflight({ NOTARY_KEY_FILE: other.file })
        expect(r.status).toBe(6)
        expect(r.stderr).toContain(other.pub)
        expect(r.stderr).toContain(`expected ${key.pub}`)
        writeStamp(0)
        expect(execGuard({ NS_NOTARIZATION__PRIVATE_KEY_PATH: other.file }).status).toBe(6)
    })

    it("refuses a malformed expected key", () => {
        for (const bad of ["", "04" + "a".repeat(64), "02" + "A".repeat(64), "02abc", "FILL: primary notary public key", `${key.pub}\n${key.pub}`]) {
            expect(preflight({ NOTARY_EXPECTED_PUBKEY: bad }).status).toBe(2)
        }
    })
})

describe("clock refusals", () => {
    it("refuses a clock timedatectl reports as unsynchronised", () => {
        const r = preflight({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "no") })
        expect(r.status).toBe(7)
        expect(r.stderr).toContain("not NTP-synchronised")
        expect(fs.existsSync(stamp)).toBe(false)
    })

    it("refuses a chrony clock that is unsynchronised or too far off", () => {
        const unsynced = preflight({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: chronycStub(dir, "Not synchronised", 0) })
        expect(unsynced.status).toBe(7)
        const far = preflight({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: chronycStub(dir, "Normal", -45.5) })
        expect(far.status).toBe(7)
        expect(far.stderr).toContain("-45.5")
        const near = preflight({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: chronycStub(dir, "Normal", 0.002) })
        expect(near.status).toBe(0)
        // A leap second announcement is still a synchronised clock
        expect(preflight({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: chronycStub(dir, "Insert second", 0.002) }).status).toBe(0)
        expect(preflight({
            NOTARY_TIMEDATECTL: ABSENT,
            NOTARY_CHRONYC: chronycStub(dir, "Normal", 3),
            NOTARY_MAX_CLOCK_OFFSET_SEC: "2",
        }).status).toBe(7)
    })

    it("refuses when timedatectl and chrony disagree", () => {
        const r = preflight({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "no"), NOTARY_CHRONYC: chronycStub(dir, "Normal", 0) })
        expect(r.status).toBe(7)
    })

    it("reads a timesyncd offset in any unit", () => {
        expect(preflight({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "yes", "+45.2s") }).status).toBe(7)
        expect(preflight({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "yes", "-1min 2s") }).status).toBe(7)
        expect(preflight({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "yes", "-850us") }).status).toBe(0)
        expect(preflight({ NOTARY_TIMEDATECTL: timedatectlStub(dir, "yes", "+29999ms") }).status).toBe(0)
    })

    it("refuses when no tool can tell", () => {
        const r = preflight({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: ABSENT })
        expect(r.status).toBe(7)
        expect(r.stderr).toContain("cannot tell")
    })

    it("skips the clock only with the explicit development override, and writes no stamp", () => {
        const r = preflight({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: ABSENT, NOTARY_ALLOW_UNSYNCED_CLOCK: "1" })
        expect(r.status).toBe(0)
        expect(r.stderr).toContain("local development only")
        expect(fs.existsSync(stamp)).toBe(false)
        // The stamp directory exists for the compose bind mount
        expect(fs.existsSync(path.dirname(stamp))).toBe(true)
        expect(preflight({ NOTARY_TIMEDATECTL: ABSENT, NOTARY_CHRONYC: ABSENT, NOTARY_ALLOW_UNSYNCED_CLOCK: "yes" }).status).toBe(7)
    })
})

describe("exec without a fresh preflight", () => {
    it("refuses with no stamp", () => {
        const r = execGuard()
        expect(r.status).toBe(7)
        expect(r.stdout).toBe("")
        expect(r.stderr).toContain("no preflight stamp")
    })

    it("refuses a stale, future or malformed stamp", () => {
        writeStamp(301)
        expect(execGuard().status).toBe(7)
        writeStamp(-60)
        expect(execGuard().status).toBe(7)
        writeStamp(10)
        expect(execGuard({ NOTARY_STAMP_MAX_AGE_SEC: "5" }).status).toBe(7)
        fs.writeFileSync(stamp, `yesterday ${key.pub}\n`)
        expect(execGuard().status).toBe(7)
    })

    it("refuses a stamp written for another key", () => {
        writeStamp(0, "03" + "2".repeat(64))
        const r = execGuard()
        expect(r.status).toBe(7)
        expect(r.stderr).toContain("written for key")
    })

    it("starts with the override and no stamp", () => {
        const r = execGuard({ NOTARY_ALLOW_UNSYNCED_CLOCK: "1" })
        expect(r.status).toBe(0)
        expect(r.stdout.trim()).toBe("notary-server started")
    })

    it("still checks the key under the override", () => {
        fs.chmodSync(key.file, 0o644)
        expect(execGuard({ NOTARY_ALLOW_UNSYNCED_CLOCK: "1" }).status).toBe(4)
    })
})

describe("configuration", () => {
    it("refuses to publish the notary on every interface", () => {
        for (const bind of ["0.0.0.0", "::", "[::]", "*"]) {
            expect(preflight({ NOTARY_BIND: bind }).status).toBe(2)
        }
        expect(preflight({ NOTARY_BIND: "10.0.0.5" }).status).toBe(0)
    })

    it("refuses an unknown mode and an exec without a command", () => {
        expect(run([GUARD, "start"], { NOTARY_EXPECTED_PUBKEY: key.pub }).status).toBe(2)
        expect(run([GUARD], { NOTARY_EXPECTED_PUBKEY: key.pub }).status).toBe(2)
        writeStamp(0)
        expect(run([GUARD, "exec", "--"], {
            NOTARY_EXPECTED_PUBKEY: key.pub,
            NS_NOTARIZATION__PRIVATE_KEY_PATH: key.file,
            NOTARY_STAMP_FILE: stamp,
        }).status).toBe(2)
    })
})

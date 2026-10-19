import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { collectChecks, isFatal } from "./checks"
import { runCli } from "./cli"
import { CODE_ROOT, ZK_IDENTITY_VKEY, createContext } from "./context"
import { IDENTITY_CIRCUIT_DIGEST, IDENTITY_DIGEST_ENV, byCodePoint, canonicalDigest, downloadWithFetch, inspectBatchArtifacts, inspectIdentityKey, runL2psZkSetup, swapIntoPlace, type ZkRunner } from "./zk"
import { BATCH_VKEY, GIT, fakeRunner, installZkTools, makeRoot, recorder, removeRoot, writeSubnet, writeZkBatch } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

const keysDir = (size: number) => path.join(root, "src/libs/l2ps/zk/keys", `batch_${size}`)
const COMMITTED = BATCH_VKEY

/** A fake toolchain whose verification key equals the committed one. */
const toolchain = (opts: { vkeyJson?: string; failOn?: string } = {}) =>
    fakeRunner({ vkeyJson: JSON.stringify(COMMITTED), ...opts })

function seedCommitted(content: object = COMMITTED) {
    for (const size of [5, 10]) {
        fs.mkdirSync(keysDir(size), { recursive: true })
        fs.writeFileSync(path.join(keysDir(size), "verification_key.json"), JSON.stringify(content))
    }
}

/** Every file below the keys directory, so a stray partial file shows up. */
function keyFiles(): string[] {
    const out: string[] = []
    const walk = (d: string) => {
        if (!fs.existsSync(d)) return
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) walk(p)
            else out.push(path.relative(root, p))
        }
    }
    walk(path.join(root, "src/libs/l2ps/zk/keys"))
    return out.sort(byCodePoint)
}

const finalFiles = (size: number) => keyFiles().filter(f => f.includes(`batch_${size}/`) && !f.includes(".building"))
const stagingLeft = () =>
    [5, 10].map(n => path.join(keysDir(n), ".building")).filter(d => fs.existsSync(d)).map(d => path.relative(root, d))

describe("a build that fails", () => {
    for (const step of ["circom2 compile", "snarkjs plonk setup", "snarkjs zkey export"]) {
        it(`at "${step}" in the second batch leaves the first intact and nothing partial behind`, async () => {
            seedCommitted()
            let seen = 0
            const base = toolchain()
            const runner: ZkRunner = {
                download: base.download,
                exec: async (cmd, args, cwd) => {
                    const name = `${path.basename(cmd)} ${args[0] === "plonk" || args[0] === "zkey" ? args.slice(0, 2).join(" ") : "compile"}`
                    // The second batch starts at its own compile step.
                    if (name === "circom2 compile") seen++
                    if (seen === 2 && name === step) return 1
                    return base.exec(cmd, args, cwd)
                },
            }
            const out = await runL2psZkSetup(root, runner, recorder().say)
            expect(out.ok).toBe(false)
            const state = inspectBatchArtifacts(root)
            expect(state.find(b => b.size === 5)?.complete).toBe(true)
            expect(state.find(b => b.size === 10)?.complete).toBe(false)
            expect(finalFiles(10)).toEqual(["src/libs/l2ps/zk/keys/batch_10/verification_key.json"])
            expect(stagingLeft()).toEqual([])
        })
    }

    it("when the runner throws (tool missing, network down) the staging directory is removed too", async () => {
        seedCommitted()
        const runner: ZkRunner = {
            download: async (_u, dest) => {
                fs.mkdirSync(path.dirname(dest), { recursive: true })
                fs.writeFileSync(dest, "x".repeat(10))
            },
            exec: async () => {
                throw new Error("spawn circom2 ENOENT")
            },
        }
        await expect(runL2psZkSetup(root, runner, recorder().say)).rejects.toThrow("ENOENT")
        expect(stagingLeft()).toEqual([])
        expect(finalFiles(5)).toEqual(["src/libs/l2ps/zk/keys/batch_5/verification_key.json"])
    })

    it("a vkey mismatch keeps whatever was there before byte for byte", async () => {
        seedCommitted()
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "OLD-ZKEY")
        const before = fs.readFileSync(path.join(keysDir(5), "verification_key.json"), "utf8")
        const out = await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ ...BATCH_VKEY, power: 99 }) }), recorder().say)
        expect(out.ok).toBe(false)
        expect(fs.readFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "utf8")).toBe("OLD-ZKEY")
        expect(fs.readFileSync(path.join(keysDir(5), "verification_key.json"), "utf8")).toBe(before)
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5_js"))).toBe(false)
        expect(stagingLeft()).toEqual([])
    })

    it("a committed key that is missing or corrupt is reported, never replaced by the generated one", async () => {
        seedCommitted()
        for (const content of [null, "{not json", ""]) {
            const file = path.join(keysDir(5), "verification_key.json")
            if (content === null) fs.rmSync(file)
            else fs.writeFileSync(file, content)
            const out = await runL2psZkSetup(root, toolchain(), recorder().say)
            expect(out.ok).toBe(false)
            expect(out.messages.join()).toContain("committed verification key")
            expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null).toBe(content)
            expect(finalFiles(5).filter(f => f.endsWith(".zkey") || f.endsWith(".wasm"))).toEqual([])
            expect(stagingLeft()).toEqual([])
        }
    })

    it("a verification key with the same data in another key order is the same key", async () => {
        seedCommitted(BATCH_VKEY)
        const reordered = JSON.stringify(Object.fromEntries(Object.entries(BATCH_VKEY).reverse()))
        const out = await runL2psZkSetup(root, toolchain({ vkeyJson: reordered }), recorder().say)
        expect(out.ok).toBe(true)
    })

    it("a crash between moving the circuit and the proving key never looks like a finished build", async () => {
        seedCommitted()
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "OLD-ZKEY")
        const real = fs.renameSync
        const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
            if (String(to).endsWith("l2ps_batch_5.zkey")) throw new Error("killed here")
            return real(from, to)
        }) as typeof fs.renameSync)
        try {
            await expect(runL2psZkSetup(root, toolchain(), recorder().say, [5])).rejects.toThrow("killed here")
        } finally {
            spy.mockRestore()
        }
        // Old key plus new circuit would pass inspection but could not prove anything.
        expect(inspectBatchArtifacts(root).find(b => b.size === 5)?.complete).toBe(false)
    })
})

describe("what counts as a built batch", () => {
    it("ignores a leftover .building directory from a crashed run, whatever it holds", () => {
        seedCommitted()
        const stale = path.join(keysDir(5), ".building")
        fs.mkdirSync(path.join(stale, "l2ps_batch_5_js"), { recursive: true })
        fs.writeFileSync(path.join(stale, "l2ps_batch_5.zkey"), "z")
        fs.writeFileSync(path.join(stale, "l2ps_batch_5_js", "l2ps_batch_5.wasm"), "w")
        expect(inspectBatchArtifacts(root).find(b => b.size === 5)?.complete).toBe(false)
    })

    it("cleans such a leftover before building and finishes the batch", async () => {
        seedCommitted()
        const stale = path.join(keysDir(5), ".building")
        fs.mkdirSync(stale, { recursive: true })
        fs.writeFileSync(path.join(stale, "junk"), "from a crashed run")
        const out = await runL2psZkSetup(root, toolchain(), recorder().say)
        expect(out.ok).toBe(true)
        expect(stagingLeft()).toEqual([])
    })

    it("an empty proving key or circuit is not a finished build", () => {
        writeZkBatch(root, 5)
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "")
        expect(inspectBatchArtifacts(root).find(b => b.size === 5)?.complete).toBe(false)
        writeZkBatch(root, 10)
        fs.writeFileSync(path.join(keysDir(10), "l2ps_batch_10_js", "l2ps_batch_10.wasm"), "")
        expect(inspectBatchArtifacts(root).find(b => b.size === 10)?.complete).toBe(false)
    })

    it("a batch size that has no configured circuit fails before anything is downloaded", async () => {
        seedCommitted()
        const runner = toolchain()
        const out = await runL2psZkSetup(root, runner, recorder().say, [7 as never])
        expect(out.ok).toBe(false)
        expect(runner.calls).toEqual([])
        expect(stagingLeft()).toEqual([])
    })
})

describe("the wizard never switches proofs on after a failure", () => {
    const argv = ["--yes", "--only", "zk", "--zk", "--zk-generate"]
    async function run(runner: ZkRunner) {
        installZkTools(root)
        writeSubnet(root, "s1")
        const r = recorder()
        const code = await runCli(argv, { cwd: root, env: {}, isTTY: false, say: r.say, runner, inDocker: false })
        return { code, out: r.text() }
    }
    const envText = () => (fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8") : "")

    it("failing build, vkey mismatch and a throwing runner all leave L2PS_ZK_ENABLED unset", async () => {
        seedCommitted()
        for (const runner of [
            toolchain({ failOn: "plonk setup" }),
            toolchain({ vkeyJson: JSON.stringify({ ...BATCH_VKEY, power: 1 }) }),
            { download: async () => { throw new Error("offline") }, exec: async () => 0 } as ZkRunner,
        ]) {
            const { code, out } = await run(runner)
            expect(code).toBe(1)
            expect(envText()).not.toContain("L2PS_ZK_ENABLED")
            expect(out).toContain("left unchanged")
            expect(stagingLeft()).toEqual([])
        }
    })

    it("--yes without --zk-generate downloads and builds nothing", async () => {
        seedCommitted()
        const runner = toolchain()
        installZkTools(root)
        writeSubnet(root, "s1")
        const code = await runCli(["--yes", "--only", "zk", "--zk"], { cwd: root, env: {}, isTTY: false, say: () => undefined, runner, inDocker: false })
        expect(code).toBe(0)
        expect(runner.calls).toEqual([])
        expect(envText()).not.toContain("L2PS_ZK_ENABLED")
    })

    it("a success writes it exactly once", async () => {
        seedCommitted()
        const { code } = await run(toolchain())
        expect(code).toBe(0)
        expect(envText().match(/^L2PS_ZK_ENABLED=true$/gm)).toHaveLength(1)
    })

    it("keys that are only half there never enable proofs", async () => {
        seedCommitted()
        writeZkBatch(root, 5)
        fs.rmSync(path.join(keysDir(5), "l2ps_batch_5_js"), { recursive: true })
        installZkTools(root)
        writeSubnet(root, "s1")
        const runner = toolchain({ failOn: "compile" })
        await runCli(argv, { cwd: root, env: {}, isTTY: false, say: () => undefined, runner, inDocker: false })
        expect(envText()).not.toContain("L2PS_ZK_ENABLED=true")
    })
})

// A source tarball or a container image has no .git, so there is nothing to ask.
const repo = path.resolve(import.meta.dir, "../../..")
const hasGit = fs.existsSync(path.join(repo, ".git")) && GIT !== undefined

describe.skipIf(!hasGit)("what git is told to ignore", () => {
    const ignored = (file: string) => spawnSync(GIT as string, ["check-ignore", "-q", file], { cwd: repo }).status === 0

    it("covers every file the setup can leave behind", () => {
        for (const f of [
            "src/libs/l2ps/zk/keys/batch_5/.building/l2ps_batch_5.zkey",
            "src/libs/l2ps/zk/keys/batch_10/.building/l2ps_batch_10_js/l2ps_batch_10.wasm",
            "src/libs/l2ps/zk/keys/batch_5/.building/verification_key.json",
            "src/libs/l2ps/zk/ptau/powersOfTau28_hez_final_16.ptau.part",
            "data/l2ps/s1/private_key.txt",
            "data/l2ps/s1/iv.txt",
            "data/l2ps/s1/private_key.txt.bak-1791970644128",
            "data/l2ps/s1/iv.txt.tmp-4242",
            ".env.bak-1791970644128",
            ".env.tmp-4242",
        ]) {
            expect([f, ignored(f)]).toEqual([f, true])
        }
    })

    it("still tracks the committed verification keys", () => {
        expect(ignored("src/libs/l2ps/zk/keys/batch_5/verification_key.json")).toBe(false)
        expect(ignored("src/features/zk/keys/verification_key_merkle.json")).toBe(false)
    })
})

describe("swapIntoPlace keeps the previous keys when any step fails", () => {
    function layout(withOld: boolean) {
        const dir = path.join(root, "swap")
        fs.mkdirSync(path.join(dir, "stage", "wasm_js"), { recursive: true })
        fs.writeFileSync(path.join(dir, "stage", "wasm_js", "c.wasm"), "NEW-WASM")
        fs.writeFileSync(path.join(dir, "stage", "k.zkey"), "NEW-ZKEY")
        if (withOld) {
            fs.mkdirSync(path.join(dir, "wasm_js"), { recursive: true })
            fs.writeFileSync(path.join(dir, "wasm_js", "c.wasm"), "OLD-WASM")
            fs.writeFileSync(path.join(dir, "k.zkey"), "OLD-ZKEY")
        }
        return {
            dir,
            run: (rename?: (a: string, b: string) => void) => swapIntoPlace(path.join(dir, "stage", "wasm_js"), path.join(dir, "wasm_js"), path.join(dir, "stage", "k.zkey"), path.join(dir, "k.zkey"), rename),
            files: () => ({
                wasm: fs.existsSync(path.join(dir, "wasm_js", "c.wasm")) ? fs.readFileSync(path.join(dir, "wasm_js", "c.wasm"), "utf8") : null,
                zkey: fs.existsSync(path.join(dir, "k.zkey")) ? fs.readFileSync(path.join(dir, "k.zkey"), "utf8") : null,
                strays: fs.readdirSync(dir).filter(f => /\.(next|old)$/.test(f)),
            }),
        }
    }

    it("installs both new files and leaves no temporary name behind", () => {
        const l = layout(true)
        l.run()
        expect(l.files()).toEqual({ wasm: "NEW-WASM", zkey: "NEW-ZKEY", strays: [] })
    })

    for (const withOld of [true, false]) {
        for (let failAt = 1; failAt <= (withOld ? 6 : 4); failAt++) {
            it(`a rename that throws as call ${failAt} (${withOld ? "old keys present" : "no old keys"}) leaves the previous state intact`, () => {
                const l = layout(withOld)
                let calls = 0
                expect(() =>
                    l.run((a, b) => {
                        if (++calls === failAt) throw new Error("rename failed")
                        fs.renameSync(a, b)
                    }),
                ).toThrow("rename failed")
                // With old keys: exactly the old pair. Without: nothing at the final paths.
                expect(l.files()).toEqual(withOld ? { wasm: "OLD-WASM", zkey: "OLD-ZKEY", strays: [] } : { wasm: null, zkey: null, strays: [] })
            })
        }
    }

    it("through the real build: a rename that throws on the second call keeps the old proving key", async () => {
        seedCommitted()
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "OLD-ZKEY")
        const real = fs.renameSync
        let calls = 0
        const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
            // The downloads and the fake toolchain write files; only the swap renames.
            if (++calls === 2) throw new Error("second rename failed")
            return real(from, to)
        }) as typeof fs.renameSync)
        try {
            await expect(runL2psZkSetup(root, toolchain(), recorder().say, [5])).rejects.toThrow("second rename failed")
        } finally {
            spy.mockRestore()
        }
        expect(fs.readFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "utf8")).toBe("OLD-ZKEY")
        expect(stagingLeft()).toEqual([])
        expect(fs.readdirSync(keysDir(5)).filter(f => /\.(next|old)$/.test(f))).toEqual([])
    })
})

describe("the identity verification key is pinned to the one committed in this release", () => {
    const vkey = () => path.join(root, "src/features/zk/keys/verification_key_merkle.json")

    it("the digest in the code is the digest of the committed file, so a key change cannot be forgotten", () => {
        const committed = fs.readFileSync(path.join(CODE_ROOT, "src/features/zk/keys/verification_key_merkle.json"), "utf8")
        expect(canonicalDigest(committed)).toBe(IDENTITY_CIRCUIT_DIGEST)
    })

    it("accepts the committed key, whatever its layout or key order", () => {
        expect(inspectIdentityKey(root).state).toBe("ok")
        const parsed = JSON.parse(fs.readFileSync(vkey(), "utf8")) as Record<string, unknown>
        const reordered = Object.fromEntries(Object.entries(parsed).reverse())
        fs.writeFileSync(vkey(), JSON.stringify(reordered))
        expect(inspectIdentityKey(root).state).toBe("ok")
        fs.writeFileSync(vkey(), JSON.stringify(reordered, null, "\t"))
        expect(inspectIdentityKey(root).state).toBe("ok")
    })

    it("refuses a well-formed groth16 key that is not the committed one, with a clear message", () => {
        const parsed = JSON.parse(fs.readFileSync(vkey(), "utf8")) as { IC: string[][] }
        for (const different of [
            { protocol: "groth16", vk_alpha_1: ["1"], IC: [["1"]] },
            { ...parsed, IC: [...parsed.IC, ["1", "2", "1"]] },
            { ...parsed, nPublic: 99 },
        ]) {
            fs.writeFileSync(vkey(), JSON.stringify(different))
            const state = inspectIdentityKey(root)
            expect(state.state).toBe("invalid")
            expect(state.detail).toContain("does not match the verification key committed in this release")
        }
    })

    describe("an operator override after a deliberate key rotation", () => {
        const rotated = () => {
            const parsed = JSON.parse(fs.readFileSync(vkey(), "utf8")) as Record<string, unknown>
            const next = { ...parsed, nPublic: 99 }
            fs.writeFileSync(vkey(), JSON.stringify(next))
            return canonicalDigest(JSON.stringify(next))
        }

        it("accepts a rotated key whose digest is given, in any letter case", () => {
            const digest = rotated()
            expect(inspectIdentityKey(root).state).toBe("invalid")
            for (const value of [digest, digest.toUpperCase(), ` ${digest}\n`]) {
                const state = inspectIdentityKey(root, { [IDENTITY_DIGEST_ENV]: value })
                expect(state.state).toBe("ok")
                expect(state.detail).toContain(IDENTITY_DIGEST_ENV)
            }
        })

        it("replaces the release digest, so the committed key itself no longer passes and any other key still fails", () => {
            const digest = rotated()
            const state = inspectIdentityKey(root, { [IDENTITY_DIGEST_ENV]: "ab".repeat(32) })
            expect(state.state).toBe("invalid")
            expect(state.detail).toContain(`does not match the digest in ${IDENTITY_DIGEST_ENV}`)
            fs.copyFileSync(path.join(CODE_ROOT, ZK_IDENTITY_VKEY), vkey())
            expect(inspectIdentityKey(root, { [IDENTITY_DIGEST_ENV]: digest }).state).toBe("invalid")
        })

        it("treats an empty value as not set", () => {
            expect(inspectIdentityKey(root, { [IDENTITY_DIGEST_ENV]: "" }).state).toBe("ok")
        })

        it("rejects a malformed digest with a clear message, even for the committed key", () => {
            for (const bad of ["abc", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33), `0x${"ab".repeat(32)}`]) {
                const state = inspectIdentityKey(root, { [IDENTITY_DIGEST_ENV]: bad })
                expect(state.state).toBe("invalid")
                expect(state.detail).toContain(`${IDENTITY_DIGEST_ENV} must be a 64-character hex SHA-256 digest`)
            }
        })

        it("still stops the node when the key is missing or unreadable, override or not", () => {
            const digest = rotated()
            fs.writeFileSync(vkey(), "not json")
            expect(inspectIdentityKey(root, { [IDENTITY_DIGEST_ENV]: digest }).state).toBe("invalid")
            fs.rmSync(vkey())
            expect(inspectIdentityKey(root, { [IDENTITY_DIGEST_ENV]: digest }).state).toBe("missing")
        })

        it("is read from the gate's environment", async () => {
            const digest = rotated()
            const run = async (env: Record<string, string>) => {
                const lines: string[] = []
                const code = await runCli(["--check", "--json"], { cwd: root, env, isTTY: false, say: l => lines.push(l), inDocker: false })
                return { code, text: lines.join("\n") }
            }
            expect((await run({})).code).toBe(1)
            expect((await run({ [IDENTITY_DIGEST_ENV]: digest })).code).toBe(0)
            const malformed = await run({ [IDENTITY_DIGEST_ENV]: "nope" })
            expect(malformed.code).toBe(1)
            expect(malformed.text).toContain("64-character hex")
        })
    })

    it("keeps the identity item fatal when another ZK check throws", () => {
        fs.rmSync(vkey())
        const ctx = createContext(root, ".env", {})
        // Reading this flag is the first thing the batch-proof checks do.
        ctx.env = new Proxy(ctx.env, {
            get(target, name) {
                if (name === "L2PS_ZK_ENABLED") throw new Error("boom")
                return target[name as string]
            },
        })
        const items = collectChecks(ctx).items
        expect(items.some(i => i.area === "ZK" && i.item === "Inspection")).toBe(true)
        const identity = items.find(i => i.area === "ZK identity")
        expect(identity).toMatchObject({ status: "missing", fatal: true })
        expect(items.filter(isFatal).length).toBe(1)
    })

    it("falls back to a fatal item when the identity check itself throws", () => {
        const ctx = createContext(root, ".env", {})
        ctx.codeRoot = null as unknown as string
        const fatal = collectChecks(ctx).items.filter(isFatal)
        expect(fatal.length).toBe(1)
        expect(fatal[0].detail).toContain("could not be checked")
    })

    it("shows an active override as a warning item, never as a plain pass", () => {
        const parsed = JSON.parse(fs.readFileSync(vkey(), "utf8")) as Record<string, unknown>
        const next = { ...parsed, nPublic: 99 }
        fs.writeFileSync(vkey(), JSON.stringify(next))
        const digest = canonicalDigest(JSON.stringify(next))
        const item = collectChecks(createContext(root, ".env", { [IDENTITY_DIGEST_ENV]: digest })).items.find(i => i.area === "ZK identity")
        expect(item).toMatchObject({ status: "warn", blocking: false, fatal: true })
        expect(item?.detail).toContain(IDENTITY_DIGEST_ENV)
        expect(item?.detail).not.toContain(digest)
    })

    it("stops the gate through the fatal path", async () => {
        fs.writeFileSync(vkey(), JSON.stringify({ protocol: "groth16", vk_alpha_1: ["1"], IC: [["1"]] }))
        const lines: string[] = []
        const code = await runCli(["--check", "--json"], { cwd: root, env: {}, isTTY: false, say: l => lines.push(l), inDocker: false })
        expect(code).toBe(1)
        expect(lines.join("\n")).toContain("committed in this release")
    })
})


describe("the start-up check reads the key file the verifier reads", () => {
    it("resolves to the same absolute path as ProofVerifier", async () => {
        // The node loads this first; the verifier's entity imports need it.
        await import("reflect-metadata")
        const { ProofVerifier } = await import("@/features/zk/proof/ProofVerifier")
        expect(path.resolve(CODE_ROOT, ZK_IDENTITY_VKEY)).toBe(path.resolve(ProofVerifier.verificationKeyPath))
    })
})

describe("downloadWithFetch", () => {
    it("leaves no .part file behind when the final move fails", async () => {
        const bytes = new Uint8Array(2048).fill(7)
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(bytes) })
        const dir = fs.mkdtempSync(path.join(root, "dl-"))
        try {
            // A directory at the destination makes the rename fail after the data was written.
            const dest = path.join(dir, "file.ptau")
            fs.mkdirSync(path.join(dest, "inner"), { recursive: true })
            await expect(downloadWithFetch(`http://127.0.0.1:${server.port}/x`, dest, 1024)).rejects.toThrow()
            expect(fs.readdirSync(dir)).toEqual(["file.ptau"])
        } finally {
            server.stop(true)
        }
    })

    const serve = (make: () => Response) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: make })
    const slot = () => fs.mkdtempSync(path.join(root, "dl-"))

    it("refuses a body larger than the cap, declared or streamed, and leaves nothing behind", async () => {
        const declared = serve(() => new Response(new Uint8Array(4096)))
        const streamed = serve(
            () =>
                new Response(
                    new ReadableStream({
                        pull(c) {
                            c.enqueue(new Uint8Array(1024))
                        },
                    }),
                ),
        )
        const dir = slot()
        try {
            await expect(downloadWithFetch(`http://127.0.0.1:${declared.port}/x`, path.join(dir, "a"), 10, 1024)).rejects.toThrow(/too large/)
            await expect(downloadWithFetch(`http://127.0.0.1:${streamed.port}/x`, path.join(dir, "b"), 10, 8192)).rejects.toThrow(/too large/)
            expect(fs.readdirSync(dir)).toEqual([])
        } finally {
            declared.stop(true)
            streamed.stop(true)
        }
    })

    it("gives up after the time limit", async () => {
        const stalled = serve(() => new Response(new ReadableStream({ start() {} })))
        const dir = slot()
        try {
            await expect(downloadWithFetch(`http://127.0.0.1:${stalled.port}/x`, path.join(dir, "a"), 10, 1024, 300)).rejects.toThrow(/timed out/)
            expect(fs.readdirSync(dir)).toEqual([])
        } finally {
            stalled.stop(true)
        }
    })

    it("refuses a body below the minimum without keeping it", async () => {
        const small = serve(() => new Response(new Uint8Array(10)))
        const dir = slot()
        try {
            await expect(downloadWithFetch(`http://127.0.0.1:${small.port}/x`, path.join(dir, "a"), 1024)).rejects.toThrow(/too small/)
            expect(fs.readdirSync(dir)).toEqual([])
        } finally {
            small.stop(true)
        }
    })

    it("writes the file when the download succeeds", async () => {
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new Uint8Array(2048)) })
        const dir = fs.mkdtempSync(path.join(root, "dl-"))
        try {
            const dest = path.join(dir, "ok.ptau")
            await downloadWithFetch(`http://127.0.0.1:${server.port}/x`, dest, 1024)
            expect(fs.readdirSync(dir)).toEqual(["ok.ptau"])
        } finally {
            server.stop(true)
        }
    })
})

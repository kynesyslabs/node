import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { runCli } from "./cli"
import { inspectBatchArtifacts, runL2psZkSetup, type ZkRunner } from "./zk"
import { fakeRunner, installZkTools, makeRoot, recorder, removeRoot, writeSubnet, writeZkBatch } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

const keysDir = (size: number) => path.join(root, "src/libs/l2ps/zk/keys", `batch_${size}`)
const COMMITTED = { protocol: "plonk", power: 14 }

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
    return out.sort()
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
        const out = await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ protocol: "plonk", power: 99 }) }), recorder().say)
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
        seedCommitted({ protocol: "plonk", power: 14, curve: "bn128" })
        const reordered = JSON.stringify({ curve: "bn128", power: 14, protocol: "plonk" })
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
            toolchain({ vkeyJson: JSON.stringify({ protocol: "plonk", power: 1 }) }),
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
const hasGit = fs.existsSync(path.join(repo, ".git")) && spawnSync("git", ["--version"]).status === 0

describe.skipIf(!hasGit)("what git is told to ignore", () => {
    const ignored = (file: string) => spawnSync("git", ["check-ignore", "-q", file], { cwd: repo }).status === 0

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

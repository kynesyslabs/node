import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { collectChecks } from "./checks"
import { childEnv, createDefaultRunner } from "./runner"
import { CODE_ROOT, createContext } from "./context"
import { batchVkeyProblem, inspectBatchArtifacts, missingZkTools, runL2psZkSetup } from "./zk"
import { BATCH_VKEY, fakeRunner, makeRoot, recorder, removeRoot, writeSubnet, writeZkBatch } from "./testSupport"

let root: string
beforeEach(() => {
    root = makeRoot()
})
afterEach(() => removeRoot(root))

const keysDir = (size: number) => path.join(root, "src/libs/l2ps/zk/keys", `batch_${size}`)

function seedCommittedVkeys(content: object) {
    for (const size of [5, 10]) {
        fs.mkdirSync(keysDir(size), { recursive: true })
        fs.writeFileSync(path.join(keysDir(size), "verification_key.json"), JSON.stringify(content))
    }
}

describe("runL2psZkSetup", () => {
    it("downloads the ptau files, builds both sizes and keeps the committed verification key", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        const runner = fakeRunner()
        const r = recorder()
        const out = await runL2psZkSetup(root, runner, r.say)
        expect(out.ok).toBe(true)
        expect(runner.calls).toEqual([
            "download powersOfTau28_hez_final_16.ptau",
            "circom2 compile",
            "snarkjs plonk setup",
            "snarkjs zkey export",
            "download powersOfTau28_hez_final_17.ptau",
            "circom2 compile",
            "snarkjs plonk setup",
            "snarkjs zkey export",
        ])
        expect(inspectBatchArtifacts(root).every(b => b.complete)).toBe(true)
        expect(fs.existsSync(path.join(keysDir(5), "verification_key.generated.json"))).toBe(false)
    })

    it("refuses to ship a key whose verification key differs from the committed one", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        const out = await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ ...BATCH_VKEY, power: 15 }) }), recorder().say)
        expect(out.ok).toBe(false)
        expect(out.messages.join()).toContain("differs from the committed one")
        // The committed file is untouched and the unusable proving key is gone.
        expect(JSON.parse(fs.readFileSync(path.join(keysDir(5), "verification_key.json"), "utf8")).power).toBe(14)
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5.zkey"))).toBe(false)
    })

    it("stops at the first failing step and says which", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        const runner = fakeRunner({ failOn: "plonk setup" })
        const out = await runL2psZkSetup(root, runner, recorder().say)
        expect(out.ok).toBe(false)
        expect(out.messages[0]).toContain("Generating the proving key")
        expect(runner.calls.filter(c => c.startsWith("download"))).toHaveLength(1)
    })

    it("falls back to the next host and explains how to recover when none works", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        const tried: string[] = []
        const runner = fakeRunner()
        runner.download = async url => {
            tried.push(url)
            throw new Error("HTTP 403")
        }
        const out = await runL2psZkSetup(root, runner, recorder().say, [5])
        expect(out.ok).toBe(false)
        expect(tried).toHaveLength(2)
        expect(out.messages[0]).toContain("--ptau-url")
        expect(out.messages[0]).toContain("HTTP 403")

        const second = fakeRunner()
        let n = 0
        const real = second.download
        second.download = async (url, dest, min) => {
            if (n++ === 0) throw new Error("HTTP 403")
            return real(url, dest, min)
        }
        expect((await runL2psZkSetup(root, second, recorder().say, [5])).ok).toBe(true)
    })

    it("uses a mirror given by the operator", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        const urls: string[] = []
        const runner = fakeRunner()
        const real = runner.download
        runner.download = async (url, dest, min) => {
            urls.push(url)
            return real(url, dest, min)
        }
        await runL2psZkSetup(root, runner, recorder().say, [5], ["https://mirror.example/ptau/"])
        expect(urls).toEqual(["https://mirror.example/ptau/powersOfTau28_hez_final_16.ptau"])
    })

    it("skips batch sizes that are already built and valid", async () => {
        writeZkBatch(root, 5)
        const runner = fakeRunner()
        const r = recorder()
        const out = await runL2psZkSetup(root, runner, r.say, [5])
        expect(out.ok).toBe(true)
        expect(runner.calls).toEqual([])
        expect(r.text()).toContain("already built")
    })

    it("rebuilds a size whose verification key is unreadable", async () => {
        writeZkBatch(root, 5)
        fs.writeFileSync(path.join(keysDir(5), "verification_key.json"), "{ nope")
        const runner = fakeRunner()
        await runL2psZkSetup(root, runner, recorder().say, [5])
        expect(runner.calls.length).toBeGreaterThan(0)
    })

    it("never deletes a good proving key when a new build does not match", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        // zkey present but wasm missing: the size counts as incomplete and is rebuilt.
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "previous-good")
        const out = await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ ...BATCH_VKEY, power: 15 }) }), recorder().say, [5])
        expect(out.ok).toBe(false)
        expect(fs.readFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "utf8")).toBe("previous-good")
        expect(fs.readdirSync(keysDir(5)).filter(f => f.endsWith(".building"))).toEqual([])
    })

    it("builds under a temporary name and swaps it in only after the key matches", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "old")
        const runner = fakeRunner()
        const seen: string[] = []
        const realExec = runner.exec
        runner.exec = async (cmd, args, cwd) => {
            if (args[0] === "plonk") seen.push(args[args.length - 1])
            return realExec(cmd, args, cwd)
        }
        await runL2psZkSetup(root, runner, recorder().say, [5])
        expect(seen).toEqual([path.join(keysDir(5), ".building", "l2ps_batch_5.zkey")])
        expect(fs.readFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "utf8")).toBe("zkey")
        expect(fs.readdirSync(keysDir(5)).filter(f => f.endsWith(".building"))).toEqual([])
    })

    it("a failed build leaves no compiled files behind, so an old zkey cannot look finished", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        fs.writeFileSync(path.join(keysDir(10), "l2ps_batch_10.zkey"), "old")
        const out = await runL2psZkSetup(root, fakeRunner({ failOn: "plonk setup" }), recorder().say, [10])
        expect(out.ok).toBe(false)
        expect(fs.existsSync(path.join(keysDir(10), "l2ps_batch_10_js"))).toBe(false)
        expect(inspectBatchArtifacts(root).find(b => b.size === 10)?.complete).toBe(false)
        expect(fs.readFileSync(path.join(keysDir(10), "l2ps_batch_10.zkey"), "utf8")).toBe("old")
        expect(fs.existsSync(path.join(keysDir(10), ".building"))).toBe(false)
    })

    it("a key mismatch also leaves no wasm behind", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "old")
        await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ ...BATCH_VKEY, power: 15 }) }), recorder().say, [5])
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5_js"))).toBe(false)
        expect(inspectBatchArtifacts(root).find(b => b.size === 5)?.complete).toBe(false)
    })

    it("replaces an older wasm only after the whole batch succeeded", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        fs.mkdirSync(path.join(keysDir(5), "l2ps_batch_5_js"), { recursive: true })
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5_js", "stale.txt"), "x")
        await runL2psZkSetup(root, fakeRunner(), recorder().say, [5])
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5_js", "stale.txt"))).toBe(false)
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5_js", "l2ps_batch_5.wasm"))).toBe(true)
    })

    it("skips a ptau file that is already downloaded", async () => {
        seedCommittedVkeys(BATCH_VKEY)
        const ptauDir = path.join(root, "src/libs/l2ps/zk/ptau")
        fs.mkdirSync(ptauDir, { recursive: true })
        fs.writeFileSync(path.join(ptauDir, "powersOfTau28_hez_final_16.ptau"), Buffer.alloc(1_500_000))
        const runner = fakeRunner()
        await runL2psZkSetup(root, runner, recorder().say, [5])
        expect(runner.calls.some(c => c.startsWith("download"))).toBe(false)
    })
})

describe("missingZkTools", () => {
    it("lists the build tools that are not installed", () => {
        expect(missingZkTools(root)).toHaveLength(3)
    })
})

describe("the toolchain child process gets a minimal environment", () => {
    const SECRETS = { DEMOS_SETUP_L2PS_KEY: "ab".repeat(32), DEMOS_SETUP_L2PS_IV: "cd".repeat(16), GITHUB_TOKEN: "t" }

    it("passes only the search path, home, runtime options and temp directory", () => {
        const env = childEnv({ PATH: "/usr/bin", HOME: "/h", NODE_OPTIONS: "--x", TMPDIR: "/t", LANG: "C", ...SECRETS })
        expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", NODE_OPTIONS: "--x", TMPDIR: "/t" })
    })

    it("a spawned command does not see the key variables, but still finds its tools", async () => {
        const saved = { ...process.env }
        Object.assign(process.env, SECRETS)
        try {
            const sh = "/bin/sh"
            const code = await createDefaultRunner().exec(sh, ["-c", 'test -z "$DEMOS_SETUP_L2PS_KEY" && test -z "$DEMOS_SETUP_L2PS_IV" && test -z "$GITHUB_TOKEN" && test -n "$PATH"'], root)
            expect(code).toBe(0)
        } finally {
            for (const k of Object.keys(SECRETS)) {
                if (saved[k] === undefined) delete process.env[k]
                else process.env[k] = saved[k]
            }
        }
    })
})

describe("a batch verification key counts only when the verifier can use it", () => {
    const vkeyFile = () => path.join(keysDir(5), "verification_key.json")
    const checkZk = () =>
        collectChecks(createContext(root, ".env", { L2PS_ZK_ENABLED: "true" })).items.find(i => i.item === "Batch of up to 5")

    it("accepts the keys committed in the repository", () => {
        for (const size of [5, 10]) {
            expect(batchVkeyProblem(path.join(CODE_ROOT, "src/libs/l2ps/zk/keys", `batch_${size}`, "verification_key.json"))).toBeUndefined()
        }
    })

    it("accepts a complete key", () => {
        writeZkBatch(root, 5)
        expect(inspectBatchArtifacts(root)[0]).toMatchObject({ vkey: true, complete: true })
    })

    it("refuses malformed JSON and says how to fix it", () => {
        writeZkBatch(root, 5)
        fs.writeFileSync(vkeyFile(), "{not json")
        const b = inspectBatchArtifacts(root)[0]
        expect(b).toMatchObject({ vkey: false, complete: false })
        expect(b.vkeyProblem).toContain("not valid JSON")
        writeSubnet(root, "good")
        const item = checkZk()
        expect(item).toMatchObject({ status: "missing", blocking: true })
        expect(item?.detail).toContain("restore src/libs/l2ps/zk/keys/batch_5/verification_key.json")
        expect(item?.fix).toContain("setup --only zk")
    })

    it("refuses valid JSON that lacks fields the verifier reads", () => {
        writeZkBatch(root, 5)
        for (const [mutate, named] of [
            [(k: any) => delete k.X_2, "X_2"],
            [(k: any) => delete k.Qm, "Qm"],
            [(k: any) => (k.S3 = ["only-one"]), "S3"],
            [(k: any) => (k.k1 = ""), "k1"],
            [(k: any) => delete k.nPublic, "nPublic"],
            [(k: any) => (k.protocol = "groth16"), "PLONK"],
            [(k: any) => (k.curve = "bls12381"), "bn128"],
        ] as Array<[(k: any) => unknown, string]>) {
            const key = JSON.parse(JSON.stringify(BATCH_VKEY))
            mutate(key)
            fs.writeFileSync(vkeyFile(), JSON.stringify(key))
            const b = inspectBatchArtifacts(root)[0]
            expect(b.complete).toBe(false)
            expect(b.vkeyProblem).toContain(named)
        }
        for (const bad of ["[]", "null", "42"]) {
            fs.writeFileSync(vkeyFile(), bad)
            expect(inspectBatchArtifacts(root)[0].complete).toBe(false)
        }
    })

    it("does not report a broken key as merely absent, and a missing one still reads as missing", () => {
        writeZkBatch(root, 5, { zkey: true, wasm: true, vkey: false })
        const b = inspectBatchArtifacts(root)[0]
        expect(b).toMatchObject({ vkey: false, vkeyProblem: undefined })
    })
})

describe("the prover only offers batch sizes that are fully built", () => {
    const keys = () => path.join(root, "src/libs/l2ps/zk/keys")
    async function prover() {
        // The node loads this before anything else; the prover's imports need it.
        await import("reflect-metadata")
        const { L2PSBatchProver } = await import("@/libs/l2ps/zk/L2PSBatchProver")
        return new L2PSBatchProver(keys()) as any
    }

    it("lists a size only with proving key, circuit and a usable verification key", async () => {
        writeZkBatch(root, 5, { zkey: true, wasm: false, vkey: true })
        writeZkBatch(root, 10)
        expect((await prover()).getAvailableBatchSizes()).toEqual([10])
        writeZkBatch(root, 5)
        expect((await prover()).getAvailableBatchSizes()).toEqual([5, 10])
        fs.writeFileSync(path.join(keys(), "batch_5", "verification_key.json"), JSON.stringify({ protocol: "plonk" }))
        expect((await prover()).getAvailableBatchSizes()).toEqual([10])
    })

    it("a batch of 3 uses batch 10 while batch 5 is incomplete, and batch 5 once it is built", async () => {
        writeZkBatch(root, 5, { zkey: true, wasm: false, vkey: true })
        writeZkBatch(root, 10)
        expect((await prover()).selectBatchSize(3)).toBe(10)
        writeZkBatch(root, 5)
        expect((await prover()).selectBatchSize(3)).toBe(5)
    })

    it("the setup check says an incomplete size is skipped, and does not block", () => {
        writeSubnet(root, "good")
        writeZkBatch(root, 5, { zkey: true, wasm: false, vkey: true })
        writeZkBatch(root, 10)
        const item = collectChecks(createContext(root, ".env", { L2PS_ZK_ENABLED: "true" })).items.find(i => i.item === "Batch of up to 5")
        expect(item).toMatchObject({ status: "warn", blocking: false })
        expect(item?.detail).toContain("this size is skipped")
        expect(item?.detail).toContain("use batch 10")
    })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { inspectBatchArtifacts, missingZkTools, runL2psZkSetup } from "./zk"
import { fakeRunner, makeRoot, recorder, removeRoot, writeZkBatch } from "./testSupport"

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
        seedCommittedVkeys({ protocol: "plonk" })
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
        seedCommittedVkeys({ protocol: "plonk", power: 14 })
        const out = await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ protocol: "plonk", power: 15 }) }), recorder().say)
        expect(out.ok).toBe(false)
        expect(out.messages.join()).toContain("differs from the committed one")
        // The committed file is untouched and the unusable proving key is gone.
        expect(JSON.parse(fs.readFileSync(path.join(keysDir(5), "verification_key.json"), "utf8")).power).toBe(14)
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5.zkey"))).toBe(false)
    })

    it("stops at the first failing step and says which", async () => {
        seedCommittedVkeys({ protocol: "plonk" })
        const runner = fakeRunner({ failOn: "plonk setup" })
        const out = await runL2psZkSetup(root, runner, recorder().say)
        expect(out.ok).toBe(false)
        expect(out.messages[0]).toContain("Generating the proving key")
        expect(runner.calls.filter(c => c.startsWith("download"))).toHaveLength(1)
    })

    it("falls back to the next host and explains how to recover when none works", async () => {
        seedCommittedVkeys({ protocol: "plonk" })
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
        seedCommittedVkeys({ protocol: "plonk" })
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
        seedCommittedVkeys({ protocol: "plonk", power: 14 })
        // zkey present but wasm missing: the size counts as incomplete and is rebuilt.
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "previous-good")
        const out = await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ protocol: "plonk", power: 15 }) }), recorder().say, [5])
        expect(out.ok).toBe(false)
        expect(fs.readFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "utf8")).toBe("previous-good")
        expect(fs.readdirSync(keysDir(5)).filter(f => f.endsWith(".building"))).toEqual([])
    })

    it("builds under a temporary name and swaps it in only after the key matches", async () => {
        seedCommittedVkeys({ protocol: "plonk" })
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
        seedCommittedVkeys({ protocol: "plonk" })
        fs.writeFileSync(path.join(keysDir(10), "l2ps_batch_10.zkey"), "old")
        const out = await runL2psZkSetup(root, fakeRunner({ failOn: "plonk setup" }), recorder().say, [10])
        expect(out.ok).toBe(false)
        expect(fs.existsSync(path.join(keysDir(10), "l2ps_batch_10_js"))).toBe(false)
        expect(inspectBatchArtifacts(root).find(b => b.size === 10)?.complete).toBe(false)
        expect(fs.readFileSync(path.join(keysDir(10), "l2ps_batch_10.zkey"), "utf8")).toBe("old")
        expect(fs.existsSync(path.join(keysDir(10), ".building"))).toBe(false)
    })

    it("a key mismatch also leaves no wasm behind", async () => {
        seedCommittedVkeys({ protocol: "plonk", power: 14 })
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5.zkey"), "old")
        await runL2psZkSetup(root, fakeRunner({ vkeyJson: JSON.stringify({ protocol: "plonk", power: 15 }) }), recorder().say, [5])
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5_js"))).toBe(false)
        expect(inspectBatchArtifacts(root).find(b => b.size === 5)?.complete).toBe(false)
    })

    it("replaces an older wasm only after the whole batch succeeded", async () => {
        seedCommittedVkeys({ protocol: "plonk" })
        fs.mkdirSync(path.join(keysDir(5), "l2ps_batch_5_js"), { recursive: true })
        fs.writeFileSync(path.join(keysDir(5), "l2ps_batch_5_js", "stale.txt"), "x")
        await runL2psZkSetup(root, fakeRunner(), recorder().say, [5])
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5_js", "stale.txt"))).toBe(false)
        expect(fs.existsSync(path.join(keysDir(5), "l2ps_batch_5_js", "l2ps_batch_5.wasm"))).toBe(true)
    })

    it("skips a ptau file that is already downloaded", async () => {
        seedCommittedVkeys({ protocol: "plonk" })
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

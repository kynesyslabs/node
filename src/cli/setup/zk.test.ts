import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { inspectBatchArtifacts, missingZkTools, runL2psZkSetup } from "./zk"
import { fakeRunner, makeRoot, recorder, removeRoot } from "./testSupport"

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

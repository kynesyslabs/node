import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const SCRIPT = path.resolve(import.meta.dir, "../scripts/ceremony.ts")
const ANSI = /\x1b\[[0-9;]*m/g

let root: string

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ceremony-next-steps-"))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

/** Runs `finalize` in a scratch directory with a stand-in for `npx snarkjs`. */
function runFinalize(): { code: number | null; out: string } {
    const bin = path.join(root, "bin")
    fs.mkdirSync(bin)
    const vkey = JSON.stringify({ vk_gamma_2: ["1"], vk_delta_2: ["2"] })
    fs.writeFileSync(path.join(bin, "npx"), `#!/bin/bash\necho '${vkey}' > "\${@: -1}"\n`, { mode: 0o755 })

    fs.mkdirSync(path.join(root, "zk_ceremony/keys"), { recursive: true })
    fs.mkdirSync(path.join(root, "src/features/zk/keys"), { recursive: true })
    fs.writeFileSync(path.join(root, "publickey_ed25519_0xabc"), "")
    fs.writeFileSync(path.join(root, "zk_ceremony/keys/ceremony_0001.zkey"), "zkey")
    fs.writeFileSync(
        path.join(root, "zk_ceremony/ceremony_state.json"),
        JSON.stringify({
            initiator: "0xabc",
            phase: "contributing",
            currentKey: 1,
            contributors: [{ name: "0xabc", keyNumber: 1, timestamp: 0, attestationHash: "00" }],
            circuitName: "identity_with_merkle",
            r1csHash: "00",
        }),
    )

    const r = Bun.spawnSync([process.execPath, SCRIPT, "finalize"], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    return { code: r.exitCode, out: r.stdout.toString().replace(ANSI, "") + r.stderr.toString().replace(ANSI, "") }
}

describe("ceremony finalize next steps", () => {
    it("points to the zk_ceremony repository, where the SDK loads its keys", () => {
        const { code, out } = runFinalize()
        expect(code).toBe(0)
        expect(out).toContain("Next steps:")
        expect(out).toContain("kynesyslabs/zk_ceremony")
        expect(out).toContain("identity_with_merkle_final.zkey")
        expect(out).toContain("verification_key_merkle.json")
        expect(out).toMatch(/commit/i)
        expect(out).toMatch(/sha256/i)
        expect(out).toMatch(/circuit changed.*identity_with_merkle\.wasm.*sha256/)
    })

    it("does not tell the operator the SDK needs a CDN upload", () => {
        const { out } = runFinalize()
        expect(out).not.toContain("files.demos.sh")
        expect(out).not.toMatch(/CDN/i)
        expect(out).not.toContain("REQUIRED for SDK")
    })
})

const REGENERATE = path.resolve(import.meta.dir, "../../../../scripts/regenerate_zk_keys.sh")

/** Runs regenerate_zk_keys.sh in a scratch directory with `bun` and `node` stubbed out. */
function runRegenerate(): { code: number | null; out: string } {
    const bin = path.join(root, "bin")
    fs.mkdirSync(bin)
    for (const name of ["bun", "node"]) {
        fs.writeFileSync(path.join(bin, name), "#!/bin/bash\nexit 0\n", { mode: 0o755 })
    }
    const r = Bun.spawnSync(["/bin/bash", REGENERATE], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    return { code: r.exitCode, out: r.stdout.toString().replace(ANSI, "") + r.stderr.toString().replace(ANSI, "") }
}

describe("regenerate_zk_keys.sh next steps", () => {
    it("points to the zk_ceremony repository and the SDK pin, not a CDN", () => {
        const { code, out } = runRegenerate()
        expect(code).toBe(0)
        expect(out).toContain("Next Steps:")
        expect(out).toContain("kynesyslabs/zk_ceremony")
        expect(out).toContain("identity_with_merkle_final.zkey")
        expect(out).toMatch(/pinned zk_ceremony commit and the sha256/)
        expect(out).toMatch(/circuit changed.*identity_with_merkle\.wasm.*sha256/)
        expect(out).not.toMatch(/CDN/i)
    })
})

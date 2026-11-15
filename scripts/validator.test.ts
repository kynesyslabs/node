import { afterAll, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workDir = mkdtempSync(join(tmpdir(), "validator-cli-test-"))

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

it("runs the validator CLI and dormant-mode checks in consensus CI", () => {
    const suite = readFileSync(join(import.meta.dir, "test-consensus.sh"), "utf8")
    expect(suite).toContain("scripts/validator.test.ts")
    expect(suite).toContain("docs/runbooks/dormant-mode.test.ts")
})

it("explains that the example peer URL cannot be used as the default RPC", () => {
    writeFileSync(
        join(workDir, "demos_peerlist.json"),
        JSON.stringify({ "0xexample": "https://<host>:53550" }),
    )

    const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "validator.ts"), "stake"],
        { cwd: workDir, stdout: "pipe", stderr: "pipe" },
    )

    expect(result.exitCode).toBe(1)
    expect(String(result.stderr)).toContain(
        "First peer entry in demos_peerlist.json has no usable URL. Set a real validator URL or pass --rpc <url>.",
    )
})

it("uses the URL in an object peer entry as the default RPC", () => {
    writeFileSync(
        join(workDir, "demos_peerlist.json"),
        JSON.stringify({ "0xexample": { url: "http://127.0.0.1:1" } }),
    )

    const result = Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "validator.ts"), "stake"],
        { cwd: workDir, stdout: "pipe", stderr: "pipe" },
    )

    expect(result.exitCode).toBe(1)
    expect(String(result.stderr)).not.toContain("First peer entry in demos_peerlist.json has no usable URL")
    expect(String(result.stderr)).toContain("127.0.0.1:1")
})

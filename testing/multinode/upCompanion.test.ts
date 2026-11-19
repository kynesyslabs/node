// up-companion.sh against a stub `docker` that records each call: the
// companion's database is migrated before the companion starts, and a failed
// migration stops the script before it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const SCRIPT = join(import.meta.dir, "up-companion.sh")

let root: string
let calls: string

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "up-companion-"))
    mkdirSync(join(root, "testing", "multinode"), { recursive: true })
    copyFileSync(SCRIPT, join(root, "testing", "multinode", "up-companion.sh"))
    mkdirSync(join(root, ".test-identity"))
    for (const name of ["companion.mnemonic", "companion.pubkey", "pubkey"]) {
        writeFileSync(join(root, ".test-identity", name), "0xstub\n")
    }
    const bin = join(root, "bin")
    mkdirSync(bin)
    calls = join(root, "calls.log")
    writeFileSync(
        join(bin, "docker"),
        `#!/bin/bash
echo "$*" >> "${calls}"
cat > /dev/null
if [[ "$*" == *"migration:run"* && "\${FAIL_MIGRATE:-}" == 1 ]]; then exit 1; fi
exit 0
`,
    )
    chmodSync(join(bin, "docker"), 0o755)
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
})

function run(env: Record<string, string> = {}) {
    const res = spawnSync("bash", [join(root, "testing", "multinode", "up-companion.sh")], {
        env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, ...env },
        encoding: "utf8",
        input: "",
    })
    const log = readFileSync(calls, "utf8").trim().split("\n")
    return { status: res.status, stderr: res.stderr, log }
}

describe("up-companion.sh", () => {
    it("migrates the companion database before starting the companion", () => {
        const { status, log } = run()
        expect(status).toBe(0)
        const migrate = log.findIndex(l => l.includes("companion bun run migration:run"))
        const up = log.findIndex(l => / up -d .*companion$/.test(l))
        expect(migrate).toBeGreaterThan(-1)
        expect(up).toBeGreaterThan(migrate)
        expect(log[migrate]).toContain("-f testing/multinode/docker-compose.companion.yml")
    })

    it("stops before starting the companion when the migration fails", () => {
        const { status, stderr, log } = run({ FAIL_MIGRATE: "1" })
        expect(status).not.toBe(0)
        expect(stderr).toContain("migration:run failed")
        expect(log.some(l => / up -d /.test(l))).toBe(false)
    })
})

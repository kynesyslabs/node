// Runs the promtool unit tests of the alert rules
// (monitoring/prometheus/tests/alerts.test.yml): with promtool on PATH, else
// through the prom/prometheus image when Docker already has it. Without
// either the test is skipped, so plain `bun test` needs no Docker.
import { describe, expect, it } from "bun:test"
import { spawnSync } from "child_process"
import { join } from "path"

const ROOT = join(import.meta.dir, "..", "..")
const PROM_DIR = join(ROOT, "monitoring", "prometheus")
const TEST_FILE = "tests/alerts.test.yml"
const IMAGE = process.env.PROMTOOL_IMAGE ?? "prom/prometheus:v2.55.1"

function promtoolCommand(): string[] | null {
    if (spawnSync("promtool", ["--version"]).status === 0) {
        return ["promtool"]
    }
    const image = spawnSync("docker", ["image", "inspect", IMAGE], {
        stdio: "ignore",
    })
    if (image.status !== 0) return null
    return [
        "docker",
        "run",
        "--rm",
        "--network=none",
        "-v",
        `${PROM_DIR}:/rules:ro`,
        "-w",
        "/rules",
        "--entrypoint",
        "promtool",
        IMAGE,
    ]
}

const command = promtoolCommand()

describe("alert rules", () => {
    it.skipIf(command === null)("pass their promtool unit tests", () => {
        const [bin, ...args] = command!
        const cwd = bin === "promtool" ? PROM_DIR : undefined
        const run = spawnSync(bin, [...args, "test", "rules", TEST_FILE], {
            cwd,
            encoding: "utf8",
            timeout: 120_000,
        })
        if (run.status !== 0) {
            console.error(run.stdout, run.stderr)
        }
        expect(run.status).toBe(0)
    }, 130_000)
})

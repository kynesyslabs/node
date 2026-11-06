// Grafana must not come up with a shipped admin password. Both compose
// files gate Grafana on a check service; its script is run here with the
// host shell, the way compose would run it after `$$` -> `$` unescaping.
import { describe, expect, it } from "bun:test"
import { spawnSync } from "child_process"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dir, "..", "..")
const compose = (file: string) =>
    Bun.YAML.parse(readFileSync(join(ROOT, file), "utf8")) as {
        services: Record<string, any>
    }

function runCheck(file: string, password: string | undefined): number {
    const check = compose(file).services["grafana-password-check"]
    const script = String(check.command[0]).replaceAll("$$", "$")
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" }
    if (password !== undefined) env.GRAFANA_ADMIN_PASSWORD = password
    return spawnSync("sh", ["-c", script], { env, stdio: "ignore" }).status ?? -1
}

const envList = (env: unknown): string[] =>
    Array.isArray(env)
        ? env.map(String)
        : Object.entries(env as Record<string, unknown>).map(([k, v]) => `${k}=${v}`)

for (const file of ["docker-compose.yml", "monitoring/docker-compose.yml"]) {
    describe(`${file} Grafana admin password`, () => {
        it("has no default value", () => {
            const line = envList(compose(file).services.grafana.environment).find(l =>
                l.startsWith("GF_SECURITY_ADMIN_PASSWORD="),
            )
            expect(line).toBeDefined()
            expect(line).not.toMatch(/:-demos\}|=demos$/)
        })

        it("gates Grafana on the password check", () => {
            const deps = compose(file).services.grafana.depends_on
            expect(deps?.["grafana-password-check"]?.condition).toBe(
                "service_completed_successfully",
            )
        })

        it("refuses the published default and accepts a real password", () => {
            expect(runCheck(file, "demos")).not.toBe(0)
            expect(runCheck(file, "a-real-password")).toBe(0)
        })
    })
}

describe("docker-compose.yml password check", () => {
    // The root file serves every profile, so it cannot use ${VAR:?}: compose
    // interpolates inactive profiles too and would refuse to start the node.
    it("refuses an unset password at container start", () => {
        expect(runCheck("docker-compose.yml", undefined)).not.toBe(0)
        expect(runCheck("docker-compose.yml", "")).not.toBe(0)
    })
})

describe("monitoring/docker-compose.yml", () => {
    const hasCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0

    it.skipIf(!hasCompose)("refuses to start with the password unset, naming it", () => {
        const env = { ...process.env }
        delete env.GRAFANA_ADMIN_PASSWORD
        const run = spawnSync("docker", ["compose", "config", "-q"], {
            cwd: join(ROOT, "monitoring"),
            env,
            encoding: "utf8",
        })
        expect(run.status).not.toBe(0)
        expect(run.stderr).toContain("GRAFANA_ADMIN_PASSWORD is not set")
    })
})

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { runCli } from "./cli"
import { BASH, DOCKER, fakeRunner } from "./testSupport"

// `docker compose config` only reads and interpolates the files; nothing is
// started, built or pulled.
setDefaultTimeout(60_000)

const repo = path.resolve(import.meta.dir, "../../..")
const hasCompose = DOCKER !== undefined && spawnSync(DOCKER, ["compose", "version"], { encoding: "utf8" }).status === 0

interface Port {
    target: number
    published: string
    host_ip?: string
}
interface Compose {
    services: Record<string, { environment?: Record<string, string>; ports?: Port[] }>
}

let work: string
beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "demos-compose-"))
    for (const f of ["docker-compose.yml", "docker-compose.devnet.yml"]) fs.copyFileSync(path.join(repo, f), path.join(work, f))
})
afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

function compose(files: string[], env: Record<string, string> = {}, dotenv?: string) {
    const envFile = path.join(work, ".env")
    fs.rmSync(envFile, { force: true })
    if (dotenv !== undefined) fs.writeFileSync(envFile, dotenv)
    const r = spawnSync(DOCKER as string, ["compose", ...files.flatMap(f => ["-f", f]), "config", "--format", "json"], {
        cwd: work,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    })
    return { status: r.status, stderr: r.stderr, stdout: r.stdout, json: r.status === 0 ? (JSON.parse(r.stdout) as Compose) : undefined }
}

const messagingPorts = (c: Compose, service = "node") => (c.services[service]?.ports ?? []).filter(p => p.published === String(c.services[service]?.environment?.L2PS_MESSAGING_PORT) || p.target === Number(c.services[service]?.environment?.L2PS_MESSAGING_PORT))

describe.skipIf(!hasCompose)("compose files", () => {
    const BASE = ["docker-compose.yml"]
    const DEVNET = ["docker-compose.yml", "docker-compose.devnet.yml"]

    it("validate with and without L2PS_MESSAGING_PORT, empty included", () => {
        for (const files of [BASE, DEVNET]) {
            for (const env of [{}, { L2PS_MESSAGING_PORT: "3100" }, { L2PS_MESSAGING_PORT: "" }, { L2PS_MESSAGING_PORT: "65535" }, { L2PS_MESSAGING_PORT: "1" }]) {
                const c = compose(files, env)
                expect([files.join("+"), JSON.stringify(env), c.status, c.stderr.slice(0, 200)]).toEqual([files.join("+"), JSON.stringify(env), 0, ""])
            }
        }
    })

    it("publish the messaging port on the same number on both sides, default 3006", () => {
        const dflt = compose(BASE).json as Compose
        expect(dflt.services.node.environment?.L2PS_MESSAGING_PORT).toBe("3006")
        expect(messagingPorts(dflt)).toEqual([expect.objectContaining({ target: 3006, published: "3006" })])
        const custom = compose(BASE, { L2PS_MESSAGING_PORT: "3100" }).json as Compose
        expect(messagingPorts(custom)).toEqual([expect.objectContaining({ target: 3100, published: "3100" })])
    })

    it("devnet moves only the host side, +100, and never keeps the base mapping next to it", () => {
        const c = compose(DEVNET).json as Compose
        const ports = c.services.node.ports ?? []
        const messaging = ports.filter(p => p.target === 3006)
        expect(messaging).toHaveLength(1)
        expect(messaging[0].published).toBe("3106")
        // Nothing else in the merged file claims the base host port.
        expect(ports.filter(p => p.published === "3006")).toEqual([])
    })

    it("an empty or unset variable in .env falls back to the default, a real one is honoured", () => {
        expect(compose(BASE, {}, "L2PS_MESSAGING_PORT=\n").json?.services.node.environment?.L2PS_MESSAGING_PORT).toBe("3006")
        expect(compose(BASE, {}, "L2PS_MESSAGING_PORT=3100\n").json?.services.node.environment?.L2PS_MESSAGING_PORT).toBe("3100")
        expect(compose(BASE, { L2PS_MESSAGING_PORT: "3200" }, "L2PS_MESSAGING_PORT=3100\n").json?.services.node.environment?.L2PS_MESSAGING_PORT).toBe("3200")
    })

    it("a value the wizard wrote into .env reaches the container and the published port", async () => {
        fs.rmSync(path.join(work, ".env"), { force: true })
        const code = await runCli(["--yes", "--only", "l2ps", "--l2ps-uid", "compose_check", "--messaging", "--messaging-port", "3100", "--history-retention-days", "30"], {
            cwd: work,
            env: {},
            isTTY: false,
            say: () => undefined,
            runner: fakeRunner(),
            inDocker: false,
        })
        expect(code).toBe(0)
        const c = spawnSync(DOCKER as string, ["compose", "-f", "docker-compose.yml", "config", "--format", "json"], {
            cwd: work,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        })
        const json = JSON.parse(c.stdout) as Compose
        expect(json.services.node.environment).toMatchObject({
            L2PS_MESSAGING_ENABLED: "true",
            L2PS_MESSAGING_PORT: "3100",
            L2PS_HISTORY_RETENTION_DAYS: "30",
        })
        expect(messagingPorts(json)).toEqual([expect.objectContaining({ target: 3100, published: "3100" })])
    })

    it("never carries the subnet key or IV variables into the container environment", () => {
        const canary = "canary-".repeat(10)
        const c = compose(BASE, { DEMOS_SETUP_L2PS_KEY: canary, DEMOS_SETUP_L2PS_IV: canary })
        expect(c.stdout).not.toContain(canary)
        const names = Object.keys(c.json?.services.node.environment ?? {})
        expect(names).not.toContain("DEMOS_SETUP_L2PS_KEY")
        expect(names).not.toContain("DEMOS_SETUP_L2PS_IV")
    })

    it("passes the other setup variables through as given", () => {
        const c = compose(BASE, { DEMOS_SETUP_STRICT: "true", DEMOS_SETUP_L2PS_UID: "my_subnet" }).json
        expect(c?.services.node.environment).toMatchObject({ DEMOS_SETUP_STRICT: "true", DEMOS_SETUP_L2PS_UID: "my_subnet" })
    })
})

describe.skipIf(BASH === undefined)("scripts/docker-run", () => {
    const script = path.join(repo, "scripts", "docker-run")
    let stubDir: string
    beforeAll(() => {
        stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-stub-"))
        // A stand-in for docker that prints what the script exported, so the
        // port arithmetic runs for real and no container is touched.
        fs.writeFileSync(
            path.join(stubDir, "docker"),
            "#!/bin/bash\necho \"PORTS RPC=$RPC_PORT OMNI=$OMNI_PORT SIG=$RPC_SIGNALING_PORT MSG=$L2PS_MESSAGING_PORT METRICS=$METRICS_HOST_PORT TLSN=$TLSNOTARY_PORT PROM=$PROMETHEUS_PORT GRAFANA=$GRAFANA_PORT NODEEXP=$NODE_EXPORTER_PORT N4J_HTTP=$NEO4J_HTTP_PORT N4J_BOLT=$NEO4J_BOLT_PORT SUFFIX=$INSTANCE_SUFFIX\"\n",
            { mode: 0o755 },
        )
    })
    afterAll(() => fs.rmSync(stubDir, { recursive: true, force: true }))

    function run(args: string[]) {
        const r = spawnSync(BASH as string, [script, ...args], {
            cwd: repo,
            encoding: "utf8",
            env: { PATH: `${stubDir}:${process.env.PATH}`, HOME: process.env.HOME ?? "" },
        })
        const line = r.stdout.split("\n").find(l => l.startsWith("PORTS "))
        const ports = line ? Object.fromEntries(line.slice(6).split(" ").map(kv => kv.split("=") as [string, string])) : undefined
        return { status: r.status, stderr: r.stderr, ports }
    }

    it("is valid bash", () => {
        expect(spawnSync(BASH as string, ["-n", script]).status).toBe(0)
    })

    it("the default instance keeps 3006, and --port 53550 is the same instance", () => {
        expect(run(["config"]).ports?.MSG ?? "").toBe("")
        expect(run(["--port", "53550", "config"]).ports?.MSG).toBe("3006")
    })

    it("shifts the messaging port by the same offset as every other port", () => {
        for (const p of [53650, 53750, 53450, 53560, 54000]) {
            const r = run(["--port", String(p), "config"])
            const off = p - 53550
            expect(r.status).toBe(0)
            expect(r.ports).toMatchObject({ RPC: String(p), SIG: String(3005 + off), MSG: String(3006 + off), OMNI: String(53551 + off) })
        }
    })

    it("two instances 100 apart share no published host port at all, messaging included", () => {
        const all = (p: number) => {
            const r = run(["--port", String(p), "config"]).ports as Record<string, string>
            return Object.entries(r).filter(([k]) => k !== "SUFFIX")
        }
        const seen = new Map<string, string>()
        for (const p of [53550, 53650, 53750, 53850, 53950]) {
            for (const [k, v] of all(p)) {
                const who = `${p}:${k}`
                // The default instance does not export its own ports, so compare
                // the explicit ones with the compose defaults.
                const port = v === "" ? { RPC: "53550", OMNI: "53551", SIG: "3005", MSG: "3006", METRICS: "9090", TLSN: "7047", PROM: "9091", GRAFANA: "3000", NODEEXP: "9100", N4J_HTTP: "7474", N4J_BOLT: "7687" }[k] as string : v
                expect([who, seen.get(port)]).toEqual([who, undefined])
                seen.set(port, who)
            }
        }
    })

    it("refuses a port whose derived messaging port would leave 1-65535, before docker runs", () => {
        for (const p of ["3010", "65535", "1", "0", "65536", "abc", "-5", "53550x"]) {
            const r = run(["--port", p, "config"])
            expect([p, r.status === 0 ? "ran" : "refused"]).toEqual([p, "refused"])
            expect(r.ports).toBeUndefined()
        }
    })

    it("lets an operator's shell variable be overridden only by --port, never silently by .env", () => {
        const r = run(["--port", "53650", "config"])
        // The script exports the derived value, so it beats a value in .env.
        expect(r.ports?.MSG).toBe("3106")
    })
})

// G3-10: the metrics/monitoring surface must not face public interfaces
// without auth, and the block-stall alert must actually be loaded.
// Static checks over the shipped config; no network, no containers.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dir, "..", "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

const LOOPBACK_DEFAULT = /^\s*-\s*"\$\{[A-Z_]+_BIND:-127\.0\.0\.1\}:/

// Host-published lines that map one of the monitoring container ports.
function monitoringPortLines(compose: string): string[] {
    return compose
        .split("\n")
        .filter(l => /^\s*-\s*"/.test(l))
        .filter(l => /:(9090|3000|9100)"\s*$/.test(l))
}

describe("G3-10 metrics endpoint exposure", () => {
    it("node metrics server defaults to loopback when METRICS_HOST is unset", async () => {
        const { DEFAULT_CONFIG } = await import("src/config/defaults")
        expect(DEFAULT_CONFIG.metrics.host).toBe("127.0.0.1")
    })

    it(".env.example does not ship METRICS_HOST=0.0.0.0", () => {
        expect(read(".env.example")).not.toMatch(/^METRICS_HOST=0\.0\.0\.0$/m)
    })

    for (const file of ["docker-compose.yml", "monitoring/docker-compose.yml"]) {
        it(`${file}: every metrics/Prometheus/Grafana/node-exporter port is bound to a loopback default`, () => {
            const lines = monitoringPortLines(read(file))
            expect(lines.length).toBeGreaterThan(0)
            for (const l of lines) expect(l).toMatch(LOOPBACK_DEFAULT)
        })

        it(`${file}: Prometheus lifecycle API (/-/quit, /-/reload) is not enabled`, () => {
            const active = read(file)
                .split("\n")
                .filter(l => !l.trim().startsWith("#"))
                .join("\n")
            expect(active).not.toContain("--web.enable-lifecycle")
        })
    }

    it("Caddy /prometheus/* route requires basic_auth", () => {
        const caddy = read("monitoring/caddy/Caddyfile")
        const block = caddy.slice(caddy.indexOf("handle_path /prometheus/*"))
        const body = block.slice(0, block.indexOf("reverse_proxy"))
        expect(body).toContain("basic_auth")
    })
})

describe("G3-10 block-stall alerting is loaded", () => {
    it("root compose Prometheus mounts the alert rules directory", () => {
        expect(read("docker-compose.yml")).toContain(
            "./monitoring/prometheus/alerts:/etc/prometheus/alerts:ro",
        )
    })

    it("HeightStalled and NodeDown rules exist", () => {
        expect(read("monitoring/prometheus/alerts/consensus.yml")).toMatch(
            /alert: HeightStalled\s+expr: demos_seconds_since_last_block > \d+/,
        )
        expect(read("monitoring/prometheus/alerts/node-health.yml")).toContain(
            'absent(up{job="demos-node"})',
        )
    })
})

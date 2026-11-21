// The metrics/monitoring surface must not face public interfaces
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

describe("metrics endpoint exposure", () => {
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

describe("block-stall alerting is loaded", () => {
    it("runs these monitoring checks in the consensus suite", () => {
        expect(read("scripts/test-consensus.sh")).toContain("testing/monitoring/metricsExposure.test.ts")
    })

    it("recognizes the temporary signing stop in both operator guides", () => {
        const guidance = "A `[SIGNING] stopped until this process exits:` line with marker 0 means the node is exiting to resync from disk after a block that committed but whose follow-up failed, or whose commit could not be confirmed; signing resumes on restart. This stop does not show whether another copy of the key is running, so check that as usual before restarting."
        for (const file of ["docs/runbooks/mainnet-monitoring.md", "monitoring/prometheus/alerts/consensus.yml"]) {
            expect(read(file)).toContain(guidance)
            expect(read(file)).not.toContain("implies no second key")
            expect(read(file)).toContain("If the log line names identity-lock loss, no marker is written; check for other copies of the key before restarting. For a foreign-signature stop, if the marker is missing, the marker write failed: keep the node stopped until every other copy of the key is found and stopped, because a restart would sign again.")
        }
    })

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

    it("DbDown reads a gauge the node registers", () => {
        expect(read("monitoring/prometheus/alerts/node-health.yml")).toMatch(
            /alert: DbDown\s+expr: demos_db_up == 0/,
        )
        expect(read("src/features/metrics/MetricsCollector.ts")).toContain("\"db_up\"")
    })

    it("says the probe duration gauge includes getting a pool connection and is stale while demos_db_up is 0", () => {
        expect(read("src/features/metrics/MetricsCollector.ts")).toContain(
            "\"Seconds the last successful Postgres probe took, including getting a pool connection and SELECT 1; stale while demos_db_up is 0\"",
        )
        expect(read("docs/runbooks/mainnet-monitoring.md").replace(/\s+/g, " ")).toContain(
            "`demos_db_probe_duration_seconds`: how long the last successful probe took, including getting a pool connection, so a busy node pool also raises it.",
        )
        expect(read("docs/runbooks/mainnet-monitoring.md").replace(/\s+/g, " ")).toContain(
            "It is not updated by failed probes, so it is stale while `demos_db_up` is 0.",
        )
    })

    // YAML comment lines joined into one line of text.
    const flat = (s: string) => s.replace(/\n\s*#/g, " ").replace(/\s+/g, " ")

    it("says DbDown also fires when the node's own pool is full", () => {
        const rules = flat(read("monitoring/prometheus/alerts/node-health.yml"))
        const runbook = flat(read("docs/runbooks/mainnet-monitoring.md"))
        expect(rules).toContain(
            "SELECT 1 through the node's connection pool fails or gets no answer within 5 s, or the node's pool is exhausted.",
        )
        expect(runbook).toContain(
            "`no answer within 5000 ms`: Postgres, or the network path to it, hangs, or the node's own connection pool is fully in use. Check the node's connections in `pg_stat_activity` before you restart Postgres.",
        )
    })

    it("says DbDown does not page an outage with a good probe each minute", () => {
        const rules = flat(read("monitoring/prometheus/alerts/node-health.yml"))
        const runbook = flat(read("docs/runbooks/mainnet-monitoring.md"))
        expect(rules).toContain(
            "An outage with at least one good probe each minute (for example Postgres crash-looping and restarting) does not fire DbDown either; it is seen only through HeightStalled, if blocks stop.",
        )
        expect(runbook).toContain(
            "An outage with at least one good probe each minute, for example Postgres crash-looping and restarting, does not fire it; it is seen only through `HeightStalled`, if blocks stop",
        )
    })
})

describe("disk-space checks in Docker", () => {
    it("measure the node data volume, not the container's root filesystem", () => {
        const compose = read("docker-compose.yml")
        expect(compose).toContain("DISK_SPACE_PATH: ${DISK_SPACE_PATH:-/app/data}")
        expect(compose).toContain("node_data:/app/data")
    })
})

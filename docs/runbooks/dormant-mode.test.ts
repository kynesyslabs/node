import { expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

it("requires a reachable validator when replacing stale peers", () => {
    const runbook = readFileSync(join(import.meta.dir, "dormant-mode.md"), "utf8")
    const recovery = runbook.split("### Force re-bootstrap (advanced)")[1]?.split("\n## ")[0]
    const manualSeed = runbook.split("### Seed a peer manually")[1]?.split("\n### ")[0]
    const example = manualSeed?.match(/```json\s*([\s\S]*?)\s*```/)

    expect(recovery).toContain("reachable validator")
    expect(recovery).not.toContain("forces re-discovery")
    expect(recovery).not.toContain("rm demos_peerlist.json")
    expect(recovery).not.toContain("cp demos_peerlist.json.example demos_peerlist.json")
    expect(recovery).toContain("format in \"Seed a peer manually\"")
    expect(example).not.toBeNull()
    const peerList: unknown = JSON.parse(example?.[1] ?? "")
    expect(peerList).toEqual({
        "<peer-public-key-hex>": "https://bootstrap.example.com",
    })
})

it("recreates instances through the launcher with their original flags", () => {
    const runbook = readFileSync(join(import.meta.dir, "dormant-mode.md"), "utf8")
    const example = runbook.split("### Use `demos_peerlist.json.example`")[1]?.split("\n### ")[0]
    const manual = runbook.split("### Seed a peer manually")[1]?.split("\n### ")[0]
    const force = runbook.split("### Force re-bootstrap (advanced)")[1]?.split("\n## ")[0]

    expect(example).toContain("# edit demos_peerlist.json: set a real validator key and URL")
    for (const section of [manual, example, force]) {
        expect(section).toContain("scripts/docker-run")
        expect(section).toContain("up -d --force-recreate node")
        expect(section).not.toContain("docker run --rm")
        expect(section).not.toContain("docker compose \"${COMPOSE_ARGS[@]}\"")
    }
    expect(runbook).toContain("scripts/docker-run --port 53650 up -d --force-recreate node")
    expect(runbook).toContain("scripts/docker-run --devnet up -d --force-recreate node")
    expect(runbook).toContain("scripts/docker-run --proxy up -d --force-recreate node")
    expect(runbook).toContain("scripts/docker-run --db 5433 up -d --force-recreate node")
    expect(runbook).toContain("scripts/docker-run up -d --force-recreate node")
    expect(runbook).toContain("`--port 53650 --db 5433`")
    expect(runbook).not.toContain("`--proxy --port 53650 --db 5433`")
    expect(runbook).not.toContain("--port 53551")
    expect(manual).toMatch(/including `localhost` on a wildcard bind and this node's\s+public URL, are dialed/)
    expect(manual).toContain("error log names the URL")
    expect(runbook).toMatch(/`--proxy` is not safe on a host that\s+already runs another proxied instance/)
})

it("says a hostname bind skips only that hostname", () => {
    const runbook = readFileSync(join(import.meta.dir, "dormant-mode.md"), "utf8")
    const install = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8")
    for (const doc of [runbook, install]) {
        expect(doc).toMatch(/for a wildcard bind \(`0\.0\.0\.0` or\s+`::`\), a numeric loopback address/)
        expect(doc).toMatch(/A hostname bind such as `RPC_BIND=localhost`\s+matches only that hostname/)
        expect(doc).toMatch(/with `RPC_BIND=localhost` an entry for\s+`http:\/\/127\.0\.0\.1:53550` is dialed/)
        expect(doc).not.toContain("covered by the bind")
        expect(doc).not.toContain("covered by this node's")
    }
})

it("words the bootstrap skip comment the same way", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/libs/peer/routines/peerBootstrap.ts"), "utf8")
    expect(source).toMatch(/The exact\s+\* bound host, or a numeric loopback URL when the bind is a wildcard\s+\* \(`0\.0\.0\.0`\/`::`\), on our RPC port, is skipped here/)
    expect(source).not.toContain("covered by the bind")
})

import { describe, expect, it } from "bun:test"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const root = join(import.meta.dir, "../..")
const read = (file: string) => readFileSync(join(root, file), "utf8")
const runbook = read("forking/RUNBOOK_FORK_ACTIVATION.md")
const recovery = runbook.split("### 6.1")[1].split("### 6.2")[0]
const compose = read("docker-compose.yml")
const scripts = JSON.parse(read("package.json")).scripts
function block(heading: string): string {
    const code = runbook
        .split(heading)[1]
        ?.split(/\n###? /)[0]
        ?.match(/```bash\n([\s\S]*?)```/)[1]
    expect(code).toBeDefined()
    return code!
}
function childShell(heading: string): string {
    const code = block(heading)
    return code.slice(code.indexOf("bash -euo pipefail"))
}
function curls(): string[] {
    const lines = runbook.split("\n")
    const commands: string[] = []
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trimStart().startsWith("curl ")) continue
        let command = lines[i]
        while (lines[i].trimEnd().endsWith("\\")) command += "\n" + lines[++i]
        commands.push(command)
    }
    return commands
}
// Runs a runbook snippet in a fresh directory holding `.env`. `bun -e` is
// the real Bun running this test, so `.env` is parsed exactly as the node's
// Bun parses it; only `bun run ...` is stubbed and recorded in `calls`.
// `docker` stands in for the node container: `... exec -T node CMD` runs
// CMD with this process's environment, or fails like a stopped container
// when NODE_STOPPED is set. `./scripts/docker-run` forwards to it as the
// real wrapper does.
async function runWithBun(
    step: string,
    variable: string,
    shellSetting?: string,
    envFile?: string,
    extraEnv: Record<string, string> = {},
) {
    const dir = mkdtempSync(join(tmpdir(), ".runbook-bun-"))
    try {
        const bin = join(dir, "bin")
        const calls = join(dir, "bun-calls")
        mkdirSync(bin)
        writeFileSync(calls, "")
        writeFileSync(
            join(bin, "bun"),
            '#!/bin/sh\nif [ "$1" = run ]; then printf \'%s\\n\' "$*" >> "$BUN_CALLS"; exit 0; fi\nexec "$REAL_BUN" "$@"\n',
            { mode: 0o755 },
        )
        writeFileSync(
            join(bin, "docker"),
            '#!/bin/sh\nif [ -n "$NODE_STOPPED" ]; then echo \'service "node" is not running\' >&2; exit 1; fi\nwhile [ "$#" -gt 0 ] && [ "$1" != node ]; do shift; done\n[ "$#" -gt 0 ] || exit 125\nshift\nexec "$@"\n',
            { mode: 0o755 },
        )
        mkdirSync(join(dir, "scripts"))
        writeFileSync(
            join(dir, "scripts", "docker-run"),
            '#!/bin/sh\nexec docker compose -f docker-compose.yml "$@"\n',
            { mode: 0o755 },
        )
        for (const tool of ["sed", "tail"]) {
            const path = Bun.which(tool)
            if (!path) throw new Error(`Missing test tool: ${tool}`)
            symlinkSync(path, join(bin, tool))
        }
        if (envFile !== undefined) writeFileSync(join(dir, ".env"), envFile)
        const env = {
            ...process.env,
            PATH: bin,
            BUN_CALLS: calls,
            REAL_BUN: process.execPath,
            ...extraEnv,
        }
        delete env.GOSSIP_ENABLED
        delete env.DEMOS_DISABLE_FORK_MACHINERY
        delete env[variable]
        if (shellSetting !== undefined) env[variable] = shellSetting
        const proc = Bun.spawn(["/bin/sh", "-c", step], {
            cwd: dir,
            env,
            stdout: "pipe",
            stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        expect(existsSync(join(bin, "node"))).toBe(false)
        return { stdout, stderr, exitCode, calls: readFileSync(calls, "utf8") }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}
function runSidecarStep(shellSetting?: string, envFile?: string) {
    const step = block("### 4.2")
        .split("bun install --frozen-lockfile\n")[1]
        .split("# 3.")[0]
    return runWithBun(step, "GOSSIP_ENABLED", shellSetting, envFile)
}
function runForkFlagCheck(envFile: string) {
    const step = block("### 2.7")
        .split("\n")
        .find(line => line.startsWith("bun -e "))
    expect(step).toBeDefined()
    return runWithBun(step!, "DEMOS_DISABLE_FORK_MACHINERY", undefined, envFile)
}
// The bare-metal, wrapper and raw Compose fork-flag commands in §2.7.
function forkFlagCommands(): string[] {
    const section = runbook.split("### 2.7")[1].split("### 2.8")[0]
    const lines = section.split("\n")
    const bare = lines.find(line => line.startsWith("bun -e "))
    expect(bare).toBeDefined()
    const commands = [
        bare!,
        `./scripts/docker-run exec -T node ${bare}`,
        `docker compose exec -T node ${bare}`,
    ]
    for (const command of commands) expect(lines).toContain(command)
    return commands
}
async function shell(
    command: string,
    env: Record<string, string> = {},
    pipefail = true,
    cwd = root,
) {
    const proc = Bun.spawn(
        ["bash", ...(pipefail ? ["-o", "pipefail"] : []), "-c", command],
        {
            cwd,
            env: { ...process.env, ...env },
            stdout: "pipe",
            stderr: "pipe",
        },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ])
    return { stdout, stderr, exitCode }
}
describe("fork activation operator commands", () => {
    it("checks the actual fork schema instead of obsolete migration names", () => {
        const section = runbook.split("### 2.5")[1].split("### 2.6")[0]
        expect(section).toContain("fork_state")
        expect(section).toContain("gcr_main")
        expect(section).toContain("numeric")
        expect(section).not.toContain("CreateForkStateTable1714608000000")
    })
    it("shows the actual numeric balance type in the Postgres output", () => {
        expect(runbook.split("### 2.4")[1].split("### 2.5")[0]).toContain(
            "# expected: balance | numeric(38,0) | not null default '0'::numeric",
        )
    })
    it("checks the fork-disable flag in the running container with the node's rule", async () => {
        const section = runbook.split("### 2.7")[1].split("### 2.8")[0]
        expect(section).not.toContain("printenv")
        const commands = forkFlagCommands()
        // Bare metal sees the setting in the shell; the Compose commands
        // see it as the container's environment.
        for (const [setting, exitCode, stdout] of [
            [undefined, 0, "fork machinery enabled\n"],
            ["", 0, "fork machinery enabled\n"],
            ["false", 0, "fork machinery enabled\n"],
            ["0", 0, "fork machinery enabled\n"],
            [" TRUE ", 1, "fork machinery DISABLED\n"],
            ["1", 1, "fork machinery DISABLED\n"],
            ["yes", 1, "fork machinery DISABLED\n"],
        ] as const) {
            for (const command of commands) {
                expect(
                    await runWithBun(
                        command,
                        "DEMOS_DISABLE_FORK_MACHINERY",
                        setting,
                    ),
                ).toMatchObject({ exitCode, stderr: "", stdout })
            }
        }
        for (const command of commands.slice(1)) {
            const stopped = await runWithBun(
                command,
                "DEMOS_DISABLE_FORK_MACHINERY",
                undefined,
                undefined,
                { NODE_STOPPED: "1" },
            )
            expect(stopped.exitCode).not.toBe(0)
            expect(stopped.stdout).toBe("")
        }
        expect(
            section.match(/# expected: fork machinery enabled \(exit 0\)/g),
        ).toHaveLength(3)
    })
    it("explains when the fork-disable flag reaches a Compose container", () => {
        const section = runbook.split("### 2.7")[1].split("### 2.8")[0]
        expect(section).toContain(
            "The stock Compose file does not pass this variable to the container, so a `.env` entry alone does not reach the node; the container shows it only if a compose override or an `environment:` entry adds it. The bare-metal check covers the host `.env`.",
        )
    })
    it("reports the fork machinery disabled for any .env line Bun reads as disabled", async () => {
        for (const envFile of [
            "  DEMOS_DISABLE_FORK_MACHINERY = true\n",
            "DEMOS_DISABLE_FORK_MACHINERY=YES # x\n",
        ]) {
            expect(await runForkFlagCheck(envFile)).toMatchObject({
                exitCode: 1,
                stderr: "",
                stdout: "fork machinery DISABLED\n",
            })
        }
    })
    it("reports the fork machinery enabled when Bun reads it as not disabled", async () => {
        for (const envFile of ["DEMOS_DISABLE_FORK_MACHINERY=false\n", ""]) {
            expect(await runForkFlagCheck(envFile)).toMatchObject({
                exitCode: 0,
                stderr: "",
                stdout: "fork machinery enabled\n",
            })
        }
        expect(block("### 2.7")).toContain("# expected: fork machinery enabled")
    })
    it("builds and checks Compose before stopping the validator", () => {
        const section = runbook.split("### 4.2")[1].split("### 4.3")[0]
        expect(section).toContain(
            "docker compose ps --status running --services",
        )
        expect(section).not.toContain("ps aux")
        expect(section.indexOf("docker compose build node")).toBeLessThan(
            section.indexOf("docker compose stop reaper node"),
        )
        expect(section.indexOf("./scripts/docker-run build node")).toBeLessThan(
            section.indexOf("./scripts/docker-run stop reaper node"),
        )
    })
    it("checks for a still-running bare-metal node before the update", () => {
        const section = block("### 4.2")
        expect(section).toContain("pgrep -af 'src/index.ts'")
        expect(section).toContain("Ctrl+C in its terminal")
        expect(section).toContain("docker ps / docker top")
        expect(section.indexOf("pgrep -af 'src/index.ts'")).toBeLessThan(
            section.indexOf("git checkout <agreed-commit-hash>"),
        )
    })
    it("skips the sidecar build when the shell disables gossip", async () => {
        expect(await runSidecarStep("false")).toMatchObject({
            exitCode: 0,
            stderr: "",
            calls: "",
            stdout: expect.stringContaining("Skipping sidecar build because gossip is off"),
        })
    })
    it("skips the sidecar build for every .env value the node reads as gossip off", async () => {
        for (const envFile of [
            "GOSSIP_ENABLED=false # disabled for this validator\n",
            "  GOSSIP_ENABLED = 0\n",
            "GOSSIP_ENABLED=no\n",
        ]) {
            expect(await runSidecarStep(undefined, envFile)).toMatchObject({
                exitCode: 0,
                stderr: "",
                calls: "",
                stdout: expect.stringContaining("Skipping sidecar build because gossip is off"),
            })
        }
    })
    it("uses the last .env setting when the shell setting is unset", async () => {
        for (const setting of ["false", '"false"']) {
            expect(await runSidecarStep(undefined, `GOSSIP_ENABLED=true\nGOSSIP_ENABLED=${setting}\n`)).toMatchObject({
                exitCode: 0,
                stderr: "",
                calls: "",
                stdout: expect.stringContaining("Skipping sidecar build because gossip is off"),
            })
        }
    })
    it("builds the sidecar when gossip is unset everywhere", async () => {
        expect(await runSidecarStep()).toMatchObject({
            exitCode: 0,
            stderr: "",
            calls: "run sidecar:build\n",
        })
    })
    it("lets the shell enable gossip over a disabled .env", async () => {
        expect(await runSidecarStep("true", "GOSSIP_ENABLED=false\n")).toMatchObject({
            exitCode: 0,
            stderr: "",
            calls: "run sidecar:build\n",
        })
    })
    it("shows migration log lines that the hooks actually emit", () => {
        const section = runbook.split("### 4.4")[1].split("### 4.5")[0]
        const os = read("src/forks/migrations/osDenomination.ts")
        const gas = read("src/forks/migrations/gasFeeSeparation.ts")
        for (const line of [
            "validators migrated (rows=",
            "malformed=",
            "sum invariant verified: postSumOs == preSumDem * 10^9 - valueLostOs",
            "fork_state row persisted; migration complete",
        ])
            expect(section).toContain(line)
        for (const line of [
            "created account at",
            "burnCreated=",
            "treasuryCreated=",
        ])
            expect(section).toContain(line)
        expect(os).toContain("malformed=${malformedValidatorsCount}")
        expect(gas).toContain(
            "burnCreated=${burnAccountCreated}, treasuryCreated=${treasuryAccountCreated}",
        )
        expect(section).not.toContain("global_change_registry migrated")
        expect(section).toContain("Only a missing load-bearing line")
    })
    it("requires head advancement and peer convergence after every restart", () => {
        for (const heading of ["### 4.2", "### 4.3", "### 6.1"]) {
            const section = runbook.split(heading)[1].split(/\n###? /)[0]
            expect(section).toContain("§4.6")
            expect(section).toContain("healthy peer")
        }
        expect(recovery).toContain("peer list file the node reads")
        expect(recovery).toContain("Finished checking")
        expect(read("INSTALL.md")).toContain(
            "does not write them back to `demos_peerlist.json`",
        )
    })
    it("reads the healthy peer's head from its own RPC URL, not this host", async () => {
        const liveness = runbook.split("### 4.6")[1].split(/\n###? /)[0]
        expect(liveness).not.toContain("set `RPC_PROBE_PORT` to its reachable RPC port")
        expect(liveness).toContain("`RPC_PROBE_PORT` only changes the port on this host")
        const probe = [...liveness.matchAll(/```bash\n([\s\S]*?)```/g)]
            .map(m => m[1])
            .find(s => s.includes("HEALTHY_RPC_URL"))
        expect(probe).toBeDefined()
        expect(probe).not.toContain("127.0.0.1")
        const filter = (code: string) => code.match(/jq -Rser '[^']*'/)![0]
        expect(filter(probe!)).toBe(filter(block("### 4.6")))
        for (const flag of [
            "--connect-timeout 2",
            "--max-time 5",
            "--max-filesize 1048576",
            "| head -c 1048577 | jq",
        ])
            expect(probe).toContain(flag)
        const localRequests: string[] = []
        const peerRequests: unknown[] = []
        const local = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(req) {
                localRequests.push(req.url)
                return Response.json({ result: 200, response: 10 })
            },
        })
        let peerResponse: () => Response = () =>
            Response.json({ result: 200, response: 100 })
        const peer = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(req) {
                peerRequests.push({
                    path: new URL(req.url).pathname,
                    body: await req.json(),
                })
                return peerResponse()
            },
        })
        const url = `http://127.0.0.1:${peer.port}/`
        const code = probe!.replace("http://healthy-validator.example:53550/", url)
        const env = { RPC_PROBE_PORT: String(local.port), RPC_PORT: String(local.port) }
        try {
            expect(await shell(code, env, false)).toEqual({
                exitCode: 0,
                stdout: "100\n",
                stderr: "",
            })
            expect(localRequests).toEqual([])
            expect(peerRequests).toEqual([
                {
                    path: "/",
                    body: {
                        method: "nodeCall",
                        params: [{ message: "getLastBlockNumber", data: {} }],
                    },
                },
            ])
            for (const response of [
                () => Response.json({ result: 400, response: "nope" }),
                () => new Response("x".repeat(1048577)),
            ]) {
                peerResponse = response
                const result = await shell(
                    `${code}\nset -o | grep -q '^pipefail[[:space:]]*off' || exit 7\nprintf 'operator-shell-open\\n'`,
                    env,
                    false,
                )
                expect(result.exitCode).toBe(0)
                expect(result.stdout).toBe("operator-shell-open\n")
                expect(result.stderr).toContain(`No head from ${url}`)
            }
            expect(localRequests).toEqual([])
        } finally {
            local.stop(true)
            peer.stop(true)
        }
    })
    it("directs peerlist edits to the file the node reads on each startup path", async () => {
        const liveness = runbook.split("### 4.6")[1].split(/\n###? /)[0]
        const finder = [...liveness.matchAll(/```bash\n([\s\S]*?)```/g)]
            .map(m => m[1])
            .find(s => s.includes("PEER_LIST_FILE"))
        expect(finder).toBeDefined()
        expect(finder).toContain(
            "./scripts/docker-run exec -T node printenv PEER_LIST_FILE",
        )
        expect(finder).toContain("docker compose exec -T node printenv PEER_LIST_FILE")
        expect(finder).toContain(
            "Bare metal ./run: the -l value (default demos_peerlist.json); ./run sets it over any shell or .env value.",
        )
        for (const line of [
            "Wrapper start with `demos_peerlist.json` (the default): edit the repo's `demos_peerlist.json`, which `./scripts/docker-run up` copies into the `node_state` volume.",
            "Raw Compose with `demos_peerlist.json`: edit `demos_peerlist.json` in the `node_state` volume.",
            "`./scripts/docker-run up` copies only the repo's `demos_peerlist.json` to `/app/state/demos_peerlist.json` and does not update this file, so edit this file.",
            "Bare metal: edit the file named above. A relative path is relative to the node checkout.",
        ])
            expect(liveness).toContain(line)
        for (const section of [liveness, recovery])
            expect(section).not.toContain("Bare metal: edit the repo file.")
        expect(recovery).toContain(
            "correct the peer list file the node reads, found and edited as described in §4.6.",
        )
        expect(recovery).not.toContain("Wrapper start")
        // The per-setup statements above follow these code paths.
        const run = read("scripts/run")
        expect(run).toContain('\nPEER_LIST_FILE="demos_peerlist.json"\n')
        expect(run).toContain("l) PEER_LIST_FILE=$OPTARG ;;")
        expect(run).toContain("\nexport PEER_LIST_FILE=$PEER_LIST_FILE\n")
        expect(compose).toContain(
            "PEER_LIST_FILE: ${PEER_LIST_FILE:-demos_peerlist.json}",
        )
        expect(compose).toContain("node_state:/app/state")
        expect(read("Dockerfile")).toContain("WORKDIR /app")
        expect(read("scripts/docker-entrypoint.sh")).toContain(
            "for f in .demos_identity demos_peerlist.json .tlsnotary-key; do",
        )
        const sync = read("scripts/docker-run")
        expect(sync).toContain('HOST_PEERLIST_FILE="${REPO_ROOT}/demos_peerlist.json"')
        expect(sync).toContain("cp /src/demos_peerlist.json /state/demos_peerlist.json")
        expect(sync).not.toMatch(/\$\{?PEER_LIST_FILE/)
        // The bare-metal finder agrees with the node's config loader.
        const oneLiner = finder!.split("\n").find(l => l.startsWith("bun -e "))!
        const loader = `bun -e "import { loadConfig } from '${join(root, "src/config/loader.ts")}'; console.log('loader=' + loadConfig().core.peerListFile)"`
        for (const [shellSetting, envFile, expected] of [
            [undefined, undefined, "demos_peerlist.json"],
            [undefined, "PEER_LIST_FILE=custom.json\n", "custom.json"],
            [undefined, "PEER_LIST_FILE=\n", "demos_peerlist.json"],
            [undefined, "  PEER_LIST_FILE = spaced.json # note\n", "spaced.json"],
            ["/srv/peers.json", "PEER_LIST_FILE=custom.json\n", "/srv/peers.json"],
        ] as const) {
            const result = await runWithBun(
                `${oneLiner}\n${loader}`,
                "PEER_LIST_FILE",
                shellSetting,
                envFile,
            )
            expect(result.exitCode).toBe(0)
            const lines = result.stdout.split("\n")
            expect(lines[0]).toBe(expected)
            expect(lines).toContain(`loader=${expected}`)
            expect(result.calls).toBe("")
        }
    }, 30000)
    it("restarts a wrapper node with the stop and up pair that copies the peer list", async () => {
        const liveness = runbook.split("### 4.6")[1].split(/\n###? /)[0]
        const stop = "./scripts/docker-run stop reaper node"
        const up = "./scripts/docker-run up -d --no-build node reaper"
        expect(liveness).toContain(
            "Fix that file and restart (for a wrapper start with the default file, use the stop and `up` pair below), then repeat this check.",
        )
        const bullet = liveness
            .split("\n")
            .find(l => l.startsWith("- Wrapper start with `demos_peerlist.json`"))
        expect(bullet).toBeDefined()
        for (const text of [
            "The node reads the file only at startup, so restart with the §4.2 pair:",
            "record whether `reaper` is running (`./scripts/docker-run ps --status running --services`)",
            `run \`${stop}\`, then \`${up}\`, omitting \`reaper\` if it was not running.`,
            "`./scripts/docker-run restart` does not copy the file, and `up` alone leaves a running node on the old list.",
        ])
            expect(bullet).toContain(text)
        // §4.2 uses the same pair and reaper rule.
        const update = runbook.split("### 4.2")[1].split("### 4.3")[0]
        for (const text of [
            "./scripts/docker-run ps --status running --services",
            `\`${stop}\``,
            `\`${up}\``,
            "if `reaper` was running; otherwise omit `reaper`",
        ])
            expect(update).toContain(text)
        // The node reads the list once, at startup.
        expect(read("src/index.ts")).toContain("PeerManager.getInstance().loadPeerList()")
        // The real wrapper copies the repo file into node_state only for `up`.
        const dir = mkdtempSync(join(tmpdir(), ".runbook-wrapper-"))
        try {
            mkdirSync(join(dir, "bin"))
            mkdirSync(join(dir, "scripts"))
            writeFileSync(join(dir, "scripts", "docker-run"), read("scripts/docker-run"), {
                mode: 0o755,
            })
            writeFileSync(join(dir, "docker-compose.yml"), "")
            writeFileSync(join(dir, "demos_peerlist.json"), "{}\n")
            const calls = join(dir, "docker-calls")
            writeFileSync(
                join(dir, "bin", "docker"),
                '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$DOCKER_CALLS"\n',
                { mode: 0o755 },
            )
            const env = {
                PATH: `${join(dir, "bin")}:${process.env.PATH}`,
                DOCKER_CALLS: calls,
            }
            const docker = async (command: string) => {
                writeFileSync(calls, "")
                const result = await shell(command, env, true, dir)
                expect(result.exitCode).toBe(0)
                return readFileSync(calls, "utf8")
            }
            const copy = "cp /src/demos_peerlist.json /state/demos_peerlist.json"
            const composeCall = (args: string) =>
                new RegExp(`^compose -f docker-compose\\.yml(?: --profile \\S+)* ${args}$`, "m")
            const restarted = await docker("./scripts/docker-run restart node")
            expect(restarted).toMatch(composeCall("restart node"))
            expect(restarted).not.toContain(copy)
            const paired = await docker(`${stop}\n${up}`)
            const stopAt = paired.search(composeCall("stop reaper node"))
            const copyAt = paired.indexOf(copy)
            const upAt = paired.search(composeCall("up -d --no-build node reaper"))
            expect(stopAt).toBeGreaterThanOrEqual(0)
            expect(copyAt).toBeGreaterThan(stopAt)
            expect(upAt).toBeGreaterThan(copyAt)
            expect(paired.slice(stopAt, upAt)).toContain(
                `run --rm -v demos_node_state:/state -v ${dir}/demos_peerlist.json:/src/demos_peerlist.json:ro alpine sh -c`,
            )
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }, 30000)
    it("states the jq version the RPC probes need at the top of the pre-flight checklist", () => {
        const intro = runbook.split("## 2. Pre-flight checklist")[1].split("### 2.1")[0]
        // Every probe that bounds a reply uses utf8bytelength (jq 1.6+).
        const sections = runbook
            .split(/\n(?=### )/)
            .filter(s => s.includes("jq -Rser 'select(utf8bytelength"))
            .map(s => s.match(/^### (\d+\.\d+)/)?.[1])
        expect(sections).toEqual(["3.1", "4.5", "4.6", "6.1"])
        expect(intro).toContain(
            "The RPC probes in §3.1, §4.5, §4.6 and §6.1 need jq 1.6 or later (`jq --version`): they use `utf8bytelength`, so an older jq fails every probe",
        )
    })
    it("allows an advancing restored head time to catch up", () => {
        for (const heading of ["### 4.6", "### 6.1"]) {
            const section = runbook.split(heading)[1].split(/\n###? /)[0]
            expect(section).toContain(
                "A head that keeps advancing toward the peer is catching up",
            )
            expect(section).toContain(
                "fix the peerlist only if it does not advance",
            )
        }
        expect(recovery).toContain(
            "Head not advancing five minutes after restart, or no longer closing the gap to a healthy peer, even when the loader and digest checks passed.",
        )
    })
    it("keeps empty-database joins on the backup-or-core-team path", () => {
        expect(recovery).toContain(
            "A validator joining an existing chain with an empty database (new, or after losing its disk) has no documented self-service path: restore a verified backup from the intended chain as below, or contact the core team.",
        )
        const row = read("testing/forks/REHEARSAL.md")
            .split("| Empty-database node booted on the edited file |")[1]
            .split("\n")[0]
        expect(row).toContain("join an existing chain")
        expect(row).toContain("verified backup")
        expect(row).toContain("core team")
    })
    it("uses existing Bun scripts and builds Compose images with provenance", () => {
        const calls = [...runbook.matchAll(/\bbun run ([\w:-]+)/g)].map(
            m => m[1],
        )
        expect(calls.length).toBeGreaterThan(0)
        expect(calls.filter(name => !(name in scripts))).toEqual([])
        expect(block("### 2.1")).toContain("bun install --frozen-lockfile")
        for (const heading of ["### 2.1", "### 4.2"])
            expect(block(heading)).not.toContain("bun run type-check")
        expect(runbook).toContain("./scripts/docker-run up -d --no-build node")
    })
    it("posts both height checks to the RPC root and reads scalar heights", async () => {
        expect(compose).toContain("RPC_PORT: ${RPC_PORT:-53550}")
        const commands = [block("### 3.1"), block("### 4.6")].map(section =>
            curls().find(command => section.includes(command)),
        )
        expect(commands.every(Boolean)).toBe(true)
        const requests: unknown[] = []
        let response = { result: 200, response: 0 as unknown }
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(req) {
                requests.push({
                    method: req.method,
                    path: new URL(req.url).pathname,
                    contentType: req.headers.get("content-type"),
                    body: await req.json(),
                })
                return Response.json(response)
            },
        })
        try {
            for (const command of commands) {
                expect(command).toContain("${RPC_PORT:-53550}")
                for (const height of [0, 123]) {
                    response = { result: 200, response: height }
                    const result = await shell(command!, {
                        RPC_PORT: String(server.port),
                    })
                    expect(result).toEqual({
                        exitCode: 0,
                        stdout: `${height}\n`,
                        stderr: "",
                    })
                }
                response = { result: 503, response: "STATE_NOT_READY" }
                expect(
                    (await shell(command!, { RPC_PORT: String(server.port) }))
                        .exitCode,
                ).not.toBe(0)
            }
            expect(requests).toHaveLength(6)
            for (const request of requests)
                expect(request).toEqual({
                    method: "POST",
                    path: "/",
                    contentType: "application/json",
                    body: {
                        method: "nodeCall",
                        params: [{ message: "getLastBlockNumber", data: {} }],
                    },
                })
        } finally {
            server.stop(true)
        }
    })
    it("queries block hashes using the handler's blockNumber input", async () => {
        const requests: unknown[] = []
        const fetch = async (req: Request) => {
            requests.push({
                method: req.method,
                path: new URL(req.url).pathname,
                body: await req.json(),
            })
            return Response.json({
                result: 200,
                response: { hash: "fork-block-hash" },
            })
        }
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
        const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
        try {
            const urls = `http://127.0.0.1:${server.port} http://127.0.0.1:${server.port}/ http://127.0.0.1:${peer.port}/`
            const result = await shell(childShell("### 4.5"), {
                N: "42",
                RPC_URLS: urls,
            })
            expect(result).toMatchObject({ exitCode: 0, stderr: "" })
            expect(result.stdout.trim().split("\n").sort()).toEqual(
                [
                    `http://127.0.0.1:${server.port} fork-block-hash`,
                    `http://127.0.0.1:${peer.port} fork-block-hash`,
                    "OK: block 42 hash fork-block-hash on all 2 validators",
                ].sort(),
            )
            for (const invalidUrls of [
                "",
                `http://127.0.0.1:${server.port}/`,
                `http://127.0.0.1:${server.port}/ http://127.0.0.1:${server.port}`,
            ]) {
                const invalid = await shell(childShell("### 4.5"), {
                    N: "42",
                    RPC_URLS: invalidUrls,
                    RPC_PORT: String(server.port),
                })
                expect(invalid.exitCode).not.toBe(0)
                expect(invalid.stderr).toContain(
                    "at least two explicit validator URLs",
                )
            }
            expect(requests).toHaveLength(2)
            expect(requests[1]).toEqual(requests[0])
            expect(requests[0]).toEqual({
                method: "POST",
                path: "/",
                body: {
                    method: "nodeCall",
                    params: [
                        {
                            message: "getBlockByNumber",
                            data: { blockNumber: 42 },
                        },
                    ],
                },
            })
        } finally {
            server.stop(true)
            peer.stop(true)
        }
    })
    it("exports values used by the hash child shell", () => {
        const hashes = block("### 4.5")
        expect(hashes).toMatch(/export N=.*\n/)
        expect(hashes).toContain("announced activation height")
        expect(hashes).not.toContain(
            "jq -r '.forks.osDenomination.activationHeight'",
        )
        expect(hashes).toMatch(/export RPC_URLS=.*\n/)
        expect(hashes.indexOf("export RPC_URLS=")).toBeLessThan(
            hashes.indexOf("bash -euo pipefail"),
        )
    })
    it("resolves the bare-metal genesis from .env in both steps and defaults without it", async () => {
        const preflight = block("### 2.3").match(/^GENESIS_FILE=.*$/m)![0]
        const update = block("### 4.2").match(/^GENESIS_FILE=.*$/m)![0]
        expect(
            runbook.split("### 2.3 Genesis content")[1].split("```bash")[0],
        ).toContain("unset GENESIS_FILE")
        const dir = mkdtempSync(join(tmpdir(), ".runbook-env-"))
        expect(dir.startsWith(tmpdir() + "/")).toBe(true)
        try {
            symlinkSync(join(root, "src"), join(dir, "src"), "dir")
            const published = join(dir, "published/genesis.json")
            writeFileSync(
                join(dir, ".env"),
                `DEMOS_GENESIS_FILE=${published}\n`,
            )
            const command = `unset DEMOS_GENESIS_FILE\n${preflight}\nprintf '%s\\n' "$GENESIS_FILE"`
            expect(await shell(command, {}, true, dir)).toMatchObject({
                exitCode: 0,
                stdout: `${published}\n`,
            })
            expect(
                await shell(
                    `unset DEMOS_GENESIS_FILE\n${update}\nprintf '%s\\n' "$GENESIS_FILE"`,
                    { GENESIS_FILE: "data/genesis.json" },
                    true,
                    dir,
                ),
            ).toMatchObject({ exitCode: 0, stdout: `${published}\n` })
            rmSync(join(dir, ".env"))
            expect(await shell(command, {}, true, dir)).toMatchObject({
                exitCode: 0,
                stdout: "data/genesis.json\n",
            })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    it("tells bare-metal operators to use supervisor-set values in the §2.3 and §4.2 checks", async () => {
        const select = runbook
            .split("### 2.3 Genesis content")[1]
            .split("```bash")[0]
        const restart = block("### 4.2")
            .split("bun install --frozen-lockfile\n")[1]
            .split("# 4.")[0]
        for (const text of [select, restart]) {
            expect(text).toContain("shell or service environment that starts the node")
            expect(text).toContain("A check in another shell does not prove what the running node received.")
            expect(text).toMatch(/If a supervisor \(systemd `?Environment=`?, pm2\) sets/)
            expect(text).toContain("export it in this shell first")
            expect(text).toContain("DEMOS_GENESIS_FILE")
        }
        expect(restart).toContain("sets GOSSIP_ENABLED or DEMOS_GENESIS_FILE")
        expect(restart.split("# 3.")[1]).toContain("supervisor-set DEMOS_GENESIS_FILE")
        // Following that advice: the exported supervisor value wins over .env.
        expect(await runSidecarStep("false", "GOSSIP_ENABLED=true\n")).toMatchObject({
            exitCode: 0,
            calls: "",
            stdout: expect.stringContaining("Skipping sidecar build because gossip is off"),
        })
        const preflight = block("### 2.3").match(/^GENESIS_FILE=.*$/m)![0]
        const update = block("### 4.2").match(/^GENESIS_FILE=.*$/m)![0]
        const dir = mkdtempSync(join(tmpdir(), ".runbook-supervisor-"))
        expect(dir.startsWith(tmpdir() + "/")).toBe(true)
        try {
            symlinkSync(join(root, "src"), join(dir, "src"), "dir")
            writeFileSync(join(dir, ".env"), "DEMOS_GENESIS_FILE=data/other.json\n")
            const unit = "/srv/demos/genesis.json"
            for (const step of [preflight, update]) {
                expect(
                    await shell(
                        `unset GENESIS_FILE\nexport DEMOS_GENESIS_FILE=${unit}\n${step}\nprintf '%s\\n' "$GENESIS_FILE"`,
                        {},
                        true,
                        dir,
                    ),
                ).toMatchObject({ exitCode: 0, stdout: `${unit}\n` })
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    it("runs Compose genesis preflight without host Bun after the documented export", async () => {
        const instruction = runbook
            .split("### 2.3 Genesis content")[1]
            .split("```bash")[0]
        const exportLine = instruction.match(
            /export GENESIS_FILE=data\/genesis\.json/,
        )?.[0]
        expect(exportLine).toBeDefined()
        const strict = runbook
            .split("Strict checks:\n\n```bash\n")[1]
            .split("```")[0]
        const dir = mkdtempSync(join(tmpdir(), ".runbook-compose-"))
        expect(dir.startsWith(tmpdir() + "/")).toBe(true)
        try {
            mkdirSync(join(dir, "bin"))
            mkdirSync(join(dir, "data"))
            for (const tool of ["bash", "jq", "sha256sum", "grep"]) {
                const path = Bun.which(tool)
                if (!path)
                    throw new Error(
                        `Required preflight test tool is missing: ${tool}`,
                    )
                symlinkSync(path, join(dir, "bin", tool))
            }
            writeFileSync(
                join(dir, "data/genesis.json"),
                JSON.stringify({
                    forks: {
                        osDenomination: { activationHeight: 42 },
                        gasFeeSeparation: {
                            activationHeight: 42,
                            treasuryAddress: `0x${"a".repeat(64)}`,
                        },
                    },
                }),
            )
            const result = await shell(
                `set -e\n${exportLine}\n${block("### 2.3")}\n${strict}\ntrue`,
                { PATH: join(dir, "bin") },
                true,
                dir,
            )
            expect(result).toMatchObject({ exitCode: 0, stderr: "" })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    it("runs the strict genesis checks as a script and rejects each invalid input", async () => {
        const strict = runbook
            .split("Strict checks:\n\n```bash\n")[1]
            .split("```")[0]
        const dir = mkdtempSync(join(tmpdir(), ".runbook-strict-"))
        try {
            writeFileSync(join(dir, "strict.sh"), strict)
            const good = {
                forks: {
                    osDenomination: { activationHeight: 42 },
                    gasFeeSeparation: {
                        activationHeight: 42,
                        treasuryAddress: `0x${"a".repeat(64)}`,
                    },
                },
            }
            const cases = [
                { name: "good", genesis: good, fail: "" },
                {
                    name: "both heights missing",
                    genesis: {
                        forks: {
                            osDenomination: {},
                            gasFeeSeparation: {
                                treasuryAddress: good.forks.gasFeeSeparation.treasuryAddress,
                            },
                        },
                    },
                    fail: "FAIL: activationHeight missing",
                },
                {
                    name: "one height missing",
                    genesis: {
                        forks: {
                            osDenomination: good.forks.osDenomination,
                            gasFeeSeparation: {
                                treasuryAddress: good.forks.gasFeeSeparation.treasuryAddress,
                            },
                        },
                    },
                    fail: "FAIL: activationHeight missing",
                },
                {
                    name: "both heights null",
                    genesis: {
                        forks: {
                            osDenomination: { activationHeight: null },
                            gasFeeSeparation: {
                                activationHeight: null,
                                treasuryAddress: good.forks.gasFeeSeparation.treasuryAddress,
                            },
                        },
                    },
                    fail: "",
                },
                {
                    name: "uppercase treasury",
                    genesis: {
                        forks: {
                            ...good.forks,
                            gasFeeSeparation: {
                                ...good.forks.gasFeeSeparation,
                                treasuryAddress: `0x${"A".repeat(64)}`,
                            },
                        },
                    },
                    fail: "FAIL: treasuryAddress malformed",
                },
                {
                    name: "short treasury",
                    genesis: {
                        forks: {
                            ...good.forks,
                            gasFeeSeparation: {
                                ...good.forks.gasFeeSeparation,
                                treasuryAddress: "0xabc",
                            },
                        },
                    },
                    fail: "FAIL: treasuryAddress malformed",
                },
                {
                    name: "diverging heights",
                    genesis: {
                        forks: {
                            ...good.forks,
                            gasFeeSeparation: {
                                ...good.forks.gasFeeSeparation,
                                activationHeight: 43,
                            },
                        },
                    },
                    fail: "FAIL: heights diverge (42 vs 43)",
                },
                {
                    name: "zero treasury",
                    genesis: {
                        forks: {
                            ...good.forks,
                            gasFeeSeparation: {
                                ...good.forks.gasFeeSeparation,
                                treasuryAddress: `0x${"0".repeat(64)}`,
                            },
                        },
                    },
                    fail: "FAIL: still on placeholder treasury",
                },
            ]
            for (const { name, genesis, fail } of cases) {
                const genesisFile = join(dir, "genesis.json")
                writeFileSync(genesisFile, JSON.stringify(genesis))
                const result = await shell(
                    "bash strict.sh",
                    { GENESIS_FILE: genesisFile },
                    true,
                    dir,
                )
                if (fail) {
                    expect(result.exitCode, name).toBe(1)
                    expect(result.stdout, name).toBe(`${fail}\n`)
                } else {
                    expect(result.exitCode, name).toBe(0)
                    expect(result.stdout, name).toBe("")
                }
                expect(result.stderr, name).toBe("")
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    it("refuses an unset or nonpositive announced activation height before querying peers", async () => {
        const command = childShell("### 4.5")
        const unset = await shell(`unset N\n${command}`, {
            RPC_URLS: "http://127.0.0.1:1/ http://127.0.0.1:2/",
        })
        expect(unset.exitCode).not.toBe(0)
        expect(unset.stderr).toContain(
            "Set N to the announced positive activation height",
        )
        expect(unset.stderr).not.toContain("curl:")
        for (const N of ["", "0", "-1", "not-a-height"]) {
            const result = await shell(command, {
                N,
                RPC_URLS: "http://127.0.0.1:1/ http://127.0.0.1:2/",
            })
            expect(result.exitCode).not.toBe(0)
            expect(result.stderr).toContain(
                "Set N to the announced positive activation height",
            )
            expect(result.stderr).not.toContain("curl:")
        }
    })
    it("checks the announced block when peers agree at block zero but disagree at N", async () => {
        const heights: number[] = []
        const serve = (forkHash: string) =>
            Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                async fetch(req) {
                    const body = (await req.json()) as {
                        params: [{ data: { blockNumber: number } }]
                    }
                    const height = body.params[0].data.blockNumber
                    heights.push(height)
                    return Response.json({
                        result: 200,
                        response: {
                            hash: height === 42 ? forkHash : "shared-genesis",
                        },
                    })
                },
            })
        const first = serve("fork-a"),
            second = serve("fork-b")
        try {
            const urls = `http://127.0.0.1:${first.port}/ http://127.0.0.1:${second.port}/`
            const command = block("### 4.5")
                .replace("paste-announced-activation-height-here", "42")
                .replace(/^export RPC_URLS=.*$/m, `export RPC_URLS="${urls}"`)
            const result = await shell(command)
            expect(result.exitCode).not.toBe(0)
            expect(result.stderr).toContain("Block 42 hash mismatch")
            expect(heights).toEqual([42, 42])
        } finally {
            first.stop(true)
            second.stop(true)
        }
    })
    it("reports a missing block N hash from either validator", async () => {
        const missing = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
                Response.json({
                    result: 404,
                    response: "error",
                    extra: "Block not found",
                }),
        })
        const valid = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
                Response.json({
                    result: 200,
                    response: { hash: "different-valid-hash" },
                }),
        })
        try {
            for (const urls of [
                `http://127.0.0.1:${missing.port}/ http://127.0.0.1:${valid.port}/`,
                `http://127.0.0.1:${valid.port}/ http://127.0.0.1:${missing.port}/`,
            ]) {
                const result = await shell(childShell("### 4.5"), {
                    N: "42",
                    RPC_URLS: urls,
                })
                expect(result.exitCode).toBe(1)
                expect(result.stderr).toContain(
                    `No block 42 hash from http://127.0.0.1:${missing.port}`,
                )
                expect(result.stdout).not.toContain("OK: block 42")
            }
        } finally {
            missing.stop(true)
            valid.stop(true)
        }
    })
    it("allows an intact validator to correct its schedule and restart", () => {
        expect(recovery).toMatch(
            /intact database[\s\S]*correct[\s\S]*genesis file[\s\S]*restart/i,
        )
        expect(recovery).toMatch(
            /stop the validator first[\s\S]*SELECT max\(number\) FROM blocks/i,
        )
        expect(recovery).toMatch(
            /local head[\s\S]*below N[\s\S]*neither migration[\s\S]*correct/i,
        )
        expect(recovery).toMatch(
            /head[\s\S]*N[\s\S]*both migrations[\s\S]*applied_at_block[\s\S]*stop[\s\S]*backup/i,
        )
        expect(recovery).toContain(
            "created its block 0 from an edited data/genesis.json",
        )
        expect(recovery).toMatch(
            /refused at bootstrap[\s\S]*Keep it stopped and restore[\s\S]*head\/`fork_state` rule below applies only to a database built on the network's block 0/,
        )
        expect(runbook).not.toMatch(
            /If the fork schedule was added or changed after block 0, do not wipe or restart/i,
        )
    })
    it("checks stored block zero against an older healthy peer before the restart rule", async () => {
        expect(recovery).toContain(
            'psql -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE"',
        )
        expect(recovery).toMatch(/hashes match[\s\S]*local head[\s\S]*below N/)
        const rpc = [...recovery.matchAll(/```bash\n([\s\S]*?)```/g)]
            .map(m => m[1])
            .find(s => s.includes("HEALTHY_RPC_URL"))!
        const requests: unknown[] = []
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(req) {
                const body = (await req.json()) as {
                    params: { data: { blockNumber: unknown } }[]
                }
                requests.push({
                    method: req.method,
                    path: new URL(req.url).pathname,
                    body,
                })
                if (!body.params[0]?.data.blockNumber || requests.length > 1)
                    return Response.json({
                        result: 400,
                        response: "Block number not provided",
                    })
                return Response.json({
                    result: 200,
                    response: { hash: "agreed-block-zero" },
                })
            },
        })
        try {
            const result = await shell(
                rpc.replace(
                    "http://healthy-validator.example:53550/",
                    `http://127.0.0.1:${server.port}/`,
                ),
            )
            expect(result).toEqual({
                exitCode: 0,
                stdout: "agreed-block-zero\n",
                stderr: "",
            })
            expect(requests).toEqual([
                {
                    method: "POST",
                    path: "/",
                    body: {
                        method: "nodeCall",
                        params: [
                            {
                                message: "getBlockByNumber",
                                data: { blockNumber: "0" },
                            },
                        ],
                    },
                },
            ])
            const url = `http://127.0.0.1:${server.port}/`
            const refused = await shell(
                rpc.replace("http://healthy-validator.example:53550/", url),
            )
            expect(refused.exitCode).not.toBe(0)
            expect(refused.stderr).toContain(`No block 0 hash from ${url}`)
        } finally {
            server.stop(true)
        }
        expect(
            recovery.split("SELECT hash FROM blocks WHERE number = 0;").length -
                1,
        ).toBe(4)
        expect(recovery).toContain(
            "set PG_PORT to the `-d` value passed to `./run` (default 5332)",
        )
        expect(recovery).toContain(
            'docker exec "postgres_${PG_PORT:-5332}" psql -v ON_ERROR_STOP=1 -U demosuser -d demos -tAc',
        )
    })
    it("fails both height probes when curl times out after a valid JSON height", async () => {
        const stalled = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    '{"result":200,"response":42}\n',
                                ),
                            )
                        },
                    }),
                ),
        })
        try {
            for (const heading of ["### 3.1", "### 4.6"]) {
                const command = block(heading)
                    .replaceAll("--max-time 5", "--max-time 1")
                    .replaceAll("sleep 25", "sleep 0")
                const result = await shell(
                    command,
                    { RPC_PROBE_PORT: String(stalled.port), RPC_PORT: "1" },
                    false,
                )
                expect(result.exitCode).not.toBe(0)
                expect(result.stderr).toContain("curl: (28)")
                expect(result.stdout).toBe("42\n")
            }
        } finally {
            stalled.stop(true)
        }
    }, 10000)
    it("bounds remote hash requests and fails when a peer stalls or sends too much", async () => {
        const command = childShell("### 4.5")
        for (const flag of [
            "--connect-timeout 2",
            "--max-time 5",
            "--max-filesize 1048576",
        ])
            expect(command).toContain(flag)
        for (const [fetch, error] of [
            [() => new Promise<Response>(() => {}), "curl: (28)"],
            [() => new Response("x".repeat(1048577)), "curl: (63)"],
        ] as const) {
            const server = Bun.serve({ port: 0, fetch })
            try {
                const result = await shell(command, {
                    N: "42",
                    RPC_URLS: `http://127.0.0.1:${server.port}/ http://zz.invalid:1/`,
                })
                expect(result.exitCode).not.toBe(0)
                expect(result.stderr).toContain(error)
            } finally {
                server.stop(true)
            }
        }
    }, 15000)
    it("bounds unsized chunked RPC bodies even when curl cannot enforce max-filesize", async () => {
        const oversized = (value: object) =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                JSON.stringify(value) + " ".repeat(1100000),
                            ),
                        )
                        controller.close()
                    },
                }),
                { headers: { "content-type": "application/json" } },
            )
        const height = Bun.serve({
            port: 0,
            fetch: () => oversized({ result: 200, response: 42 }),
        })
        const hash = Bun.serve({
            port: 0,
            fetch: () => oversized({ result: 200, response: { hash: "same" } }),
        })
        const peer = Bun.serve({
            port: 0,
            fetch: () =>
                Response.json({ result: 200, response: { hash: "same" } }),
        })
        try {
            for (const heading of ["### 3.1", "### 4.6"]) {
                const command = curls()
                    .find(c => block(heading).includes(c))!
                    .replace(
                        "--max-filesize 1048576",
                        "--max-filesize 999999999",
                    )
                expect(command).toContain("| head -c 1048577 | jq")
                expect(
                    (await shell(command, { RPC_PORT: String(height.port) }))
                        .exitCode,
                ).not.toBe(0)
            }
            const command = childShell("### 4.5").replace(
                "--max-filesize 1048576",
                "--max-filesize 999999999",
            )
            expect(command).toContain("| head -c 1048577 | jq")
            const result = await shell(command, {
                N: "42",
                RPC_URLS: `http://127.0.0.1:${hash.port}/ http://127.0.0.1:${peer.port}/`,
            })
            expect(result.exitCode).not.toBe(0)
        } finally {
            height.stop(true)
            hash.stop(true)
            peer.stop(true)
        }
    }, 15000)
    it("bounds both height probes when the RPC stalls or sends too much", async () => {
        const commands = [block("### 3.1"), block("### 4.6")].map(
            section => curls().find(command => section.includes(command))!,
        )
        for (const command of commands) {
            for (const flag of [
                "--connect-timeout 2",
                "--max-time 5",
                "--max-filesize 1048576",
            ])
                expect(command).toContain(flag)
        }
        for (const [fetch, error] of [
            [() => new Promise<Response>(() => {}), "curl: (28)"],
            [() => new Response("x".repeat(1048577)), "curl: (63)"],
        ] as const) {
            const server = Bun.serve({ port: 0, fetch })
            try {
                for (const command of commands) {
                    const result = await shell(command, {
                        RPC_PORT: String(server.port),
                    })
                    expect(result.exitCode).not.toBe(0)
                    expect(result.stderr).toContain(error)
                }
            } finally {
                server.stop(true)
            }
        }
    }, 20000)
    it("directs database resets to backup restore without executable wipe commands", () => {
        expect(recovery).toMatch(/never drop the database by hand/i)
        expect(recovery).toMatch(/stop and contact the core team/i)
        expect(recovery).not.toMatch(
            /\b(?:DROP|CREATE) DATABASE\b|\b(?:dropdb|createdb)\b/i,
        )
        expect(recovery).not.toContain("bun run migration:run")
        expect(recovery).not.toContain("-d postgres")
    })
    it("removes the one-start schedule digest override after the node runs", () => {
        expect(recovery).toMatch(
            /DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST[\s\S]*Remove it from the environment once the node runs/,
        )
    })
    it("stops the reaper and checks the container's genesis during the update", () => {
        expect(block("### 4.2")).not.toContain("docker compose stop")
        // One wrapper stop in §4.2, and its reuse for the §4.6 peer list restart.
        const wrapperStop = /\.\/scripts\/docker-run stop reaper node/g
        expect(runbook.match(wrapperStop)).toHaveLength(2)
        for (const [heading, end] of [
            ["### 4.2", "### 4.3"],
            ["### 4.6", "## 5."],
        ])
            expect(
                runbook.split(heading)[1].split(end)[0].match(wrapperStop),
            ).toHaveLength(1)
        expect(runbook.split("### 4.2")[1].split("### 4.3")[0]).toContain(
            "./scripts/docker-run up -d --no-build node reaper",
        )
        expect(runbook.split("### 4.2")[1].split("### 4.3")[0]).toMatch(
            /docker compose pull node[\s\S]*without `up`/,
        )
        const containerHash =
            "./scripts/docker-run run --rm --no-deps node sh -c 'sha256sum \"${DEMOS_GENESIS_FILE:-data/genesis.json}\"'"
        expect(
            runbook.match(
                /\.\/scripts\/docker-run run --rm --no-deps node sh -c 'sha256sum/g,
            ),
        ).toHaveLength(2)
        expect(runbook.split("### 2.3")[1].split("### 2.4")[0]).toContain(
            containerHash,
        )
        expect(runbook.split("### 4.2")[1].split("### 4.3")[0]).toContain(
            containerHash,
        )
    })
    it("routes wrapper-started Compose commands to the selected instance", () => {
        for (const text of [
            "--port 53560",
            "demos-53560",
            "same instance flags as the running instance",
            "never `--clean` or `--rebuild`",
        ])
            expect(runbook).toContain(text)
        for (const command of [
            "build",
            "run",
            "exec",
            "ps",
            "stop",
            "up",
            "logs",
        ])
            expect(runbook).toContain(`./scripts/docker-run ${command} `)
        const wrapper = read("scripts/docker-run")
        for (const text of [
            'INSTANCE_PROJECT="demos-${NODE_PORT}"',
            'INSTANCE_SUFFIX="_${NODE_PORT}"',
        ])
            expect(wrapper).toContain(text)
    })
    it("keeps the INSTALL.md override on raw Compose checks and restart", () => {
        expect(read("INSTALL.md")).toContain(
            "./mainnet/genesis.json:/app/data/genesis.json:ro",
        )
        const setup = runbook.split("### 2.1")[1].split("### 2.2")[0]
        for (const text of [
            "docker-compose.override.yml",
            "COMPOSE_FILE",
            "docker compose ls",
            "GIT_COMMIT=$(git rev-parse HEAD) docker compose build node",
        ])
            expect(setup).toContain(text)
        const preflight = runbook.split("### 2.3")[1].split("### 2.4")[0]
        expect(preflight).toContain("GENESIS_FILE=mainnet/genesis.json")
        expect(preflight).toContain("GENESIS_FILE=${GENESIS_FILE:-$(bun -e")
        expect(preflight).toContain('sha256sum "$GENESIS_FILE"')
        expect(preflight).toContain(
            "docker compose run --rm --no-deps node sh -c 'sha256sum",
        )
        for (const heading of ["### 2.4", "### 2.5", "### 2.6"])
            expect(runbook.split(heading)[1].split(/\n### /)[0]).toContain(
                "docker compose exec -T postgres",
            )
        const update = runbook.split("### 4.2")[1].split("### 4.3")[0]
        expect(update.split("For Compose,")[0]).toContain(
            'sha256sum "$GENESIS_FILE"',
        )
        for (const command of [
            "ps --status running --services",
            "stop reaper node",
            "up -d --no-build node reaper",
        ])
            expect(update).toContain(`docker compose ${command}`)
        for (const section of [preflight, update])
            expect(
                [...section.matchAll(/```bash\n([\s\S]*?)```/g)].some(
                    m =>
                        m[1].includes("docker compose run") &&
                        !m[1].includes("./scripts/docker-run run"),
                ),
            ).toBe(true)
        expect(update).toContain(
            'with the agreed file and run `sha256sum "$GENESIS_FILE"`',
        )
        expect(update).toContain("do **not** run either volume-copy command")
    })
    it("scopes the effective host port to each RPC probe, leaving Compose's port alone", () => {
        const portSection = runbook.split("### 3.1")[1].split("### 3.2")[0]
        expect(portSection).toContain("Compose reads `RPC_PORT` from the shell")
        expect(portSection).not.toContain("export RPC_PORT")
        for (const heading of ["### 3.1", "### 4.6"])
            expect(block(heading)).toContain(
                'RPC_PORT="${RPC_PROBE_PORT:-53550}" bash -o pipefail',
            )
        const port = read("docker-compose.devnet.yml").match(
            /- "(\d+):\$\{RPC_PORT:-53550\}"/,
        )?.[1]
        expect(runbook.split("### 3.1")[1].split("```bash")[0]).toContain(
            `RPC_PROBE_PORT=${port}`,
        )
        expect(runbook.split("### 3.1")[1].split("```bash")[0]).toContain(
            "--devnet",
        )
    })
    it("copies the announced genesis into the selected volume before hashing it", () => {
        const update = runbook.split("### 4.2")[1].split("### 4.3")[0]
        expect(update).toContain(
            "./scripts/docker-run run --rm --no-deps --user root --entrypoint sh",
        )
        expect(update).toContain(
            '-v "$PWD/${GENESIS_FILE:?}:/agreed-genesis.json:ro"',
        )
        expect(update).toContain(
            'cp /agreed-genesis.json "${DEMOS_GENESIS_FILE:-data/genesis.json}"',
        )
        expect(update.indexOf("cp /agreed-genesis.json")).toBeLessThan(
            update.indexOf(
                'sha256sum "${DEMOS_GENESIS_FILE:-data/genesis.json}"',
                update.indexOf("cp /agreed-genesis.json"),
            ),
        )
        expect(compose).toContain("node_data:/app/data")
    })
    it("edits, announces and checks the genesis file §2.3 selects in every setup", async () => {
        const select = runbook
            .split("### 2.3 Genesis content")[1]
            .split("```bash")[0]
        const preflight = block("### 2.3").match(/^GENESIS_FILE=.*$/m)![0]
        const seal = runbook.split("### 3.2")[1].split("\n## ")[0]
        const broadcast = runbook.split("### 4.1")[1].split("### 4.2")[0]
        const update = runbook.split("### 4.2")[1].split("### 4.3")[0]
        const hashIn = (text: string) => {
            const command = text.match(/`(sha256sum [^`]+)`/)?.[1]
            expect(command).toBeDefined()
            return command!
        }
        expect(seal).toContain("§2.3 selected as `GENESIS_FILE`")
        const announce = hashIn(seal)
        const announced = hashIn(broadcast)
        const bindMountCheck = hashIn(
            update.split("For the INSTALL.md read-only bind mount")[1],
        )
        const bareMetalCheck = block("### 4.2").match(/^sha256sum .*$/m)![0]
        const bareMetalResolve = block("### 4.2").match(/^GENESIS_FILE=.*$/m)![0]
        const copyBlocks = [...update.matchAll(/```bash\n([\s\S]*?)```/g)]
            .map(m => m[1])
            .filter(code => code.includes("/agreed-genesis.json"))
        expect(copyBlocks).toHaveLength(2)
        const volumeChecks = copyBlocks.flatMap(code => {
            const hostCheck = code.match(/^sha256sum .*$/m)?.[0]
            const source = code.match(/-v "([^"]+):\/agreed-genesis\.json:ro"/)?.[1]
            expect(hostCheck).toBeDefined()
            expect(source).toBeDefined()
            expect(code.indexOf(hostCheck!)).toBeLessThan(
                code.indexOf("/agreed-genesis.json"),
            )
            return [hostCheck!, `sha256sum "${source}"`]
        })
        const exportFor = (pattern: RegExp) => {
            const line = select.match(pattern)?.[0]
            expect(line).toBeDefined()
            return line!
        }
        const dir = mkdtempSync(join(tmpdir(), ".runbook-announce-"))
        expect(dir.startsWith(tmpdir() + "/")).toBe(true)
        try {
            symlinkSync(join(root, "src"), join(dir, "src"), "dir")
            const files: Record<string, string> = {
                "data/genesis.json": '{"file":"data"}\n',
                "mainnet/genesis.json": '{"file":"mainnet"}\n',
                "published/genesis.json": '{"file":"published"}\n',
            }
            for (const [file, text] of Object.entries(files)) {
                mkdirSync(join(dir, file, ".."), { recursive: true })
                writeFileSync(join(dir, file), text)
            }
            writeFileSync(
                join(dir, ".env"),
                `DEMOS_GENESIS_FILE=${join(dir, "published/genesis.json")}\n`,
            )
            const sha = (file: string) =>
                new Bun.CryptoHasher("sha256").update(files[file]).digest("hex")
            const setups = [
                {
                    file: "mainnet/genesis.json",
                    steps: [
                        exportFor(/export GENESIS_FILE=mainnet\/genesis\.json/),
                        preflight,
                        announce,
                        announced,
                        bindMountCheck,
                    ],
                },
                {
                    file: "data/genesis.json",
                    steps: [
                        exportFor(/export GENESIS_FILE=data\/genesis\.json/),
                        preflight,
                        announce,
                        announced,
                        ...volumeChecks,
                    ],
                },
                {
                    file: "published/genesis.json",
                    steps: [
                        exportFor(/unset GENESIS_FILE/),
                        preflight,
                        announce,
                        announced,
                        bareMetalResolve,
                        bareMetalCheck,
                    ],
                },
            ]
            for (const setup of setups) {
                const result = await shell(
                    `set -e\nunset GENESIS_FILE DEMOS_GENESIS_FILE\n${setup.steps.join("\n")}`,
                    {},
                    true,
                    dir,
                )
                expect(result.exitCode).toBe(0)
                const hashes = result.stdout
                    .trim()
                    .split("\n")
                    .map(line => line.split(/\s+/)[0])
                expect(hashes).toHaveLength(
                    setup.steps.filter(step => step.startsWith("sha256sum "))
                        .length,
                )
                expect(new Set(hashes)).toEqual(new Set([sha(setup.file)]))
            }
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
    it("keeps RPC probe failures and pipefail inside child shells", async () => {
        for (const heading of ["### 3.1", "### 4.6"]) {
            const code = block(heading).replaceAll("sleep 25", "sleep 0")
            const result = await shell(
                `${code}\nset -o | grep -q '^pipefail[[:space:]]*off' || exit 7\n[[ "$RPC_PORT" == 1 ]] || exit 8\nprintf 'operator-shell-open\\n'`,
                { RPC_PORT: "1" },
                false,
            )
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("operator-shell-open")
        }
    })
    it("keeps the operator shell open when a healthy peer refuses or is unreachable", async () => {
        const rpc = [...recovery.matchAll(/```bash\n([\s\S]*?)```/g)]
            .map(m => m[1])
            .find(s => s.includes("HEALTHY_RPC_URL"))!
        const refused = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
                Response.json({
                    result: 400,
                    response: "Block number not provided",
                }),
        })
        try {
            for (const url of [
                `http://127.0.0.1:${refused.port}/`,
                "http://127.0.0.1:1/",
            ]) {
                const result = await shell(
                    `${rpc.replace("http://healthy-validator.example:53550/", url)}\nset -o | grep -q '^pipefail[[:space:]]*off' || exit 7\nprintf 'operator-shell-open\\n'`,
                    {},
                    false,
                )
                expect(result.exitCode).toBe(0)
                expect(result.stdout).toContain("operator-shell-open")
                expect(result.stderr).toContain(`No block 0 hash from ${url}`)
            }
        } finally {
            refused.stop(true)
        }
    })
    it("lists the Compose gossip TCP port in the README table and firewall example", () => {
        const port = compose.match(/GOSSIP_PORT: \$\{GOSSIP_PORT:-(\d+)\}/)![1]
        const readme = read("README.md")
        expect(readme).toMatch(
            new RegExp(`\\| ${port}\\s+\\| TCP\\s+\\| Gossip`),
        )
        expect(readme).toContain(`sudo ufw allow ${port}/tcp`)
    })
})

#!/usr/bin/env bun

import * as fs from "fs"
import * as path from "path"
import { envInt } from "../loadgen/src/framework/common"
import { waitForConsensusTargets } from "../loadgen/src/features/consensus/shared"
import { getClusterObservation, waitForClusterConvergence } from "../loadgen/src/features/peersync/shared"

type SuiteName = "sanity" | "cluster-health" | "gcr-focus" | "gcr-routine" | "prod-gate" | "l2ps-live" | "startup-cold-boot"

type ScenarioResult = {
  scenario: string
  runId: string
  ok: boolean
  exitCode: number
  timedOut: boolean
  summaryPath: string | null
  summary: any
}

type StartupBootstrapReport = {
  ok: boolean
  suite: SuiteName
  runTag: string
  targets: string[]
  buildFirst: boolean
  resetCommand: string[]
  upCommand: string[]
  initialObservation: any
  convergence: any
  timestamp: string
}

type SuiteArgs = ReturnType<typeof parseArgs>

const defaultLocalTargets = "http://localhost:53551,http://localhost:53552,http://localhost:53553,http://localhost:53554"

const suites: Record<SuiteName, string[]> = {
  sanity: [
    "omni_connection_smoke",
    "zk_proof_loadgen",
  ],
  "cluster-health": [
    "consensus_block_production",
    "gcr_identity_remove",
    "peer_discovery_smoke",
  ],
  "gcr-focus": [
    "gcr_identity_remove",
    "gcr_identity_matrix",
    "gcr_points_smoke",
    "gcr_identity_xm_smoke",
  ],
  "gcr-routine": [
    "gcr_identity_smoke",
    "gcr_identity_remove",
  ],
  "prod-gate": [
    "omni_connection_smoke",
    "consensus_block_production",
    "peer_discovery_smoke",
    "gcr_identity_remove",
    "gcr_identity_xm_smoke",
    "zk_proof_loadgen",
    "im_message_roundtrip",
    "tlsnotary_routes_smoke",
    "web2_url_validation_smoke",
    "multichain_parser_rejects",
  ],
  "l2ps-live": [
    "l2ps_live_participation_smoke",
    "l2ps_live_submission_relay_smoke",
  ],
  "startup-cold-boot": [
    "peer_discovery_smoke",
    "consensus_block_production",
  ],
}

function usage() {
  console.log(`Usage:
  bun better_testing/scripts/run-suite.ts [suite] [--build-first] [--verbose] [--local]
  bun better_testing/scripts/run-suite.ts --scenarios a,b,c [--build-first] [--verbose] [--local]

Options:
  --local                 Run directly with local bun against localhost targets
  --scenario-timeout-sec  Per-scenario timeout for suite runs (default: 180)
  --targets               Override TARGETS for local mode, comma-separated RPC URLs

Built-in suites:
  ${Object.keys(suites).join(", ")}
`)
}

function parseArgs(argv: string[]) {
  let suite: string | null = null
  let scenariosArg: string | null = null
  let buildFirst = false
  let verbose = false
  let local = false
  let scenarioTimeoutSec = 180
  let targets: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === "-h" || arg === "--help") {
      usage()
      process.exit(0)
    }
    if (arg === "--build-first") {
      buildFirst = true
      continue
    }
    if (arg === "--verbose") {
      verbose = true
      continue
    }
    if (arg === "--local") {
      local = true
      continue
    }
    if (arg === "--scenario-timeout-sec") {
      scenarioTimeoutSec = Number(argv[++i] ?? "180") || 180
      continue
    }
    if (arg === "--targets") {
      targets = argv[++i] ?? ""
      continue
    }
    if (arg === "--scenarios") {
      scenariosArg = argv[++i] ?? ""
      continue
    }
    if (!suite) {
      suite = arg
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  const scenarios = scenariosArg
    ? scenariosArg.split(",").map(item => item.trim()).filter(Boolean)
    : suite && suite in suites
      ? suites[suite as SuiteName]
      : []

  if (scenarios.length === 0) {
    throw new Error("No scenarios selected. Use a known suite name or --scenarios.")
  }

  return {
    suite: suite ?? "custom",
    scenarios,
    buildFirst,
    verbose,
    local,
    scenarioTimeoutSec,
    targets,
  }
}

function timestampTag() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function splitTargets(value: string): string[] {
  return value.split(",").map(item => item.trim()).filter(Boolean)
}

function composeCmd(args: string[], verbose: boolean): void {
  const proc = Bun.spawnSync({
    cmd: ["docker", "compose", ...args],
    cwd: path.join(process.cwd(), "devnet"),
    stdout: verbose ? "inherit" : "pipe",
    stderr: "inherit",
  })
  if (proc.exitCode !== 0) {
    const detail = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : ""
    throw new Error(`docker compose ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`)
  }
}

function getSuiteRunDir(suite: string, runTag: string): string {
  return path.join(process.cwd(), "better_testing", "runs", `suite-${suite}-${runTag}`)
}

function writeSuiteArtifact(suite: string, runTag: string, report: Record<string, unknown>): string {
  const suiteRunDir = getSuiteRunDir(suite, runTag)
  const artifactPath = path.join(suiteRunDir, "suite.summary.json")
  ensureParentDir(artifactPath)
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + "\n", "utf8")
  return artifactPath
}

async function isHealthyRpcTarget(rpcUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "ping", params: [] }),
      signal: controller.signal,
    })
    if (!response.ok) return false
    const data = await response.json().catch(() => null) as any
    return typeof data?.result === "number" && data.result >= 200 && data.result < 300
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function resolveLocalTargets(suite: string, explicitTargets: string | null): Promise<string | null> {
  if (explicitTargets) return explicitTargets
  if (suite === "startup-cold-boot") return defaultLocalTargets
  if (suite === "gcr-routine") return defaultLocalTargets
  if (suite !== "cluster-health" && suite !== "gcr-focus" && suite !== "prod-gate") return null

  const candidates = splitTargets(process.env.TARGETS ?? defaultLocalTargets)
  const health = await Promise.all(candidates.map(async rpcUrl => ({ rpcUrl, ok: await isHealthyRpcTarget(rpcUrl) })))
  const healthy = health.filter(item => item.ok).map(item => item.rpcUrl)

  const minimumHealthy = suite === "cluster-health" ? 2 : suite === "prod-gate" ? 3 : 1
  if (healthy.length >= minimumHealthy) {
    return healthy.join(",")
  }

  return null
}

function findSummaryFile(runDir: string): string | null {
  if (!fs.existsSync(runDir)) return null
  const stack = [runDir]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(next)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".summary.json")) {
        return next
      }
    }
  }
  return null
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function summarizeFailure(summary: any): string {
  if (!summary || typeof summary !== "object") return "no summary"
  if (typeof summary.reason === "string") return summary.reason
  if (Array.isArray(summary.errorSamples) && summary.errorSamples.length > 0) {
    const sample = summary.errorSamples[0]
    const code = typeof sample?.code === "string" ? `${sample.code}: ` : ""
    return `${code}${sample?.message ?? "error sample present"}`
  }
  if (summary.operatorSummary?.primaryIssues?.length > 0) {
    return `issues=${summary.operatorSummary.primaryIssues.join(",")}`
  }
  if (Array.isArray(summary.failures) && summary.failures.length > 0) {
    return String(summary.failures[0])
  }
  return "failed"
}

function summarizeRunFailure(result: ScenarioResult): string {
  if (result.timedOut) {
    return "timed out (exit 124)"
  }
  if (!result.summaryPath) {
    return `no summary (exit ${result.exitCode})`
  }
  return summarizeFailure(result.summary)
}

function renderSuiteMarkdown(
  args: SuiteArgs,
  runTag: string,
  resolvedTargets: string | null,
  results: ScenarioResult[],
  suiteArtifactPath: string | null,
): string {
  const lines: string[] = []
  lines.push("# Suite Run Summary")
  lines.push("")
  lines.push(`- Timestamp: ${new Date().toISOString()}`)
  lines.push(`- Suite: \`${args.suite}\``)
  lines.push(`- Mode: \`${args.local ? "local" : "docker"}\``)
  lines.push(`- Scenarios: ${args.scenarios.map(item => `\`${item}\``).join(", ")}`)
  if (resolvedTargets) {
    lines.push(`- Targets: \`${resolvedTargets}\``)
  }
  lines.push(`- Scenario timeout: \`${args.scenarioTimeoutSec}s\``)
  lines.push("")
  lines.push("## Results")
  lines.push("")
  for (const result of results) {
    lines.push(`### ${result.ok ? "PASS" : "FAIL"} \`${result.scenario}\``)
    lines.push("")
    lines.push(`- Run ID: \`${result.runId}\``)
    lines.push(`- Exit code: \`${result.exitCode}\``)
    if (result.timedOut) {
      lines.push("- Timed out: `true`")
    }
    if (result.summaryPath) {
      lines.push(`- Summary artifact: \`${path.relative(process.cwd(), result.summaryPath)}\``)
    } else {
      lines.push("- Summary artifact: `<none>`")
    }
    if (!result.ok) {
      lines.push(`- Failure summary: ${summarizeRunFailure(result)}`)
    }
    lines.push("")
  }
  lines.push("## Quick Paths")
  lines.push("")
  if (suiteArtifactPath) {
    lines.push(`- Suite artifact: \`${path.relative(process.cwd(), suiteArtifactPath)}\``)
  }
  lines.push(`- Timestamped report: \`better_testing/runs/_latest/${args.suite}-${runTag}.md\``)
  lines.push(`- Latest report pointer: \`better_testing/runs/_latest/${args.suite}.latest.md\``)
  lines.push("")
  return `${lines.join("\n").trim()}\n`
}

function writeSuiteReports(
  args: SuiteArgs,
  runTag: string,
  resolvedTargets: string | null,
  results: ScenarioResult[],
  suiteArtifactPath: string | null,
): { timestampedReportPath: string; latestReportPath: string } {
  const content = renderSuiteMarkdown(args, runTag, resolvedTargets, results, suiteArtifactPath)
  const latestDir = path.join(process.cwd(), "better_testing", "runs", "_latest")
  const timestampedReportPath = path.join(latestDir, `${args.suite}-${runTag}.md`)
  const latestReportPath = path.join(latestDir, `${args.suite}.latest.md`)
  ensureParentDir(timestampedReportPath)
  fs.writeFileSync(timestampedReportPath, content, "utf8")
  fs.writeFileSync(latestReportPath, content, "utf8")
  return { timestampedReportPath, latestReportPath }
}

async function runStartupColdBootBootstrap(
  args: SuiteArgs,
  runTag: string,
  resolvedTargets: string | null,
): Promise<{ ok: boolean; artifactPath: string; report: StartupBootstrapReport }> {
  if (!args.local) {
    throw new Error("startup-cold-boot requires --local because it manages the local devnet lifecycle")
  }

  const targets = splitTargets(resolvedTargets ?? defaultLocalTargets)
  const resetCommand = ["down", "-v", "--remove-orphans"]
  const upCommand = args.buildFirst ? ["up", "-d", "--build"] : ["up", "-d"]

  console.log("\n==> cold boot reset")
  composeCmd(resetCommand, args.verbose)
  console.log("==> cold boot start")
  composeCmd(upCommand, args.verbose)

  const rpcTimeoutSec = envInt("WAIT_FOR_RPC_SEC", 120)
  const txTimeoutSec = envInt("WAIT_FOR_TX_SEC", 120)
  await waitForConsensusTargets(targets, true)

  const initialObservation = await getClusterObservation(targets)
  const convergence = await waitForClusterConvergence({
    rpcUrls: targets,
    timeoutSec: envInt("STARTUP_CONVERGENCE_TIMEOUT_SEC", Math.max(rpcTimeoutSec, txTimeoutSec, 120)),
    pollMs: envInt("STARTUP_CONVERGENCE_POLL_MS", 1000),
    stableRoundsRequired: envInt("STARTUP_STABLE_ROUNDS", 2),
    minBlockAdvance: envInt("STARTUP_REQUIRED_BLOCK_DELTA", 1),
    requirePeerDiscovery: true,
  })

  const report: StartupBootstrapReport = {
    ok: initialObservation.healthyNodeCount >= 2 && convergence.ok,
    suite: "startup-cold-boot",
    runTag,
    targets,
    buildFirst: args.buildFirst,
    resetCommand,
    upCommand,
    initialObservation,
    convergence,
    timestamp: new Date().toISOString(),
  }
  const artifactPath = writeSuiteArtifact(args.suite, runTag, report)
  if (!report.ok) {
    throw new Error(`startup-cold-boot bootstrap failed: ${artifactPath}`)
  }
  return { ok: report.ok, artifactPath, report }
}

async function runScenario(
  scenario: string,
  runId: string,
  build: boolean,
  verbose: boolean,
  local: boolean,
  scenarioTimeoutSec: number,
  targets: string | null,
): Promise<ScenarioResult> {
  const innerCmd = local
    ? [
      "env",
      "RUNS_DIR=better_testing/runs",
      `RUN_ID=${runId}`,
      `SCENARIO=${scenario}`,
      `QUIET=${verbose ? "false" : "true"}`,
      `TARGETS=${targets ?? process.env.TARGETS ?? "http://localhost:53551,http://localhost:53552,http://localhost:53553,http://localhost:53554"}`,
      "bun",
      "better_testing/loadgen/src/main.ts",
    ]
    : [
      "bash",
      "better_testing/scripts/run-scenario.sh",
      scenario,
      "--run-id",
      runId,
      verbose ? "--verbose" : "--quiet",
    ]
  if (!local && build) innerCmd.splice(3, 0, "--build")
  const cmd = ["timeout", `${scenarioTimeoutSec}s`, ...innerCmd]

  const proc = Bun.spawn({ cmd, cwd: process.cwd(), stdout: "inherit", stderr: "inherit" })
  const exitCode = await proc.exited
  const runDir = path.join(process.cwd(), "better_testing", "runs", runId)
  const summaryPath = findSummaryFile(runDir)
  const summary = summaryPath ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) : null
  return {
    scenario,
    runId,
    ok: exitCode === 0 && Boolean(summary?.ok ?? summary?.passed ?? true),
    exitCode,
    timedOut: exitCode === 124,
    summaryPath,
    summary,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runTag = timestampTag()
  const results: ScenarioResult[] = []
  const resolvedTargets = args.local ? await resolveLocalTargets(args.suite, args.targets) : args.targets
  let suiteArtifactPath: string | null = null

  console.log(`Running suite: ${args.suite}`)
  console.log(`Scenarios: ${args.scenarios.join(", ")}`)
  console.log(`Mode: ${args.local ? "local" : "docker"}`)
  if (args.local && resolvedTargets) {
    console.log(`Targets: ${resolvedTargets}`)
  }

  if (args.suite === "startup-cold-boot") {
    const bootstrap = await runStartupColdBootBootstrap(args, runTag, resolvedTargets)
    suiteArtifactPath = bootstrap.artifactPath
    console.log(`Startup bootstrap artifact: ${path.relative(process.cwd(), bootstrap.artifactPath)}`)
  }

  for (let index = 0; index < args.scenarios.length; index++) {
    const scenario = args.scenarios[index]!
    const runId = `suite-${args.suite}-${scenario}-${runTag}-${String(index + 1).padStart(2, "0")}`
    console.log(`\n==> ${scenario} (${runId})`)
    const result = await runScenario(
      scenario,
      runId,
      args.buildFirst && index === 0,
      args.verbose,
      args.local,
      args.scenarioTimeoutSec,
      resolvedTargets,
    )
    results.push(result)
  }

  const failed = results.filter(item => !item.ok)
  const reports = writeSuiteReports(args, runTag, resolvedTargets, results, suiteArtifactPath)
  console.log("\nSuite summary")
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL"
    const detail = result.ok
      ? (result.summaryPath ?? "no summary")
      : `${summarizeRunFailure(result)} | ${result.summaryPath ?? "no summary"}`
    console.log(`${status}  ${result.scenario}  ${detail}`)
  }
  console.log(`Markdown report: ${path.relative(process.cwd(), reports.timestampedReportPath)}`)
  console.log(`Latest report:   ${path.relative(process.cwd(), reports.latestReportPath)}`)

  if (failed.length > 0) {
    process.exitCode = 1
  }
}

await main()

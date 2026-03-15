#!/usr/bin/env bun

import * as fs from "fs"
import * as path from "path"

type StepConfig = {
  key: string
  title: string
  scenario: string
  summaryPath: string
  env: Record<string, string>
}

type StepResult = {
  key: string
  title: string
  scenario: string
  runId: string
  ok: boolean
  summaryPath: string
  metrics: Record<string, unknown>
  error?: string
}

type Args = {
  build: boolean
  quiet: boolean
  withOmni: boolean
}

function usage() {
  console.log(`Usage:
  bun better_testing/scripts/run-active-core-baseline.ts [--build] [--quiet|--verbose] [--with-omni]

Runs a fixed-config active-core performance baseline on local devnet:
  - native transfer throughput
  - zk proof verification load
  - peer-sync read pressure
  - optional: omni throughput
`)
}

function parseArgs(argv: string[]): Args {
  let build = false
  let quiet = true
  let withOmni = false

  for (const arg of argv) {
    if (arg === "--build") {
      build = true
      continue
    }
    if (arg === "--quiet") {
      quiet = true
      continue
    }
    if (arg === "--verbose") {
      quiet = false
      continue
    }
    if (arg === "--with-omni") {
      withOmni = true
      continue
    }
    if (arg === "-h" || arg === "--help") {
      usage()
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return { build, quiet, withOmni }
}

function timestampTag() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeJson(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8")
}

function writeText(filePath: string, value: string) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function loadDevnetRecipients(): string {
  const identitiesDir = path.join(process.cwd(), "devnet", "identities")
  const recipients = ["node2.pubkey", "node3.pubkey", "node4.pubkey"]
    .map(file => fs.readFileSync(path.join(identitiesDir, file), "utf8").trim())
    .filter(Boolean)
  if (recipients.length === 0) {
    throw new Error("Could not load devnet recipient pubkeys from devnet/identities")
  }
  return recipients.join(",")
}

async function runScenario(step: StepConfig, runId: string, args: Args): Promise<StepResult> {
  const cmd = [
    "bash",
    "better_testing/scripts/run-scenario.sh",
    step.scenario,
    "--run-id",
    runId,
    args.quiet ? "--quiet" : "--verbose",
  ]

  if (args.build) {
    cmd.push("--build")
  }

  for (const [key, value] of Object.entries(step.env)) {
    cmd.push("--env", `${key}=${value}`)
  }

  console.log(`\n==> ${step.title}`)
  console.log(`$ ${cmd.join(" ")}`)

  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  })

  const exitCode = await proc.exited
  const resolvedSummaryPath = step.summaryPath.replace("{runId}", runId)
  const hasSummary = fs.existsSync(resolvedSummaryPath)
  const summary = hasSummary ? readJson(resolvedSummaryPath) : null

  let metrics: Record<string, unknown> = {}
  if (summary) {
    switch (step.key) {
      case "native-transfer":
        metrics = {
          tps: summary.tps ?? null,
          p95LatencyMs: summary.latencyMs?.p95 ?? null,
          total: summary.totals?.total ?? null,
          ok: summary.totals?.ok ?? null,
        }
        break
      case "zk-proof":
      case "sync-under-load":
      case "omni-throughput":
        metrics = {
          okTps: summary.throughput?.okTps ?? null,
          p95LatencyMs: summary.latencyMs?.p95 ?? null,
          total: summary.counters?.total ?? null,
          ok: summary.counters?.ok ?? null,
          error: summary.counters?.error ?? null,
          errorRate: summary.errorRate ?? null,
        }
        break
      default:
        metrics = {}
    }
  }

  return {
    key: step.key,
    title: step.title,
    scenario: step.scenario,
    runId,
    ok: exitCode === 0,
    summaryPath: resolvedSummaryPath,
    metrics,
    error: exitCode === 0 ? undefined : hasSummary ? "scenario failed; see artifact" : `scenario failed with exit code ${exitCode}`,
  }
}

function renderMarkdown(summary: {
  runTag: string
  command: string
  configs: StepConfig[]
  results: StepResult[]
}) {
  const lines: string[] = []
  lines.push("# Active Core Performance Baseline")
  lines.push("")
  lines.push(`- Run tag: \`${summary.runTag}\``)
  lines.push(`- Command: \`${summary.command}\``)
  lines.push("")
  lines.push("## Fixed Configs")
  lines.push("")
  for (const config of summary.configs) {
    lines.push(`- \`${config.title}\` via \`${config.scenario}\``)
    lines.push(`  env: \`${Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join(" ")}\``)
  }
  lines.push("")
  lines.push("## Results")
  lines.push("")
  lines.push("| Baseline | Scenario | Status | Key Metrics | Artifact |")
  lines.push("|---|---|---|---|---|")
  for (const result of summary.results) {
    const metricText = Object.entries(result.metrics)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")
    const status = result.ok ? "ok" : `blocked (${result.error ?? "failed"})`
    lines.push(`| ${result.title} | \`${result.scenario}\` | ${status} | ${metricText || "n/a"} | \`${result.summaryPath}\` |`)
  }
  lines.push("")
  lines.push("## Notes")
  lines.push("")
  lines.push("- This is a repo-local active-feature baseline, not a hard SLA.")
  lines.push("- Token transfer is intentionally excluded from the active-core matrix because the current node repo does not expose an implemented token runtime/query path in `src/`; historical token scenarios remain evidence only until that feature status changes.")
  lines.push("- Optional Omni throughput is excluded unless the runner is invoked with `--with-omni`.")
  lines.push("- Failed steps remain listed in the matrix so active regressions are visible instead of being silently skipped.")
  return lines.join("\n") + "\n"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runTag = timestampTag()
  const runDir = path.join(process.cwd(), "better_testing", "runs", `baseline-active-core-${runTag}`)
  ensureDir(runDir)

  const recipients = loadDevnetRecipients()
  const configs: StepConfig[] = [
    {
      key: "native-transfer",
      title: "Native transfer throughput",
      scenario: "transfer",
      summaryPath: path.join(process.cwd(), "better_testing", "runs", "{runId}", "transfer.summary.json"),
      env: {
        RECIPIENTS: recipients,
        CONCURRENCY: "4",
        INFLIGHT_PER_WALLET: "1",
        DURATION_SEC: "20",
      },
    },
    {
      key: "zk-proof",
      title: "ZK proof verification load",
      scenario: "zk_proof_loadgen",
      summaryPath: path.join(process.cwd(), "better_testing", "runs", "{runId}", "features", "zk", "zk_proof_loadgen.summary.json"),
      env: {
        DURATION_SEC: "10",
        CONCURRENCY: "2",
      },
    },
    {
      key: "sync-under-load",
      title: "Peer sync under load",
      scenario: "sync_under_load",
      summaryPath: path.join(process.cwd(), "better_testing", "runs", "{runId}", "features", "peersync", "sync_under_load.summary.json"),
      env: {
        DURATION_SEC: "15",
        CONCURRENCY: "4",
      },
    },
  ]

  if (args.withOmni) {
    configs.push({
      key: "omni-throughput",
      title: "Omni throughput",
      scenario: "omni_throughput",
      summaryPath: path.join(process.cwd(), "better_testing", "runs", "{runId}", "features", "omni", "omni_throughput.summary.json"),
      env: {
        DURATION_SEC: "10",
        CONCURRENCY: "2",
      },
    })
  }

  const results: StepResult[] = []
  for (const config of configs) {
    const runId = `${config.key}-${runTag}`
    results.push(await runScenario(config, runId, args))
  }

  const summary = {
    suite: "active-core-baseline",
    runTag,
    command: `bun better_testing/scripts/run-active-core-baseline.ts${args.build ? " --build" : ""}${args.withOmni ? " --with-omni" : ""}${args.quiet ? " --quiet" : " --verbose"}`,
    results,
    generatedAt: new Date().toISOString(),
  }

  const summaryPath = path.join(runDir, "active-core-baseline.summary.json")
  writeJson(summaryPath, summary)

  const markdown = renderMarkdown({
    runTag,
    command: summary.command,
    configs,
    results,
  })

  const latestDir = path.join(process.cwd(), "better_testing", "runs", "_latest")
  writeText(path.join(latestDir, `active-core-baseline-${runTag}.md`), markdown)
  writeText(path.join(latestDir, "active-core-baseline.latest.md"), markdown)

  console.log(`\nSummary artifact: ${summaryPath}`)
  console.log("Latest report:     better_testing/runs/_latest/active-core-baseline.latest.md")
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

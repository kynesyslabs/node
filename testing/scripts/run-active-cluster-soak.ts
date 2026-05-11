#!/usr/bin/env bun

import * as fs from "fs"
import * as path from "path"

type Args = {
  build: boolean
  quiet: boolean
}

const dockerImageInputPaths = [
  "src",
  "testing/loadgen/src",
  "testing/devnet",
  "package.json",
  "bun.lock",
  "tsconfig.json",
]

function usage() {
  console.log(`Usage:
  bun testing/scripts/run-active-cluster-soak.ts [--build] [--quiet|--verbose]

Runs one active-cluster soak profile on local devnet:
  1. pre-check cluster-health
  2. sustained native transfer load
  3. sustained ZK verification load
  4. post-check cluster-health
`)
}

function parseArgs(argv: string[]): Args {
  let build = false
  let quiet = true
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
    if (arg === "-h" || arg === "--help") {
      usage()
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return { build, quiet }
}

function timestampTag() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function writeJson(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8")
}

function writeText(filePath: string, value: string) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, "utf8")
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function listDirtyDockerImageInputs(): string[] {
  const proc = Bun.spawnSync({
    cmd: [
      "git",
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...dockerImageInputPaths,
    ],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  })

  if (proc.exitCode !== 0) {
    const detail = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : ""
    throw new Error(`git status failed while checking docker image inputs${detail ? `: ${detail}` : ""}`)
  }

  const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : ""
  return stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
}

function assertDockerImageFreshOrThrow(buildRequested: boolean): void {
  if (buildRequested) return

  const dirtyInputs = listDirtyDockerImageInputs()
  if (dirtyInputs.length === 0) return

  const preview = dirtyInputs.slice(0, 8).join(", ")
  const remainder = dirtyInputs.length > 8 ? ` (+${dirtyInputs.length - 8} more)` : ""
  throw new Error(
    `Local devnet image inputs changed but no rebuild was requested. Re-run with --build. Changed paths: ${preview}${remainder}`,
  )
}

function loadDevnetRecipients(): string {
  const identitiesDir = path.join(process.cwd(), "testing", "devnet", "identities")
  return ["node2.pubkey", "node3.pubkey", "node4.pubkey"]
    .map(file => fs.readFileSync(path.join(identitiesDir, file), "utf8").trim())
    .filter(Boolean)
    .join(",")
}

async function runCommand(cmd: string[], env: Record<string, string> = {}) {
  console.log(`$ ${cmd.join(" ")}`)
  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: { ...process.env, ...env },
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed with exit code ${exitCode}`)
  }
}

function renderMarkdown(summary: {
  runTag: string
  command: string
  transferSummaryPath: string
  transferSummary: any
  zkSummaryPath: string
  zkSummary: any
  preCheckCopyPath: string
  postCheckCopyPath: string
}) {
  const lines: string[] = []
  lines.push("# Active Cluster Soak")
  lines.push("")
  lines.push(`- Run tag: \`${summary.runTag}\``)
  lines.push(`- Command: \`${summary.command}\``)
  lines.push("")
  lines.push("## Profile")
  lines.push("")
  lines.push("- pre-check: `cluster-health`")
  lines.push("- write-heavy path: `transfer`")
  lines.push("- verification/read path: `zk_proof_loadgen`")
  lines.push("- post-check: `cluster-health`")
  lines.push("")
  lines.push("## Results")
  lines.push("")
  lines.push(`- pre-check report copy: \`${summary.preCheckCopyPath}\``)
  lines.push(`- native transfer soak: tps=\`${summary.transferSummary.tps}\`, p95LatencyMs=\`${summary.transferSummary.latencyMs?.p95}\`, artifact=\`${summary.transferSummaryPath}\``)
  lines.push(`- zk verification soak: okTps=\`${summary.zkSummary.throughput?.okTps}\`, p95LatencyMs=\`${summary.zkSummary.latencyMs?.p95}\`, artifact=\`${summary.zkSummaryPath}\``)
  lines.push(`- post-check report copy: \`${summary.postCheckCopyPath}\``)
  lines.push("")
  lines.push("## Notes")
  lines.push("")
  lines.push("- This soak profile stays within active implemented features only.")
  lines.push("- It is intentionally one mixed profile, not a per-feature soak matrix.")
  return lines.join("\n") + "\n"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  assertDockerImageFreshOrThrow(args.build)
  const runTag = timestampTag()
  const rootRunsDir = path.join(process.cwd(), "testing", "runs")
  const soakRunDir = path.join(rootRunsDir, `cluster-soak-${runTag}`)
  ensureDir(soakRunDir)

  const clusterCmd = [
    "bun",
    "testing/scripts/run-suite.ts",
    "cluster-health",
    "--local",
    "--scenario-timeout-sec",
    "240",
  ]
  if (args.build) {
    clusterCmd.push("--build-first")
  }

  console.log("\n==> Pre-check cluster health")
  await runCommand(clusterCmd)
  const latestClusterReport = path.join(rootRunsDir, "_latest", "cluster-health.latest.md")
  const preCheckCopyPath = path.join(soakRunDir, "cluster-health.pre.md")
  fs.copyFileSync(latestClusterReport, preCheckCopyPath)

  const transferRunId = `cluster-soak-transfer-${runTag}`
  console.log("\n==> Sustained native transfer load")
  await runCommand([
    "bash",
    "testing/scripts/run-scenario.sh",
    "transfer",
    "--run-id",
    transferRunId,
    args.quiet ? "--quiet" : "--verbose",
    ...(args.build ? ["--build"] : []),
    "--env",
    "DURATION_SEC=60",
    "--env",
    "CONCURRENCY=4",
    "--env",
    "INFLIGHT_PER_WALLET=1",
    "--env",
    `RECIPIENTS=${loadDevnetRecipients()}`,
  ])
  const transferSummaryPath = path.join(rootRunsDir, transferRunId, "transfer.summary.json")
  const transferSummary = readJson(transferSummaryPath)

  const zkRunId = `cluster-soak-zk-${runTag}`
  console.log("\n==> Sustained ZK verification load")
  await runCommand([
    "bash",
    "testing/scripts/run-scenario.sh",
    "zk_proof_loadgen",
    "--run-id",
    zkRunId,
    args.quiet ? "--quiet" : "--verbose",
    "--env",
    "DURATION_SEC=30",
    "--env",
    "CONCURRENCY=2",
  ])
  const zkSummaryPath = path.join(rootRunsDir, zkRunId, "features", "zk", "zk_proof_loadgen.summary.json")
  const zkSummary = readJson(zkSummaryPath)

  console.log("\n==> Post-check cluster health")
  await runCommand(clusterCmd)
  const postCheckCopyPath = path.join(soakRunDir, "cluster-health.post.md")
  fs.copyFileSync(latestClusterReport, postCheckCopyPath)

  const summary = {
    suite: "active-cluster-soak",
    runTag,
    command: `bun testing/scripts/run-active-cluster-soak.ts${args.build ? " --build" : ""}${args.quiet ? " --quiet" : " --verbose"}`,
    steps: {
      preCheckCopyPath,
      transferSummaryPath,
      zkSummaryPath,
      postCheckCopyPath,
    },
    transferSummary,
    zkSummary,
    generatedAt: new Date().toISOString(),
  }
  writeJson(path.join(soakRunDir, "cluster-soak.summary.json"), summary)

  const markdown = renderMarkdown({
    runTag,
    command: summary.command,
    transferSummaryPath,
    transferSummary,
    zkSummaryPath,
    zkSummary,
    preCheckCopyPath,
    postCheckCopyPath,
  })
  const latestDir = path.join(rootRunsDir, "_latest")
  writeText(path.join(latestDir, `cluster-soak-${runTag}.md`), markdown)
  writeText(path.join(latestDir, "cluster-soak.latest.md"), markdown)

  console.log(`\nSummary artifact: ${path.join(soakRunDir, "cluster-soak.summary.json")}`)
  console.log("Latest report:     testing/runs/_latest/cluster-soak.latest.md")
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

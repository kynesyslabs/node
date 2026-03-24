#!/usr/bin/env bun

type VerifyArgs = {
  local: boolean
  scenarioTimeoutSec: number
  verbose: boolean
}

type Step = {
  name: string
  cmd: string[]
}

function parseArgs(argv: string[]): VerifyArgs {
  let local = false
  let verbose = false
  let scenarioTimeoutSec = 30

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === "--local") {
      local = true
      continue
    }
    if (arg === "--verbose") {
      verbose = true
      continue
    }
    if (arg === "--scenario-timeout-sec") {
      scenarioTimeoutSec = Number(argv[++i] ?? "30") || 30
      continue
    }
    if (arg === "-h" || arg === "--help") {
      console.log(`Usage:
  bun testing/scripts/verify-release-gate.ts [--local] [--verbose] [--scenario-timeout-sec N]

Runs the deterministic release gate:
  1. bun build-based repo sanity check
  2. scoped TypeScript check for the release-gate surface
  3. prod-gate suite
`)
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return { local, scenarioTimeoutSec, verbose }
}

async function runStep(step: Step, verbose: boolean): Promise<void> {
  console.log(`\n==> ${step.name}`)
  console.log(`$ ${step.cmd.join(" ")}`)

  const proc = Bun.spawn(step.cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    cwd: process.cwd(),
    env: process.env,
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${step.name} failed with exit code ${exitCode}`)
  }

  if (verbose) {
    console.log(`Completed: ${step.name}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const suiteCmd = [
    "bun",
    "testing/scripts/run-suite.ts",
    "prod-gate",
    "--scenario-timeout-sec",
    String(args.scenarioTimeoutSec),
  ]

  if (args.local) {
    suiteCmd.push("--local")
  }

  const steps: Step[] = [
    {
      name: "Bundle check",
      cmd: ["bun", "run", "type-check"],
    },
    {
      name: "Release-gate TypeScript check",
      cmd: ["./node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.release-gate.json"],
    },
    {
      name: "Prod-gate suite",
      cmd: suiteCmd,
    },
  ]

  for (const step of steps) {
    await runStep(step, args.verbose)
  }

  console.log("\nRelease gate passed.")
}

main().catch(error => {
  console.error("\nRelease gate failed.")
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

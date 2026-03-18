#!/usr/bin/env bun

import * as fs from "fs"
import * as path from "path"

const latestDir = path.join(process.cwd(), "better_testing", "runs", "_latest")

function usage(): never {
  console.log(`Usage:
  bun better_testing/scripts/show-latest-report.ts
  bun better_testing/scripts/show-latest-report.ts <suite>

Examples:
  bun better_testing/scripts/show-latest-report.ts
  bun better_testing/scripts/show-latest-report.ts sanity
`)
  process.exit(0)
}

function getLatestReportPaths(): string[] {
  if (!fs.existsSync(latestDir)) {
    return []
  }
  return fs.readdirSync(latestDir)
    .filter(name => name.endsWith(".latest.md"))
    .sort()
    .map(name => path.join(latestDir, name))
}

function main() {
  const arg = process.argv[2]
  if (arg === "-h" || arg === "--help") {
    usage()
  }

  const reportPaths = getLatestReportPaths()
  if (reportPaths.length === 0) {
    console.log("No latest suite reports found in better_testing/runs/_latest")
    process.exit(1)
  }

  if (!arg) {
    for (let index = 0; index < reportPaths.length; index++) {
      const reportPath = reportPaths[index]!
      if (index > 0) {
        console.log("\n---\n")
      }
      console.log(fs.readFileSync(reportPath, "utf8").trim())
    }
    return
  }

  const reportPath = path.join(latestDir, `${arg}.latest.md`)
  if (!fs.existsSync(reportPath)) {
    console.log(`No latest report found for suite '${arg}' in better_testing/runs/_latest`)
    process.exit(1)
  }

  console.log(fs.readFileSync(reportPath, "utf8").trim())
}

main()

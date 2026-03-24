import { spawnSync } from "node:child_process"

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("Usage: bun scripts/brx.ts <br command...>")
  process.exit(1)
}

function run(cmd: string, cmdArgs: string[]) {
  return spawnSync(cmd, cmdArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  })
}

const br = run("/home/tcsenpai/.local/bin/br", args)
if (typeof br.status === "number" && br.status !== 0) {
  process.exit(br.status)
}
if (br.error) {
  console.error(br.error.message)
  process.exit(1)
}

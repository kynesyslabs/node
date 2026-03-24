import * as fs from "fs"
import * as path from "path"

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

export function getRunConfig() {
  const runsDir = process.env.RUNS_DIR ?? "/runs"
  const runIdEnv = process.env.RUN_ID
  const runId = safeName(runIdEnv && runIdEnv.trim().length > 0 ? runIdEnv : new Date().toISOString())
  const runDir = path.join(runsDir, runId)
  return { runsDir, runId, runDir }
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function stringifyJson(value: unknown, pretty: boolean) {
  const replacer = (_key: string, currentValue: any) => (typeof currentValue === "bigint" ? currentValue.toString() : currentValue)
  return pretty ? JSON.stringify(value, replacer, 2) : JSON.stringify(value, replacer)
}

export function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, stringifyJson(data, true) + "\n", "utf8")
}

export function appendJsonl(filePath: string, obj: unknown) {
  ensureDir(path.dirname(filePath))
  fs.appendFileSync(filePath, stringifyJson(obj, false) + "\n", "utf8")
}

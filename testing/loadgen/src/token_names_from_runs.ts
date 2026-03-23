import path from "path"
import { nodeCall } from "./token_shared"
import { logNonCriticalErrorOnce } from "./framework/common"

function env(name: string, fallback: string): string {
  const raw = process.env[name]
  return raw && raw.trim().length > 0 ? raw.trim() : fallback
}

function safeParseJson(text: string): any | null {
  try {
    return JSON.parse(text)
  } catch (error) {
    logNonCriticalErrorOnce("token_names_from_runs.safeParseJson", "token_names_from_runs.safeParseJson", error)
    return null
  }
}

function extractTokenAddress(summary: any): string | null {
  if (!summary || typeof summary !== "object") return null
  const direct = summary.tokenAddress
  if (typeof direct === "string" && direct.startsWith("0x")) return direct
  return null
}

async function listTokenAddressesFromRuns(runsDir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.summary.json")
  const addresses = new Set<string>()

  for await (const rel of glob.scan(runsDir)) {
    const full = path.join(runsDir, rel)
    const text = await Bun.file(full).text().catch(() => "")
    if (!text) continue
    const parsed = safeParseJson(text)
    const addr = extractTokenAddress(parsed)
    if (addr) addresses.add(addr)
  }

  return Array.from(addresses)
}

export async function runTokenNamesFromRuns() {
  const runsDir = env("RUNS_DIR", "testing/runs")
  const rpcUrl = env("RPC_URL", "http://localhost:53551")

  const tokenAddresses = await listTokenAddressesFromRuns(runsDir)
  const results: any[] = []

  for (const tokenAddress of tokenAddresses) {
    const res = await nodeCall(rpcUrl, "token.get", { tokenAddress }, `token.get:${tokenAddress}`)
    const ok = res?.result === 200
    results.push({
      tokenAddress,
      ok,
      name: res?.response?.metadata?.name ?? null,
      ticker: res?.response?.metadata?.ticker ?? null,
      deployer: res?.response?.metadata?.deployer ?? null,
      error: ok ? null : res?.response ?? null,
    })
  }

  const output = {
    rpcUrl,
    runsDir,
    count: results.length,
    tokens: results.sort((a, b) => String(a.tokenAddress).localeCompare(String(b.tokenAddress))),
    timestamp: new Date().toISOString(),
  }

  console.log(JSON.stringify({ token_names_from_runs: output }, null, 2))
}

if (import.meta.main) {
  await runTokenNamesFromRuns()
}

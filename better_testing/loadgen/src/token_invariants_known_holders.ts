import { createHash } from "crypto"
import { getRunConfig, writeJson } from "./framework/io"
import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  readWalletMnemonics,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true
    case "0":
    case "false":
    case "no":
    case "n":
    case "off":
      return false
    default:
      return fallback
  }
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
}

function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

function sortObjectDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortObjectDeep)
  if (!value || typeof value !== "object") return value
  const out: Record<string, any> = {}
  for (const key of Object.keys(value).sort()) out[key] = sortObjectDeep((value as any)[key])
  return out
}

function stableJson(value: any): string {
  return JSON.stringify(sortObjectDeep(value))
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

async function rpcPost(rpcUrl: string, body: unknown): Promise<any> {
  const url = normalizeRpcUrl(rpcUrl)
  const timeoutMs = envInt("NODECALL_FETCH_TIMEOUT_MS", 8000)
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const json = await res.json().catch(() => null)
    return json
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function nodeCallExact(rpcUrl: string, message: string, data: any, muid: string): Promise<any> {
  return await rpcPost(rpcUrl, { method: "nodeCall", params: [{ message, data, muid }] })
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type PerNodeInvariant = {
  rpcUrl: string
  ok: boolean
  inFlux: boolean
  tokenGet?: any
  details?: {
    totalSupply?: string | null
    sumBalances?: string | null
    stateHash?: string | null
    unknownHolders?: string[]
  }
  error?: string | null
}

function safeBigInt(value: any): bigint | null {
  if (typeof value !== "string") return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function computeBalanceSum(balances: Record<string, any>): { sum: bigint; invalid: string[] } {
  let sum = 0n
  const invalid: string[] = []
  for (const [addr, raw] of Object.entries(balances ?? {})) {
    const b = safeBigInt(raw)
    if (b === null || b < 0n) {
      invalid.push(addr)
      continue
    }
    sum += b
  }
  return { sum, invalid }
}

export async function runTokenInvariantsKnownHolders() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  if (targets.length === 0) throw new Error("No TARGETS configured")

  const readMode = (process.env.READ_MODE ?? "live").trim().toLowerCase()
  const fallbackOnInFlux = envBool("FALLBACK_TO_LIVE_ON_IN_FLUX", true)
  const getMsgPrimary = readMode === "committed" ? "token.getCommitted" : "token.get"
  const balMsgPrimary = readMode === "committed" ? "token.getBalanceCommitted" : "token.getBalance"

  const bootstrapRpc = targets[0]!
  await waitForRpcReady(bootstrapRpc, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(bootstrapRpc, envInt("WAIT_FOR_TX_SEC", 120))

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("No wallets configured (WALLETS or devnet/identities/*)")

  const walletCount = Math.max(2, envInt("INVARIANT_WALLETS", 4))
  const walletAddresses = await getWalletAddresses(bootstrapRpc, wallets.slice(0, walletCount))

  const deployerMnemonic = wallets[0]!
  const bootstrap = await ensureTokenAndBalances(bootstrapRpc, deployerMnemonic, walletAddresses)
  const tokenAddress = normalizeHexAddress(bootstrap.tokenAddress)

  const knownOnly = envBool("KNOWN_ONLY", true)
  const extraKnown = splitCsv(process.env.ADDRESSES).map(normalizeHexAddress).filter(Boolean)
  const knownHolders = Array.from(new Set([...walletAddresses.map(normalizeHexAddress), ...extraKnown]))
  const knownSet = new Set(knownHolders)

  const timeoutSec = envInt("INVARIANT_TIMEOUT_SEC", 480)
  const pollMs = Math.max(100, envInt("INVARIANT_POLL_MS", 1000))
  const deadlineMs = Date.now() + Math.max(1, timeoutSec) * 1000

  const perNode: PerNodeInvariant[] = []
  let ok = false
  let attempts = 0

  while (Date.now() < deadlineMs) {
    attempts++
    perNode.length = 0

    for (const rpcUrlRaw of targets) {
      const rpcUrl = normalizeRpcUrl(rpcUrlRaw)
      let res = await nodeCallExact(
        rpcUrl,
        getMsgPrimary,
        { tokenAddress },
        `${getMsgPrimary}:invariants:${attempts}:${rpcUrl}`,
      )

      if (res?.result === 409 && readMode === "committed" && fallbackOnInFlux) {
        res = await nodeCallExact(
          rpcUrl,
          "token.get",
          { tokenAddress },
          `token.get:fallback:invariants:${attempts}:${rpcUrl}`,
        )
      }

      if (res?.result === 409) {
        perNode.push({ rpcUrl, ok: false, inFlux: true, tokenGet: res, error: "STATE_IN_FLUX" })
        continue
      }

      if (res?.result !== 200) {
        perNode.push({ rpcUrl, ok: false, inFlux: false, tokenGet: res, error: `token.getCommitted result=${res?.result}` })
        continue
      }

      const state = res?.response?.state ?? {}
      const totalSupplyRaw = state?.totalSupply ?? null
      const totalSupply = safeBigInt(totalSupplyRaw)
      const balances = (state?.balances ?? {}) as Record<string, any>
      const allowances = (state?.allowances ?? {}) as Record<string, any>
      const customState = state?.customState ?? null

      const { sum, invalid } = computeBalanceSum(balances)
      const unknownHolders = knownOnly
        ? Object.keys(balances).map(normalizeHexAddress).filter(a => a && !knownSet.has(a))
        : []

      const stateForHash = {
        tokenAddress,
        totalSupply: typeof totalSupplyRaw === "string" ? totalSupplyRaw : null,
        balances,
        allowances,
        customState,
      }

      const stateHash = sha256Hex(stableJson(stateForHash))

      const supplyOk = totalSupply !== null && totalSupply === sum
      const balancesOk = invalid.length === 0
      const knownOk = !knownOnly || unknownHolders.length === 0

      perNode.push({
        rpcUrl,
        ok: supplyOk && balancesOk && knownOk,
        inFlux: false,
        tokenGet: res,
        details: {
          totalSupply: typeof totalSupplyRaw === "string" ? totalSupplyRaw : null,
          sumBalances: sum.toString(),
          stateHash,
          unknownHolders,
        },
        error: supplyOk && balancesOk && knownOk
          ? null
          : [
            !supplyOk ? "SUPPLY_MISMATCH" : null,
            !balancesOk ? `INVALID_BALANCES(${invalid.length})` : null,
            !knownOk ? `UNKNOWN_HOLDERS(${unknownHolders.length})` : null,
          ].filter(Boolean).join("; "),
      })
    }

    const allOk = perNode.length === targets.length && perNode.every(n => n.ok)
    const allStateHashesEqual = (() => {
      const hashes = perNode.map(n => n.details?.stateHash).filter(Boolean) as string[]
      if (hashes.length !== perNode.length) return false
      return hashes.every(h => h === hashes[0])
    })()

    if (allOk && allStateHashesEqual) {
      ok = true
      break
    }

    await sleep(pollMs)
  }

  const run = getRunConfig()
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${run.runDir}/token_invariants_known_holders.summary.json`,
  }

  const summary = {
    runId: run.runId,
    scenario: "token_invariants_known_holders",
    ok,
    tokenAddress,
    rpcUrls: targets,
    readMode,
    fallbackOnInFlux,
    knownOnly,
    knownHolders,
    config: {
      invariantWallets: walletCount,
      timeoutSec,
      pollMs,
    },
    attempts,
    perNode: perNode.map(n => ({
      rpcUrl: n.rpcUrl,
      ok: n.ok,
      inFlux: n.inFlux,
      details: n.details ?? null,
      error: n.error ?? null,
    })),
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, summary)
  console.log(JSON.stringify({ token_invariants_known_holders_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("Invariant check failed (see summary artifacts)")
  }
}

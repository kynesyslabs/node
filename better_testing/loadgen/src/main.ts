import { runRpcLoadgen } from "./rpc_loadgen"
import { runTransferLoadgen } from "./transfer_loadgen"
import { runTransferRamp } from "./transfer_ramp"
import { runRpcRamp } from "./rpc_ramp"
import { runTokenSmoke } from "./token_smoke"
import { runTokenTransferLoadgen } from "./token_transfer_loadgen"
import { runTokenTransferRamp } from "./token_transfer_ramp"
import { runTokenMintSmoke } from "./token_mint_smoke"
import { runTokenBurnSmoke } from "./token_burn_smoke"
import { runTokenMintLoadgen } from "./token_mint_loadgen"
import { runTokenBurnLoadgen } from "./token_burn_loadgen"
import { runTokenMintRamp } from "./token_mint_ramp"
import { runTokenBurnRamp } from "./token_burn_ramp"
import { runTokenAclSmoke } from "./token_acl_smoke"
import { runTokenConsensusConsistency } from "./token_consensus_consistency"
import { runTokenQueryCoverage } from "./token_query_coverage"
import { runImOnlineLoadgen } from "./im_online_loadgen"
import { runImOnlineRamp } from "./im_online_ramp"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

const fetchTimeoutMs = Math.max(0, envInt("FETCH_TIMEOUT_MS", 0))
if (fetchTimeoutMs > 0) {
  const originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: any, init: any = {}) => {
    if (init?.signal) return originalFetch(input, init)
    const controller = new AbortController()
    const timeout: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), fetchTimeoutMs)
    try {
      return await originalFetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }
}

const scenario = (process.env.SCENARIO ?? "rpc").toLowerCase()

switch (scenario) {
  case "rpc":
    await runRpcLoadgen()
    break
  case "rpc_ramp":
    await runRpcRamp()
    break
  case "transfer":
    await runTransferLoadgen()
    break
  case "transfer_ramp":
    await runTransferRamp()
    break
  case "token_smoke":
    await runTokenSmoke()
    break
  case "token_transfer":
    await runTokenTransferLoadgen()
    break
  case "token_transfer_ramp":
    await runTokenTransferRamp()
    break
  case "token_mint_smoke":
    await runTokenMintSmoke()
    break
  case "token_burn_smoke":
    await runTokenBurnSmoke()
    break
  case "token_mint":
    await runTokenMintLoadgen()
    break
  case "token_burn":
    await runTokenBurnLoadgen()
    break
  case "token_mint_ramp":
    await runTokenMintRamp()
    break
  case "token_burn_ramp":
    await runTokenBurnRamp()
    break
  case "token_acl_smoke":
    await runTokenAclSmoke()
    break
  case "token_consensus_consistency":
    await runTokenConsensusConsistency()
    break
  case "token_query_coverage":
    await runTokenQueryCoverage()
    break
  case "im_online":
    await runImOnlineLoadgen()
    break
  case "im_online_ramp":
    await runImOnlineRamp()
    break
  default:
    throw new Error(
      `Unknown SCENARIO: ${scenario}. Valid: rpc, rpc_ramp, transfer, transfer_ramp, token_smoke, token_transfer, token_transfer_ramp, token_mint_smoke, token_burn_smoke, token_mint, token_burn, token_mint_ramp, token_burn_ramp, token_acl_smoke, token_consensus_consistency, token_query_coverage, im_online, im_online_ramp`,
    )
}

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
import { runTokenAclMatrix } from "./token_acl_matrix"
import { runTokenEdgeCases } from "./token_edge_cases"
import { runTokenAclBurnMatrix } from "./token_acl_burn_matrix"
import { runTokenAclPauseMatrix } from "./token_acl_pause_matrix"
import { runTokenAclTransferOwnershipMatrix } from "./token_acl_transfer_ownership_matrix"
import { runTokenAclMultiPermissionMatrix } from "./token_acl_multi_permission_matrix"
import { runTokenAclUpdateAclCompat } from "./token_acl_updateacl_compat"
import { runTokenScriptSmoke } from "./token_script_smoke"
import { runTokenScriptHooksCorrectness } from "./token_script_hooks_correctness"
import { runTokenScriptRejects } from "./token_script_rejects"
import { runTokenScriptTransferLoadgen } from "./token_script_transfer_loadgen"
import { runTokenScriptTransferRamp } from "./token_script_transfer_ramp"
import { runTokenScriptMintLoadgen } from "./token_script_mint_loadgen"
import { runTokenScriptMintRamp } from "./token_script_mint_ramp"
import { runTokenScriptBurnLoadgen } from "./token_script_burn_loadgen"
import { runTokenScriptBurnRamp } from "./token_script_burn_ramp"
import { runTokenScriptUpgradeMidLoad } from "./token_script_upgrade_mid_load"
import { runTokenSettleCheck } from "./token_settle_check"
import { runTokenObserve } from "./token_observe"
import { runTokenInvariantsKnownHolders } from "./token_invariants_known_holders"
import { runTokenPauseUnderLoad } from "./token_pause_under_load"
import { runTokenHoldersExport } from "./token_holders_export"
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
  case "token_acl_matrix":
    await runTokenAclMatrix()
    break
  case "token_consensus_consistency":
    await runTokenConsensusConsistency()
    break
  case "token_query_coverage":
    await runTokenQueryCoverage()
    break
  case "token_edge_cases":
    await runTokenEdgeCases()
    break
  case "token_acl_burn_matrix":
    await runTokenAclBurnMatrix()
    break
  case "token_acl_pause_matrix":
    await runTokenAclPauseMatrix()
    break
  case "token_acl_transfer_ownership_matrix":
    await runTokenAclTransferOwnershipMatrix()
    break
  case "token_acl_multi_permission_matrix":
    await runTokenAclMultiPermissionMatrix()
    break
  case "token_acl_updateacl_compat":
    await runTokenAclUpdateAclCompat()
    break
  case "token_script_smoke":
    await runTokenScriptSmoke()
    break
  case "token_script_hooks_correctness":
    await runTokenScriptHooksCorrectness()
    break
  case "token_script_rejects":
    await runTokenScriptRejects()
    break
  case "token_script_upgrade_mid_load":
    await runTokenScriptUpgradeMidLoad()
    break
  case "token_script_transfer":
    await runTokenScriptTransferLoadgen()
    break
  case "token_script_transfer_ramp":
    await runTokenScriptTransferRamp()
    break
  case "token_script_mint":
    await runTokenScriptMintLoadgen()
    break
  case "token_script_mint_ramp":
    await runTokenScriptMintRamp()
    break
  case "token_script_burn":
    await runTokenScriptBurnLoadgen()
    break
  case "token_script_burn_ramp":
    await runTokenScriptBurnRamp()
    break
  case "token_settle_check":
    await runTokenSettleCheck()
    break
  case "token_observe":
    await runTokenObserve()
    break
  case "token_invariants_known_holders":
    await runTokenInvariantsKnownHolders()
    break
  case "token_pause_under_load":
    await runTokenPauseUnderLoad()
    break
  case "token_holders_export":
    await runTokenHoldersExport()
    break
  case "im_online":
    await runImOnlineLoadgen()
    break
  case "im_online_ramp":
    await runImOnlineRamp()
    break
  default:
    throw new Error(
      `Unknown SCENARIO: ${scenario}. Valid: rpc, rpc_ramp, transfer, transfer_ramp, token_smoke, token_transfer, token_transfer_ramp, token_mint_smoke, token_burn_smoke, token_mint, token_burn, token_mint_ramp, token_burn_ramp, token_acl_smoke, token_acl_matrix, token_acl_burn_matrix, token_acl_pause_matrix, token_acl_transfer_ownership_matrix, token_acl_multi_permission_matrix, token_acl_updateacl_compat, token_pause_under_load, token_holders_export, token_script_smoke, token_script_hooks_correctness, token_script_rejects, token_script_upgrade_mid_load, token_script_transfer, token_script_transfer_ramp, token_script_mint, token_script_mint_ramp, token_script_burn, token_script_burn_ramp, token_settle_check, token_observe, token_invariants_known_holders, token_consensus_consistency, token_query_coverage, token_edge_cases, im_online, im_online_ramp`,
    )
}

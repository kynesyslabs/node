import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenBurnTxWithDemos,
  sendTokenGrantPermissionTxWithDemos,
  sendTokenRevokePermissionTxWithDemos,
  waitForCrossNodeTokenConsistency,
  withDemosWallet,
} from "./token_shared"
import { getRunConfig, writeJson } from "./framework/io"

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function normalizeRpcUrl(url: string): string {
  return url.replace(/\/+$/, "") + "/"
}

function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

function parseBigintOrZero(value: any): bigint {
  try {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(value)
    if (typeof value === "string") return BigInt(value)
  } catch {
    // ignore
  }
  return 0n
}

function assertRejected(res: any, expectedMessageSubstring: string) {
  if (res?.result === 200) {
    throw new Error(`Expected rejection but got result=200: ${JSON.stringify(res)}`)
  }

  const pieces: string[] = []
  if (typeof res?.extra?.error === "string") pieces.push(res.extra.error)
  if (typeof res?.response === "string") pieces.push(res.response)
  if (res?.response === false) pieces.push("false")
  if (typeof res?.message === "string") pieces.push(res.message)
  const haystack = pieces.join(" ").toLowerCase()

  if (!haystack.includes(expectedMessageSubstring.toLowerCase())) {
    throw new Error(`Expected error to include "${expectedMessageSubstring}" but got: ${JSON.stringify(res)}`)
  }
}

async function getLastBlockNumber(rpcUrl: string, muid: string): Promise<number | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, muid)
  const n = res?.response
  if (typeof n === "number" && Number.isFinite(n)) return n
  if (typeof n === "string") {
    const parsed = Number.parseInt(n, 10)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function waitForConsensusRounds(params: {
  rpcUrls: string[]
  rounds: number
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const start: Record<string, number | null> = {}
  for (const rpcUrl of params.rpcUrls) {
    start[rpcUrl] = await getLastBlockNumber(rpcUrl, `getLastBlockNumber:start:${rpcUrl}`)
  }

  while (Date.now() < deadlineMs) {
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      const base = start[rpcUrl]
      const current = await getLastBlockNumber(rpcUrl, `getLastBlockNumber:poll:${rpcUrl}`)
      const ok = typeof base === "number" && typeof current === "number" && current >= base + params.rounds
      if (!ok) allOk = false
    }
    if (allOk) return { ok: true, start }
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }

  return { ok: false, start }
}

async function snapshot(rpcUrl: string, tokenAddress: string, addresses: string[]) {
  const token = await nodeCall(rpcUrl, "token.get", { tokenAddress }, `token.get:${tokenAddress}`)
  if (token?.result !== 200) throw new Error(`token.get failed: ${JSON.stringify(token)}`)

  const supply = parseBigintOrZero(token?.response?.state?.totalSupply)
  const balances: Record<string, bigint> = {}
  for (const a of addresses) {
    const bal = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    if (bal?.result !== 200) throw new Error(`token.getBalance failed: ${JSON.stringify(bal)}`)
    balances[a] = parseBigintOrZero(bal?.response?.balance)
  }
  const aclEntries = Array.isArray(token?.response?.accessControl?.entries) ? token.response.accessControl.entries : []
  return { supply, balances, aclEntries }
}

function hasAclPermission(aclEntries: any[], address: string, permission: string): boolean {
  const addr = normalizeHexAddress(address)
  for (const entry of aclEntries ?? []) {
    const entryAddr = normalizeHexAddress(entry?.address ?? "")
    if (entryAddr !== addr) continue
    const perms = Array.isArray(entry?.permissions) ? entry.permissions : []
    return perms.includes(permission)
  }
  return false
}

async function waitForCondition(params: {
  rpcUrl: string
  tokenAddress: string
  addresses: string[]
  timeoutSec: number
  pollMs: number
  condition: (s: Awaited<ReturnType<typeof snapshot>>) => boolean
  label: string
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempt = 0
  while (Date.now() < deadlineMs) {
    const s = await snapshot(params.rpcUrl, params.tokenAddress, params.addresses)
    if (params.condition(s)) return { ok: true, attempt, snapshot: s }
    attempt++
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }
  const last = await snapshot(params.rpcUrl, params.tokenAddress, params.addresses)
  return { ok: false, attempt, snapshot: last, error: `Timeout waiting for condition: ${params.label}` }
}

export async function runTokenAclBurnMatrix() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_acl_burn_matrix requires at least 3 wallets (owner, grantee, outsider)")

  const ownerMnemonic = wallets[0]!
  const granteeMnemonic = wallets[1]!
  const outsiderMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, granteeMnemonic, outsiderMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const grantee = walletAddresses[1]!
  const outsider = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const burnAmount = parseBigintOrZero(process.env.TOKEN_BURN_AMOUNT ?? "1")
  const permission = "canBurn"
  const applyTimeoutSec = envInt("TOKEN_WAIT_APPLY_SEC", 120)

  const before = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])

  // 1) Self-burn should be allowed without canBurn permission.
  const selfBurn = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: grantee, amount: burnAmount, nonce })
    },
  })

  const waitSelfBurn = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitSelfBurn.ok) throw new Error("Consensus wait failed after self burn")

  const appliedSelfBurn = await waitForCondition({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs: envInt("TOKEN_APPLY_POLL_MS", 500),
    label: "selfBurn applied (supply+grantee balance)",
    condition: s =>
      s.supply === before.supply - burnAmount &&
      s.balances[grantee] === before.balances[grantee] - burnAmount,
  })
  if (!appliedSelfBurn.ok) throw new Error(`Self-burn not applied in time: ${JSON.stringify(appliedSelfBurn)}`)
  const afterSelfBurn = appliedSelfBurn.snapshot
  const selfBurnApplied = selfBurn?.res?.result === 200

  // 2) Burn-from-other should be rejected without canBurn.
  const burnOtherNoPerm = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: owner, amount: burnAmount, nonce })
    },
  })
  assertRejected(burnOtherNoPerm?.res, "No burn permission")

  const waitNoPerm = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitNoPerm.ok) throw new Error("Consensus wait failed after burn-from-other without permission")

  const afterNoPerm = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  const unauthorizedBlocked =
    afterNoPerm.supply === afterSelfBurn.supply &&
    afterNoPerm.balances[owner] === afterSelfBurn.balances[owner] &&
    afterNoPerm.balances[grantee] === afterSelfBurn.balances[grantee]

  // 3) Owner grants canBurn to grantee.
  const grant = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenGrantPermissionTxWithDemos({ demos, tokenAddress, grantee, permissions: [permission], nonce })
    },
  })

  const waitGrant = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitGrant.ok) throw new Error("Consensus wait failed after grantPermission")

  const afterGrantCondition = await waitForCondition({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs: envInt("TOKEN_APPLY_POLL_MS", 500),
    label: "grant visible (ACL canBurn present)",
    condition: s => hasAclPermission(s.aclEntries, grantee, permission),
  })
  if (!afterGrantCondition.ok) throw new Error(`Grant not visible in time: ${JSON.stringify(afterGrantCondition)}`)
  const afterGrant = afterGrantCondition.snapshot
  const grantAccepted = grant?.res?.result === 200
  const grantVisible = hasAclPermission(afterGrant.aclEntries, grantee, permission)

  // 4) Burn-from-owner should now succeed.
  const burnWithPerm = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: owner, amount: burnAmount, nonce })
    },
  })

  const waitBurnWithPerm = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitBurnWithPerm.ok) throw new Error("Consensus wait failed after burn-from-other with permission")

  const appliedBurnWithPerm = await waitForCondition({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs: envInt("TOKEN_APPLY_POLL_MS", 500),
    label: "burnWithPerm applied (supply+owner balance)",
    condition: s =>
      s.supply === afterGrant.supply - burnAmount &&
      s.balances[owner] === afterGrant.balances[owner] - burnAmount,
  })
  if (!appliedBurnWithPerm.ok) throw new Error(`Burn-with-perm not applied in time: ${JSON.stringify(appliedBurnWithPerm)}`)
  const afterWithPerm = appliedBurnWithPerm.snapshot
  const burnWithPermAccepted = burnWithPerm?.res?.result === 200
  const burnWithPermApplied =
    burnWithPermAccepted &&
    afterWithPerm.supply === afterGrant.supply - burnAmount &&
    afterWithPerm.balances[owner] === afterGrant.balances[owner] - burnAmount

  // 5) Owner revokes canBurn.
  const revoke = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenRevokePermissionTxWithDemos({ demos, tokenAddress, grantee, permissions: [permission], nonce })
    },
  })

  const waitRevoke = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitRevoke.ok) throw new Error("Consensus wait failed after revokePermission")

  const afterRevokeCondition = await waitForCondition({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs: envInt("TOKEN_APPLY_POLL_MS", 500),
    label: "revoke visible (ACL canBurn removed)",
    condition: s => !hasAclPermission(s.aclEntries, grantee, permission),
  })
  if (!afterRevokeCondition.ok) throw new Error(`Revoke not visible in time: ${JSON.stringify(afterRevokeCondition)}`)
  const afterRevoke = afterRevokeCondition.snapshot
  const revokeAccepted = revoke?.res?.result === 200
  const revokeVisible = !hasAclPermission(afterRevoke.aclEntries, grantee, permission)

  // 6) Burn-from-owner should be rejected again.
  const burnAfterRevoke = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: owner, amount: burnAmount, nonce })
    },
  })
  assertRejected(burnAfterRevoke?.res, "No burn permission")

  const waitAfterRevoke = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterRevoke.ok) throw new Error("Consensus wait failed after burn-from-owner after revoke")

  const afterRevokeAttempt = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  const burnAfterRevokeRejected =
    afterRevokeAttempt.supply === afterRevoke.supply && afterRevokeAttempt.balances[owner] === afterRevoke.balances[owner]

  // 7) Outsider grant attempt should be rejected.
  const outsiderGrant = await withDemosWallet({
    rpcUrl,
    mnemonic: outsiderMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== outsider) throw new Error(`outsider identity mismatch: ${fromHex} !== ${outsider}`)
      const nonce = Number(await demos.getAddressNonce(outsider)) + 1
      return await sendTokenGrantPermissionTxWithDemos({ demos, tokenAddress, grantee, permissions: [permission], nonce })
    },
  })
  assertRejected(outsiderGrant?.res, "No ACL modification permission")

  const crossNode = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 120),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_acl_burn_matrix`
  const summary = {
    runId: run.runId,
    scenario: "token_acl_burn_matrix",
    tokenAddress,
    rpcUrls: targets,
    permission,
    burnAmount: burnAmount.toString(),
    addresses: { owner, grantee, outsider },
    txs: {
      selfBurn,
      burnOtherNoPerm,
      grant,
      burnWithPerm,
      revoke,
      burnAfterRevoke,
      outsiderGrant,
    },
    snapshots: {
      before: { supply: before.supply.toString(), balances: Object.fromEntries(Object.entries(before.balances).map(([k, v]) => [k, v.toString()])), aclEntries: before.aclEntries },
      afterSelfBurn: { supply: afterSelfBurn.supply.toString(), balances: Object.fromEntries(Object.entries(afterSelfBurn.balances).map(([k, v]) => [k, v.toString()])), aclEntries: afterSelfBurn.aclEntries },
      afterNoPerm: { supply: afterNoPerm.supply.toString(), balances: Object.fromEntries(Object.entries(afterNoPerm.balances).map(([k, v]) => [k, v.toString()])), aclEntries: afterNoPerm.aclEntries },
      afterGrant: { supply: afterGrant.supply.toString(), balances: Object.fromEntries(Object.entries(afterGrant.balances).map(([k, v]) => [k, v.toString()])), aclEntries: afterGrant.aclEntries },
      afterWithPerm: { supply: afterWithPerm.supply.toString(), balances: Object.fromEntries(Object.entries(afterWithPerm.balances).map(([k, v]) => [k, v.toString()])), aclEntries: afterWithPerm.aclEntries },
      afterRevoke: { supply: afterRevoke.supply.toString(), balances: Object.fromEntries(Object.entries(afterRevoke.balances).map(([k, v]) => [k, v.toString()])), aclEntries: afterRevoke.aclEntries },
      afterRevokeAttempt: { supply: afterRevokeAttempt.supply.toString(), balances: Object.fromEntries(Object.entries(afterRevokeAttempt.balances).map(([k, v]) => [k, v.toString()])), aclEntries: afterRevokeAttempt.aclEntries },
    },
    assertions: {
      selfBurnApplied,
      unauthorizedBlocked,
      grantAccepted,
      grantVisible,
      burnWithPermAccepted,
      burnWithPermApplied,
      revokeAccepted,
      revokeVisible,
      burnAfterRevokeRejected,
    },
    crossNode,
    ok:
      selfBurnApplied &&
      unauthorizedBlocked &&
      grantAccepted &&
      grantVisible &&
      burnWithPermAccepted &&
      burnWithPermApplied &&
      revokeAccepted &&
      revokeVisible &&
      burnAfterRevokeRejected &&
      outsiderGrant?.res?.result !== 200 &&
      crossNode.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_acl_burn_matrix_summary: summary }, null, 2))

  if (!summary.ok) throw new Error("token_acl_burn_matrix failed assertions")
}

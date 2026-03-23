import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenBurnTxWithDemos,
  sendTokenGrantPermissionTxWithDemos,
  sendTokenMintTxWithDemos,
  sendTokenPauseTxWithDemos,
  sendTokenRevokePermissionTxWithDemos,
  sendTokenTransferOwnershipTxWithDemos,
  sendTokenUnpauseTxWithDemos,
  waitForCrossNodeTokenGetConsistency,
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

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)
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
  const owner = normalizeHexAddress(token?.response?.accessControl?.owner ?? "")
  const paused = !!token?.response?.accessControl?.paused
  const aclEntries = Array.isArray(token?.response?.accessControl?.entries) ? token.response.accessControl.entries : []

  const supply = parseBigintOrZero(token?.response?.state?.totalSupply)
  const balances: Record<string, bigint> = {}
  for (const a of addresses) {
    const bal = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    if (bal?.result !== 200) throw new Error(`token.getBalance failed: ${JSON.stringify(bal)}`)
    balances[a] = parseBigintOrZero(bal?.response?.balance)
  }

  return { owner, paused, aclEntries, supply, balances }
}

function getEntryPerms(aclEntries: any[], address: string): string[] {
  const addr = normalizeHexAddress(address)
  for (const entry of aclEntries ?? []) {
    if (normalizeHexAddress(entry?.address ?? "") !== addr) continue
    return Array.isArray(entry?.permissions) ? entry.permissions : []
  }
  return []
}

async function waitForSnapshotUntil(params: {
  rpcUrl: string
  tokenAddress: string
  addresses: string[]
  timeoutSec: number
  pollMs: number
  predicate: (s: Awaited<ReturnType<typeof snapshot>>) => boolean
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  let last = await snapshot(params.rpcUrl, params.tokenAddress, params.addresses)
  while (Date.now() < deadline) {
    attempts++
    last = await snapshot(params.rpcUrl, params.tokenAddress, params.addresses)
    if (params.predicate(last)) return { ok: true, attempts, snapshot: last }
    await sleep(Math.max(50, Math.floor(params.pollMs)))
  }
  return { ok: false, attempts, snapshot: last }
}

export async function runTokenAclMultiPermissionMatrix() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 4) throw new Error("token_acl_multi_permission_matrix requires at least 4 wallets (owner, grantee, outsider, target)")

  const ownerMnemonic = wallets[0]!
  const granteeMnemonic = wallets[1]!
  const outsiderMnemonic = wallets[2]!
  const targetMnemonic = wallets[3]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, granteeMnemonic, outsiderMnemonic, targetMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const grantee = walletAddresses[1]!
  const outsider = walletAddresses[2]!
  const target = walletAddresses[3]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const mintAmount = parseBigintOrZero(process.env.TOKEN_MINT_AMOUNT ?? "1")
  const burnAmount = parseBigintOrZero(process.env.TOKEN_BURN_AMOUNT ?? "1")
  const applyTimeoutSec = envInt("TOKEN_WAIT_APPLY_SEC", 120)

  const before = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider, target])
  if (before.owner !== owner) throw new Error(`Token owner mismatch: ${before.owner} !== ${owner}`)

  // A) Without permissions: grantee cannot mint-to-self, burn-from-owner, pause, modify ACL, or transfer ownership.
  const preMint = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenMintTxWithDemos({ demos, tokenAddress, to: grantee, amount: mintAmount, nonce })
    },
  })
  assertRejected(preMint?.res, "No mint permission")

  const preBurnOther = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: owner, amount: burnAmount, nonce })
    },
  })
  assertRejected(preBurnOther?.res, "No burn permission")

  const prePause = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenPauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })
  assertRejected(prePause?.res, "No pause permission")

  const preModifyAcl = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenGrantPermissionTxWithDemos({
        demos,
        tokenAddress,
        grantee: outsider,
        permissions: ["canMint"],
        nonce,
      })
    },
  })
  assertRejected(preModifyAcl?.res, "No ACL modification permission")

  const preTransferOwnership = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenTransferOwnershipTxWithDemos({ demos, tokenAddress, newOwner: target, nonce })
    },
  })
  assertRejected(preTransferOwnership?.res, "No ownership transfer permission")

  const waitPre = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitPre.ok) throw new Error("Consensus wait failed after pre-permission attempts")

  const afterPre = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider, target])
  const preStateUnchanged =
    afterPre.owner === before.owner &&
    afterPre.paused === before.paused &&
    afterPre.supply === before.supply &&
    afterPre.balances[grantee] === before.balances[grantee] &&
    afterPre.balances[owner] === before.balances[owner]

  // B) Owner grants multiple perms to grantee.
  const allPerms = ["canMint", "canBurn", "canPause", "canModifyACL", "canTransferOwnership"]
  const grantAll = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenGrantPermissionTxWithDemos({ demos, tokenAddress, grantee, permissions: allPerms, nonce })
    },
  })

  const waitGrant = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitGrant.ok) throw new Error("Consensus wait failed after grantAll")

  // C) Grantee can mint, burn-from-owner, pause/unpause, modify ACL, and transfer ownership.
  const afterGrantVisible = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider, target],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s => {
      const granteePerms = getEntryPerms(s.aclEntries, grantee)
      return allPerms.every(p => granteePerms.includes(p))
    },
  })
  const afterGrant = afterGrantVisible.snapshot
  const grantVisible = afterGrantVisible.ok

  const mintOk = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenMintTxWithDemos({ demos, tokenAddress, to: grantee, amount: mintAmount, nonce })
    },
  })

  const burnOk = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: owner, amount: burnAmount, nonce })
    },
  })

  const pauseOk = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenPauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })

  const waitPause = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitPause.ok) throw new Error("Consensus wait failed after pause")

  const pausedVisible = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider, target],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s => s.paused,
  })
  if (!pausedVisible.ok) throw new Error("Pause not visible in time")

  const unpauseOk = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenUnpauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })

  const waitUnpause = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitUnpause.ok) throw new Error("Consensus wait failed after unpause")

  const unpausedVisible = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider, target],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s => !s.paused,
  })
  if (!unpausedVisible.ok) throw new Error("Unpause not visible in time")

  const modifyAclOk = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenGrantPermissionTxWithDemos({
        demos,
        tokenAddress,
        grantee: outsider,
        permissions: ["canMint"],
        nonce,
      })
    },
  })

  const transferOwnershipOk = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenTransferOwnershipTxWithDemos({ demos, tokenAddress, newOwner: target, nonce })
    },
  })

  const waitPost = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 2),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 240),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitPost.ok) throw new Error("Consensus wait failed after post-grant operations")

  const afterOpsApplied = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider, target],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s =>
      s.owner === target &&
      s.balances[grantee] === afterGrant.balances[grantee] + mintAmount &&
      s.balances[owner] === afterGrant.balances[owner] - burnAmount &&
      !s.paused,
  })

  const afterOps = afterOpsApplied.snapshot
  const mintApplied = afterOpsApplied.ok && afterOps.balances[grantee] === afterGrant.balances[grantee] + mintAmount
  const burnApplied = afterOpsApplied.ok && afterOps.balances[owner] === afterGrant.balances[owner] - burnAmount
  const ownershipApplied = afterOpsApplied.ok && afterOps.owner === target

  // D) New owner revokes some permissions from the grantee (remove canModifyACL + canPause).
  const revokeSome = await withDemosWallet({
    rpcUrl,
    mnemonic: targetMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== target) throw new Error(`target identity mismatch: ${fromHex} !== ${target}`)
      const nonce = Number(await demos.getAddressNonce(target)) + 1
      return await sendTokenRevokePermissionTxWithDemos({
        demos,
        tokenAddress,
        grantee,
        permissions: ["canModifyACL", "canPause"],
        nonce,
      })
    },
  })

  const waitRevoke = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitRevoke.ok) throw new Error("Consensus wait failed after revokeSome")

  const afterRevokeVisible = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider, target],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s => {
      const permsAfterRevoke = getEntryPerms(s.aclEntries, grantee)
      return !permsAfterRevoke.includes("canModifyACL") && !permsAfterRevoke.includes("canPause")
    },
  })
  const afterRevoke = afterRevokeVisible.snapshot
  const revokeVisible = afterRevokeVisible.ok

  const pauseAfterRevoke = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenPauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })
  assertRejected(pauseAfterRevoke?.res, "No pause permission")

  const modifyAfterRevoke = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenGrantPermissionTxWithDemos({
        demos,
        tokenAddress,
        grantee: outsider,
        permissions: ["canBurn"],
        nonce,
      })
    },
  })
  assertRejected(modifyAfterRevoke?.res, "No ACL modification permission")

  const crossNodeTokenGet = await waitForCrossNodeTokenGetConsistency({
    rpcUrls: targets,
    tokenAddress,
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const crossNodeBalances = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: [owner, grantee, outsider, target],
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_acl_multi_permission_matrix`
  const summary = {
    runId: run.runId,
    scenario: "token_acl_multi_permission_matrix",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, grantee, outsider, target },
    permsGranted: allPerms,
    txs: {
      preMint,
      preBurnOther,
      prePause,
      preModifyAcl,
      preTransferOwnership,
      grantAll,
      mintOk,
      burnOk,
      pauseOk,
      unpauseOk,
      modifyAclOk,
      transferOwnershipOk,
      revokeSome,
      pauseAfterRevoke,
      modifyAfterRevoke,
    },
    snapshots: {
      before,
      afterPre,
      afterGrant,
      afterOps,
      afterRevoke,
    },
    assertions: {
      preStateUnchanged,
      grantVisible,
      mintApplied,
      burnApplied,
      ownershipApplied,
      revokeVisible,
      crossNodeTokenGetOk: crossNodeTokenGet.ok,
      crossNodeBalancesOk: crossNodeBalances.ok,
    },
    crossNodeTokenGet,
    crossNodeBalances,
    ok:
      preStateUnchanged &&
      grantVisible &&
      mintApplied &&
      burnApplied &&
      ownershipApplied &&
      revokeVisible &&
      crossNodeTokenGet.ok &&
      crossNodeBalances.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(stringifyJson({ token_acl_multi_permission_matrix_summary: summary }))

  if (!summary.ok) throw new Error("token_acl_multi_permission_matrix failed assertions")
}

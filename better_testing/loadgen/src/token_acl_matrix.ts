import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenGrantPermissionTxWithDemos,
  sendTokenMintTxWithDemos,
  sendTokenRevokePermissionTxWithDemos,
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"
import { getRunConfig, writeJson } from "./run_io"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

async function withWallet<T>(rpcUrl: string, mnemonic: string, fn: (demos: Demos, addressHex: string) => Promise<T>): Promise<T> {
  const demos = new Demos()
  await demos.connect(rpcUrl)
  await demos.connectWallet(mnemonic, { algorithm: "ed25519" })
  const identity = await demos.crypto.getIdentity("ed25519")
  const addressHex = normalizeHexAddress(uint8ArrayToHex(identity.publicKey))
  return await fn(demos, addressHex)
}

export async function runTokenAclMatrix() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_acl_matrix requires at least 3 wallets (owner, grantee, outsider)")

  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))

  const ownerMnemonic = wallets[0]!
  const granteeMnemonic = wallets[1]!
  const outsiderMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, granteeMnemonic, outsiderMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const grantee = walletAddresses[1]!
  const outsider = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const mintAmount = parseBigintOrZero(process.env.TOKEN_MINT_AMOUNT ?? "1")
  const permission = String(process.env.ACL_PERMISSION ?? "canMint")

  const tokenGet = await nodeCall(rpcUrl, "token.get", { tokenAddress }, "preflight:token.get")
  if (tokenGet?.result !== 200) throw new Error(`preflight token.get failed: ${JSON.stringify(tokenGet)}`)
  const tokenOwner = normalizeHexAddress(tokenGet?.response?.accessControl?.owner ?? "")

  if (tokenOwner !== owner) {
    throw new Error(
      `Token owner mismatch. token.get owner=${tokenOwner} expected owner=${owner}`,
    )
  }

  const before = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])

  // 1) Unauthorized mint by grantee (no permission yet) => should not change state after consensus.
  const attemptMintNoPerm = await withWallet(rpcUrl, granteeMnemonic, async (demos, fromHex) => {
    if (fromHex !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
    const nonce = Number(await demos.getAddressNonce(grantee)) + 1
    return await sendTokenMintTxWithDemos({
      demos,
      tokenAddress,
      to: grantee,
      amount: mintAmount,
      nonce,
    })
  })

  const wait1 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!wait1.ok) throw new Error("Consensus wait failed after unauthorized mint attempt")

  const afterNoPerm = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])

  const unauthorizedBlocked =
    afterNoPerm.supply === before.supply &&
    afterNoPerm.balances[grantee] === before.balances[grantee]

  // 2) Owner grants permission, then grantee mint => should change.
  const grant = await withWallet(rpcUrl, ownerMnemonic, async (demos, fromHex) => {
    if (fromHex !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
    const nonce = Number(await demos.getAddressNonce(owner)) + 1
    return await sendTokenGrantPermissionTxWithDemos({
      demos,
      tokenAddress,
      grantee,
      permissions: [permission],
      nonce,
    })
  })

  const grantAccepted = grant?.res?.result === 200

  const waitGrant = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitGrant.ok) throw new Error("Consensus wait failed after grantPermission")

  const afterGrant = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])

  const mintWithPerm = await withWallet(rpcUrl, granteeMnemonic, async (demos, fromHex) => {
    if (fromHex !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
    const nonce = Number(await demos.getAddressNonce(grantee)) + 1
    return await sendTokenMintTxWithDemos({
      demos,
      tokenAddress,
      to: grantee,
      amount: mintAmount,
      nonce,
    })
  })

  const mintWithPermAccepted = mintWithPerm?.res?.result === 200

  const waitMint = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitMint.ok) throw new Error("Consensus wait failed after mintWithPerm")

  const afterWithPerm = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  const mintApplied =
    afterWithPerm.supply === before.supply + mintAmount &&
    afterWithPerm.balances[grantee] === before.balances[grantee] + mintAmount

  // 3) Owner revokes permission, then grantee mint => should not change (beyond already applied mint).
  const revoke = await withWallet(rpcUrl, ownerMnemonic, async (demos, fromHex) => {
    if (fromHex !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
    const nonce = Number(await demos.getAddressNonce(owner)) + 1
    return await sendTokenRevokePermissionTxWithDemos({
      demos,
      tokenAddress,
      grantee,
      permissions: [permission],
      nonce,
    })
  })

  const revokeAccepted = revoke?.res?.result === 200

  const waitRevoke = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitRevoke.ok) throw new Error("Consensus wait failed after revokePermission")

  const afterRevoke = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  const revokeBlocked =
    afterRevoke.supply === afterWithPerm.supply &&
    afterRevoke.balances[grantee] === afterWithPerm.balances[grantee]

  const mintAfterRevoke = await withWallet(rpcUrl, granteeMnemonic, async (demos, fromHex) => {
    if (fromHex !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
    const nonce = Number(await demos.getAddressNonce(grantee)) + 1
    return await sendTokenMintTxWithDemos({
      demos,
      tokenAddress,
      to: grantee,
      amount: mintAmount,
      nonce,
    })
  })

  const mintAfterRevokeRejected = mintAfterRevoke?.res?.result !== 200

  // 4) Outsider attempts grantPermission => should not change ACL entries.
  const outsiderGrant = await withWallet(rpcUrl, outsiderMnemonic, async (demos, fromHex) => {
    if (fromHex !== outsider) throw new Error(`outsider identity mismatch: ${fromHex} !== ${outsider}`)
    const nonce = Number(await demos.getAddressNonce(outsider)) + 1
    return await sendTokenGrantPermissionTxWithDemos({
      demos,
      tokenAddress,
      grantee: outsider,
      permissions: [permission],
      nonce,
    })
  })

  const outsiderGrantRejected = outsiderGrant?.res?.result !== 200

  const wait4 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!wait4.ok) throw new Error("Consensus wait failed after outsider grant attempt")

  const afterOutsider = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  const outsiderAclBlocked = JSON.stringify(afterOutsider.aclEntries) === JSON.stringify(afterRevoke.aclEntries)

  const crossNode = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const ok =
    unauthorizedBlocked &&
    grantAccepted &&
    mintWithPermAccepted &&
    mintApplied &&
    revokeAccepted &&
    mintAfterRevokeRejected &&
    revokeBlocked &&
    outsiderGrantRejected &&
    outsiderAclBlocked &&
    crossNode.ok

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_acl_matrix`
  const summary = {
    runId: run.runId,
    scenario: "token_acl_matrix",
    tokenAddress,
    rpcUrls: targets,
    permission,
    mintAmount: mintAmount.toString(),
    addresses: { owner, grantee, outsider },
    identities: { tokenOwner },
    txs: {
      attemptMintNoPerm: attemptMintNoPerm?.res ?? null,
      grant: grant?.res ?? null,
      waitGrant,
      mintWithPerm: mintWithPerm?.res ?? null,
      waitMint,
      revoke: revoke?.res ?? null,
      waitRevoke,
      mintAfterRevoke: mintAfterRevoke?.res ?? null,
      outsiderGrant: outsiderGrant?.res ?? null,
    },
    snapshots: {
      before: {
        supply: before.supply.toString(),
        balances: Object.fromEntries(Object.entries(before.balances).map(([k, v]) => [k, v.toString()])),
        aclEntries: before.aclEntries,
      },
      afterNoPerm: {
        supply: afterNoPerm.supply.toString(),
        balances: Object.fromEntries(Object.entries(afterNoPerm.balances).map(([k, v]) => [k, v.toString()])),
        aclEntries: afterNoPerm.aclEntries,
      },
      afterGrant: {
        supply: afterGrant.supply.toString(),
        balances: Object.fromEntries(Object.entries(afterGrant.balances).map(([k, v]) => [k, v.toString()])),
        aclEntries: afterGrant.aclEntries,
      },
      afterWithPerm: {
        supply: afterWithPerm.supply.toString(),
        balances: Object.fromEntries(Object.entries(afterWithPerm.balances).map(([k, v]) => [k, v.toString()])),
        aclEntries: afterWithPerm.aclEntries,
      },
      afterRevoke: {
        supply: afterRevoke.supply.toString(),
        balances: Object.fromEntries(Object.entries(afterRevoke.balances).map(([k, v]) => [k, v.toString()])),
        aclEntries: afterRevoke.aclEntries,
      },
      afterOutsider: {
        supply: afterOutsider.supply.toString(),
        balances: Object.fromEntries(Object.entries(afterOutsider.balances).map(([k, v]) => [k, v.toString()])),
        aclEntries: afterOutsider.aclEntries,
      },
    },
    assertions: {
      unauthorizedBlocked,
      grantAccepted,
      mintWithPermAccepted,
      mintApplied,
      revokeAccepted,
      mintAfterRevokeRejected,
      revokeBlocked,
      outsiderGrantRejected,
      outsiderAclBlocked,
    },
    crossNode,
    ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_acl_matrix_summary: summary }, null, 2))

  if (!ok) throw new Error("token_acl_matrix failed (one or more assertions failed)")
}

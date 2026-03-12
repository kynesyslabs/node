import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenGrantPermissionTxWithDemos,
  sendTokenPauseTxWithDemos,
  sendTokenTransferOwnershipTxWithDemos,
  sendTokenUnpauseTxWithDemos,
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

async function snapshotOwnerPaused(rpcUrl: string, tokenAddress: string) {
  const token = await nodeCall(rpcUrl, "token.get", { tokenAddress }, `token.get:${tokenAddress}`)
  if (token?.result !== 200) throw new Error(`token.get failed: ${JSON.stringify(token)}`)
  return {
    owner: normalizeHexAddress(token?.response?.accessControl?.owner ?? ""),
    paused: !!token?.response?.accessControl?.paused,
  }
}

async function waitForOwnerPaused(params: {
  rpcUrl: string
  tokenAddress: string
  owner: string
  paused: boolean
  timeoutSec: number
  pollMs: number
  label: string
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempt = 0
  while (Date.now() < deadlineMs) {
    const snap = await snapshotOwnerPaused(params.rpcUrl, params.tokenAddress)
    if (snap.owner === normalizeHexAddress(params.owner) && snap.paused === params.paused) {
      return { ok: true, attempt, snapshot: snap }
    }
    attempt++
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }
  const last = await snapshotOwnerPaused(params.rpcUrl, params.tokenAddress)
  return { ok: false, attempt, snapshot: last, error: `Timeout waiting for ${params.label}` }
}

async function waitForCrossNodeOwnerPaused(params: {
  rpcUrls: string[]
  tokenAddress: string
  owner: string
  paused: boolean
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  const owner = normalizeHexAddress(params.owner)
  const rpcUrls = (params.rpcUrls ?? []).map(normalizeRpcUrl)

  while (Date.now() < deadlineMs) {
    attempts++
    const perNode: any[] = []
    let allOk = true
    for (const rpcUrl of rpcUrls) {
      try {
        const snap = await snapshotOwnerPaused(rpcUrl, params.tokenAddress)
        const ok = snap.owner === owner && snap.paused === params.paused
        perNode.push({ rpcUrl, ok, snapshot: snap })
        if (!ok) allOk = false
      } catch (error: any) {
        perNode.push({ rpcUrl, ok: false, snapshot: null, error: String(error?.message ?? error) })
        allOk = false
      }
    }
    if (allOk) return { ok: true, attempts, perNode }
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }

  const perNode: any[] = []
  for (const rpcUrl of rpcUrls) {
    try {
      const snap = await snapshotOwnerPaused(rpcUrl, params.tokenAddress)
      perNode.push({ rpcUrl, ok: snap.owner === owner && snap.paused === params.paused, snapshot: snap })
    } catch (error: any) {
      perNode.push({ rpcUrl, ok: false, snapshot: null, error: String(error?.message ?? error) })
    }
  }
  return { ok: false, attempts, perNode }
}

export async function runTokenAclTransferOwnershipMatrix() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_acl_transfer_ownership_matrix requires at least 3 wallets (owner, newOwner, outsider)")

  const ownerMnemonic = wallets[0]!
  const newOwnerMnemonic = wallets[1]!
  const outsiderMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, newOwnerMnemonic, outsiderMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const newOwner = walletAddresses[1]!
  const outsider = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const applyTimeoutSec = envInt("TOKEN_WAIT_APPLY_SEC", 120)
  const pollMs = envInt("TOKEN_APPLY_POLL_MS", 500)

  const before = await snapshotOwnerPaused(rpcUrl, tokenAddress)
  if (before.owner !== owner) throw new Error(`Token owner mismatch: ${before.owner} !== ${owner}`)

  // 1) Non-owner transferOwnership attempt should fail.
  const outsiderTransfer = await withDemosWallet({
    rpcUrl,
    mnemonic: outsiderMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== outsider) throw new Error(`outsider identity mismatch: ${fromHex} !== ${outsider}`)
      const nonce = Number(await demos.getAddressNonce(outsider)) + 1
      return await sendTokenTransferOwnershipTxWithDemos({ demos, tokenAddress, newOwner, nonce })
    },
  })
  assertRejected(outsiderTransfer?.res, "No ownership transfer permission")

  const waitOutsider = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitOutsider.ok) throw new Error("Consensus wait failed after outsider transferOwnership attempt")

  const afterOutsider = await snapshotOwnerPaused(rpcUrl, tokenAddress)
  const outsiderBlocked = afterOutsider.owner === owner

  // 2) Owner transfers ownership to newOwner.
  const transfer = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferOwnershipTxWithDemos({ demos, tokenAddress, newOwner, nonce })
    },
  })

  const waitTransfer = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitTransfer.ok) throw new Error("Consensus wait failed after owner transferOwnership")

  const newOwnerVisible = await waitForOwnerPaused({
    rpcUrl,
    tokenAddress,
    owner: newOwner,
    paused: false,
    timeoutSec: applyTimeoutSec,
    pollMs,
    label: "new owner visible (paused=false)",
  })
  if (!newOwnerVisible.ok) throw new Error(`New owner not visible in time: ${JSON.stringify(newOwnerVisible)}`)

  const afterTransferOwner = newOwnerVisible.snapshot
  const transferAccepted = transfer?.res?.result === 200

  // 3) Old owner should lose implicit permissions: pause + ACL modification should fail.
  const oldOwnerPause = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenPauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })
  assertRejected(oldOwnerPause?.res, "No pause permission")

  const oldOwnerGrant = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenGrantPermissionTxWithDemos({
        demos,
        tokenAddress,
        grantee: outsider,
        permissions: ["canMint"],
        nonce,
      })
    },
  })
  assertRejected(oldOwnerGrant?.res, "No ACL modification permission")

  // 4) New owner can pause/unpause (implicit canPause).
  const newOwnerPause = await withDemosWallet({
    rpcUrl,
    mnemonic: newOwnerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== newOwner) throw new Error(`newOwner identity mismatch: ${fromHex} !== ${newOwner}`)
      const nonce = Number(await demos.getAddressNonce(newOwner)) + 1
      return await sendTokenPauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })

  const waitPause = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitPause.ok) throw new Error("Consensus wait failed after newOwner pause")

  const pausedVisible = await waitForOwnerPaused({
    rpcUrl,
    tokenAddress,
    owner: newOwner,
    paused: true,
    timeoutSec: applyTimeoutSec,
    pollMs,
    label: "paused visible",
  })
  if (!pausedVisible.ok) throw new Error(`Pause not visible in time: ${JSON.stringify(pausedVisible)}`)

  const newOwnerUnpause = await withDemosWallet({
    rpcUrl,
    mnemonic: newOwnerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== newOwner) throw new Error(`newOwner identity mismatch: ${fromHex} !== ${newOwner}`)
      const nonce = Number(await demos.getAddressNonce(newOwner)) + 1
      return await sendTokenUnpauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })

  const waitUnpause = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitUnpause.ok) throw new Error("Consensus wait failed after newOwner unpause")

  const unpausedVisible = await waitForOwnerPaused({
    rpcUrl,
    tokenAddress,
    owner: newOwner,
    paused: false,
    timeoutSec: applyTimeoutSec,
    pollMs,
    label: "unpaused visible",
  })
  if (!unpausedVisible.ok) throw new Error(`Unpause not visible in time: ${JSON.stringify(unpausedVisible)}`)

  const crossNode = await waitForCrossNodeOwnerPaused({
    rpcUrls: targets,
    tokenAddress,
    owner: newOwner,
    paused: false,
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 120),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_acl_transfer_ownership_matrix`
  const summary = {
    runId: run.runId,
    scenario: "token_acl_transfer_ownership_matrix",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, newOwner, outsider },
    txs: {
      outsiderTransfer,
      transfer,
      oldOwnerPause,
      oldOwnerGrant,
      newOwnerPause,
      newOwnerUnpause,
    },
    snapshots: {
      before,
      afterOutsider,
      afterTransferOwner,
      pausedVisible: pausedVisible.snapshot,
      unpausedVisible: unpausedVisible.snapshot,
    },
    assertions: {
      outsiderBlocked,
      transferAccepted,
      oldOwnerPauseRejected: oldOwnerPause?.res?.result !== 200,
      oldOwnerGrantRejected: oldOwnerGrant?.res?.result !== 200,
      newOwnerPauseAccepted: newOwnerPause?.res?.result === 200,
      newOwnerUnpauseAccepted: newOwnerUnpause?.res?.result === 200,
      crossNodeOk: crossNode.ok,
    },
    crossNode,
    ok:
      outsiderBlocked &&
      transferAccepted &&
      oldOwnerPause?.res?.result !== 200 &&
      oldOwnerGrant?.res?.result !== 200 &&
      newOwnerPause?.res?.result === 200 &&
      newOwnerUnpause?.res?.result === 200 &&
      crossNode.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_acl_transfer_ownership_matrix_summary: summary }, null, 2))

  if (!summary.ok) throw new Error("token_acl_transfer_ownership_matrix failed assertions")
}


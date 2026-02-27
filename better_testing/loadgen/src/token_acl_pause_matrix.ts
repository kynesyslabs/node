import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenBurnTxWithDemos,
  sendTokenMintTxWithDemos,
  sendTokenPauseTxWithDemos,
  sendTokenTransferTxWithDemos,
  sendTokenUnpauseTxWithDemos,
  waitForCrossNodeTokenConsistency,
  withDemosWallet,
} from "./token_shared"
import { getRunConfig, writeJson } from "./run_io"

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
  const paused = !!token?.response?.accessControl?.paused

  const balances: Record<string, bigint> = {}
  for (const a of addresses) {
    const bal = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    if (bal?.result !== 200) throw new Error(`token.getBalance failed: ${JSON.stringify(bal)}`)
    balances[a] = parseBigintOrZero(bal?.response?.balance)
  }

  return { supply, paused, balances }
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

export async function runTokenAclPauseMatrix() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_acl_pause_matrix requires at least 3 wallets (owner, grantee, outsider)")

  const ownerMnemonic = wallets[0]!
  const granteeMnemonic = wallets[1]!
  const outsiderMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, granteeMnemonic, outsiderMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const grantee = walletAddresses[1]!
  const outsider = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const tokenGet = await nodeCall(rpcUrl, "token.get", { tokenAddress }, "preflight:token.get")
  if (tokenGet?.result !== 200) throw new Error(`preflight token.get failed: ${JSON.stringify(tokenGet)}`)
  const tokenOwner = normalizeHexAddress(tokenGet?.response?.accessControl?.owner ?? "")
  if (tokenOwner !== owner) throw new Error(`Token owner mismatch. token.get owner=${tokenOwner} expected owner=${owner}`)

  const amount = parseBigintOrZero(process.env.TOKEN_TRANSFER_AMOUNT ?? "1")
  const mintAmount = parseBigintOrZero(process.env.TOKEN_MINT_AMOUNT ?? "1")
  const burnAmount = parseBigintOrZero(process.env.TOKEN_BURN_AMOUNT ?? "1")
  const applyTimeoutSec = envInt("TOKEN_WAIT_APPLY_SEC", 120)
  const pollMs = envInt("TOKEN_APPLY_POLL_MS", 500)

  const before = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  if (before.paused) throw new Error("Token unexpectedly starts paused")

  // 1) Non-owner pause attempt should fail.
  const granteePause = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenPauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })
  assertRejected(granteePause?.res, "No pause permission")

  const waitNoPerm = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitNoPerm.ok) throw new Error("Consensus wait failed after unauthorized pause attempt")

  const afterNoPerm = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  const unauthorizedBlocked =
    afterNoPerm.paused === false &&
    afterNoPerm.supply === before.supply &&
    afterNoPerm.balances[owner] === before.balances[owner] &&
    afterNoPerm.balances[grantee] === before.balances[grantee]

  // 2) Owner pauses token.
  const pause = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
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

  const pausedCondition = await waitForCondition({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs,
    label: "paused == true",
    condition: s => s.paused === true,
  })
  if (!pausedCondition.ok) throw new Error(`Pause not visible in time: ${JSON.stringify(pausedCondition)}`)
  const afterPause = pausedCondition.snapshot

  const pauseAccepted = pause?.res?.result === 200

  // 3) While paused, transfers/mint/burn should be rejected.
  const pausedTransfer = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: grantee, amount, nonce })
    },
  })
  assertRejected(pausedTransfer?.res, "Token is paused")

  const pausedMint = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenMintTxWithDemos({ demos, tokenAddress, to: grantee, amount: mintAmount, nonce })
    },
  })
  assertRejected(pausedMint?.res, "Token is paused")

  const pausedBurn = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: grantee, amount: burnAmount, nonce })
    },
  })
  assertRejected(pausedBurn?.res, "Token is paused")

  const waitPausedAttempts = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitPausedAttempts.ok) throw new Error("Consensus wait failed after paused tx attempts")

  const afterPausedAttempts = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  const pausedBlocksWrites =
    afterPausedAttempts.paused === true &&
    afterPausedAttempts.supply === afterPause.supply &&
    afterPausedAttempts.balances[owner] === afterPause.balances[owner] &&
    afterPausedAttempts.balances[grantee] === afterPause.balances[grantee]

  // 4) Non-owner unpause attempt should fail.
  const outsiderUnpause = await withDemosWallet({
    rpcUrl,
    mnemonic: outsiderMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== outsider) throw new Error(`outsider identity mismatch: ${fromHex} !== ${outsider}`)
      const nonce = Number(await demos.getAddressNonce(outsider)) + 1
      return await sendTokenUnpauseTxWithDemos({ demos, tokenAddress, nonce })
    },
  })
  assertRejected(outsiderUnpause?.res, "No pause permission")

  // 5) Owner unpauses.
  const unpause = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
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

  const unpausedCondition = await waitForCondition({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs,
    label: "paused == false",
    condition: s => s.paused === false,
  })
  if (!unpausedCondition.ok) throw new Error(`Unpause not visible in time: ${JSON.stringify(unpausedCondition)}`)
  const afterUnpause = unpausedCondition.snapshot

  const unpauseAccepted = unpause?.res?.result === 200

  // 6) After unpause, a transfer should apply.
  const transfer = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: grantee, amount, nonce })
    },
  })

  const waitTransfer = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitTransfer.ok) throw new Error("Consensus wait failed after post-unpause transfer")

  const transferApplied = await waitForCondition({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs,
    label: "post-unpause transfer applied",
    condition: s =>
      s.paused === false &&
      s.supply === afterUnpause.supply &&
      s.balances[owner] === afterUnpause.balances[owner] - amount &&
      s.balances[grantee] === afterUnpause.balances[grantee] + amount,
  })
  if (!transferApplied.ok) throw new Error(`Post-unpause transfer not applied in time: ${JSON.stringify(transferApplied)}`)
  const afterTransfer = transferApplied.snapshot

  const crossNode = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 120),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_acl_pause_matrix`
  const summary = {
    runId: run.runId,
    scenario: "token_acl_pause_matrix",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, grantee, outsider },
    amounts: { transfer: amount.toString(), mint: mintAmount.toString(), burn: burnAmount.toString() },
    txs: {
      granteePause,
      pause,
      pausedTransfer,
      pausedMint,
      pausedBurn,
      outsiderUnpause,
      unpause,
      transfer,
    },
    snapshots: {
      before: { paused: before.paused, supply: before.supply.toString(), balances: Object.fromEntries(Object.entries(before.balances).map(([k, v]) => [k, v.toString()])) },
      afterNoPerm: { paused: afterNoPerm.paused, supply: afterNoPerm.supply.toString(), balances: Object.fromEntries(Object.entries(afterNoPerm.balances).map(([k, v]) => [k, v.toString()])) },
      afterPause: { paused: afterPause.paused, supply: afterPause.supply.toString(), balances: Object.fromEntries(Object.entries(afterPause.balances).map(([k, v]) => [k, v.toString()])) },
      afterPausedAttempts: { paused: afterPausedAttempts.paused, supply: afterPausedAttempts.supply.toString(), balances: Object.fromEntries(Object.entries(afterPausedAttempts.balances).map(([k, v]) => [k, v.toString()])) },
      afterUnpause: { paused: afterUnpause.paused, supply: afterUnpause.supply.toString(), balances: Object.fromEntries(Object.entries(afterUnpause.balances).map(([k, v]) => [k, v.toString()])) },
      afterTransfer: { paused: afterTransfer.paused, supply: afterTransfer.supply.toString(), balances: Object.fromEntries(Object.entries(afterTransfer.balances).map(([k, v]) => [k, v.toString()])) },
    },
    assertions: {
      unauthorizedBlocked,
      pauseAccepted,
      pausedBlocksWrites,
      unpauseAccepted,
      postUnpauseTransferAccepted: transfer?.res?.result === 200,
      crossNodeOk: crossNode.ok,
    },
    crossNode,
    ok:
      unauthorizedBlocked &&
      pauseAccepted &&
      pausedBlocksWrites &&
      unpauseAccepted &&
      transfer?.res?.result === 200 &&
      crossNode.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_acl_pause_matrix_summary: summary }, null, 2))

  if (!summary.ok) throw new Error("token_acl_pause_matrix failed assertions")
}


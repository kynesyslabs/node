import {
  buildSignedTokenTransferTxWithDemos,
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenMintTxWithDemos,
  sendTokenTransferTxWithDemos,
  sendTokenUpgradeScriptTxWithDemos,
  withDemosWallet,
} from "./token_shared"
import { createHash } from "crypto"
import { getRunConfig, writeJson } from "./run_io"
import { buildComplexPolicyScript } from "./token_script_complex_policy_shared"

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

function sortObjectDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortObjectDeep)
  if (!value || typeof value !== "object") return value
  const out: Record<string, any> = {}
  for (const key of Object.keys(value).sort()) out[key] = sortObjectDeep((value as any)[key])
  return out
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function stableHashJson(value: any): string {
  return sha256Hex(JSON.stringify(sortObjectDeep(value)))
}

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)
}

function parseBigintOrZero(value: any): bigint {
  try {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(value)
    return BigInt(String(value ?? "0"))
  } catch {
    return 0n
  }
}

function rejectHaystack(res: any): string {
  const pieces: string[] = []
  if (typeof res?.extra?.error === "string") pieces.push(res.extra.error)
  if (typeof res?.response === "string") pieces.push(res.response)
  if (res?.response === false) pieces.push("false")
  if (typeof res?.message === "string") pieces.push(res.message)
  if (typeof res?.response?.message === "string") pieces.push(res.response.message)
  return pieces.join(" ").toLowerCase()
}

function extractRejectSignature(res: any): string | null {
  const text = rejectHaystack(res)
  for (const k of ["vesting_locked", "denylist", "not_allowlisted", "quota", "amount_limit", "zero_amount"]) {
    if (text.includes(k)) return k
  }
  if (text.includes("rejected")) return "rejected"
  return null
}

function assertRejected(res: any, expectedMessageSubstring: string) {
  if (res?.result === 200) {
    throw new Error(`Expected rejection but got result=200: ${JSON.stringify(res)}`)
  }
  const text = rejectHaystack(res)
  if (!text.includes(expectedMessageSubstring.toLowerCase())) {
    throw new Error(`Expected error to include "${expectedMessageSubstring}" but got: ${JSON.stringify(res)}`)
  }
}

async function waitForConsensusRounds(params: { rpcUrls: string[]; rounds: number; timeoutSec: number; pollMs: number }) {
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const start: Record<string, number | null> = {}

  for (const rpcUrl of params.rpcUrls) {
    const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, `getLastBlockNumber:start:${rpcUrl}`)
    const raw = res?.response
    start[rpcUrl] = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : null
  }

  while (Date.now() < deadlineMs) {
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      const base = start[rpcUrl]
      const res = await nodeCall(rpcUrl, "getLastBlockNumber", {}, `getLastBlockNumber:poll:${rpcUrl}`)
      const raw = res?.response
      const current = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : null
      const ok = typeof base === "number" && typeof current === "number" && current >= base + params.rounds
      if (!ok) allOk = false
    }
    if (allOk) return { ok: true, start }
    await sleep(Math.max(100, Math.floor(params.pollMs)))
  }

  return { ok: false, start }
}

async function callView(rpcUrl: string, tokenAddress: string, method: string, args: any[]) {
  return await nodeCall(rpcUrl, "token.callView", { tokenAddress, method, args }, `token.callView:${method}`)
}

async function getBalance(rpcUrl: string, tokenAddress: string, address: string): Promise<bigint> {
  const res = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address }, `token.getBalance:${address}`)
  if (res?.result !== 200) throw new Error(`token.getBalance failed: ${JSON.stringify(res)}`)
  return parseBigintOrZero(res?.response?.balance)
}

async function broadcastSignedTxOnce(params: { rpcUrl: string; mnemonic: string; signedTx: any }) {
  return await withDemosWallet({
    rpcUrl: params.rpcUrl,
    mnemonic: params.mnemonic,
    fn: async (demos) => {
      const validity = await (demos as any).confirm(params.signedTx)
      const res = await (demos as any).broadcast(validity)
      return { validity, res }
    },
  })
}

async function broadcastSignedTransferOnAllNodes(params: {
  rpcUrls: string[]
  mnemonic: string
  signedTx: any
  expectedRejectSubstring?: string | null
}) {
  const perNode: Record<string, any> = {}
  for (const url of params.rpcUrls) {
    const out = await withDemosWallet({
      rpcUrl: url,
      mnemonic: params.mnemonic,
      fn: async (demos) => {
        const validity = await (demos as any).confirm(params.signedTx)
        const res = await (demos as any).broadcast(validity)
        return { validity, res }
      },
    })
    perNode[url] = out
  }

  if (params.expectedRejectSubstring) {
    const rejectSignatures = params.rpcUrls.map(url => ({ url, sig: extractRejectSignature(perNode[url]?.res) }))
    const deterministic =
      rejectSignatures.every(e => !!e.sig) && rejectSignatures.every(e => e.sig === rejectSignatures[0]!.sig)
    if (!deterministic) {
      throw new Error(`Non-deterministic reject across nodes: ${stringifyJson({ rejectSignatures, perNode })}`)
    }
    for (const url of params.rpcUrls) assertRejected(perNode[url]?.res, params.expectedRejectSubstring)
    return { ok: true, perNode, rejectSignatures }
  }

  return { ok: true, perNode, rejectSignatures: null }
}

export async function runTokenScriptComplexPolicyVestingLockup() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_script_complex_policy_vesting_lockup requires 3 wallets (owner, other, attacker)")
  const ownerMnemonic = wallets[0]!
  const otherMnemonic = wallets[1]!
  const attackerMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, otherMnemonic, attackerMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const other = walletAddresses[1]!
  const attacker = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  // Ensure "other" has enough balance to exercise lockup gates deterministically.
  const mintToOther = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenMintTxWithDemos({ demos, tokenAddress, to: other, amount: 10n, nonce })
    },
  })
  if ((mintToOther as any)?.res?.result !== 200) throw new Error(`Mint to other failed: ${JSON.stringify(mintToOther)}`)

  const commandBase = 9_300_000n
  const cmdUnlock2 = commandBase + 1n
  const cmdUnlock3 = commandBase + 2n
  const total = 5n

  const scriptCode = buildComplexPolicyScript({
    allowlist: [owner, other, attacker],
    denylist: [],
    quotaPerBucket: 0,
    bucketMs: 60_000,
    amountLimit: 100_000_000n,
    feeThreshold: 0n,
    feeFixed: 0n,
    feeSink: null,
    vesting: {
      schedules: {
        [other]: { total },
      },
    },
    debugCapture: true,
    dynamicPolicy: {
      admin: owner,
      commandBase,
      presets: {},
      vestingUnlocks: {
        "1": { address: other, addUnlocked: 2n },
        "2": { address: other, addUnlocked: 3n },
      },
    },
  })

  const upgrade = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenUpgradeScriptTxWithDemos({
        demos,
        tokenAddress,
        scriptCode,
        methodNames: ["ping", "getHookCounts", "getPolicy", "getSenderStats", "getVestingStatus", "getDebugCtx"],
        nonce,
      })
    },
  })

  const waitAfterUpgrade = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterUpgrade.ok) throw new Error("Consensus wait failed after upgradeScript")

  // Baseline: attacker transfers are unaffected by vesting schedule for "other".
  const attackerOkTransfer = await withDemosWallet({
    rpcUrl,
    mnemonic: attackerMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(attacker)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount: 1n, nonce })
    },
  })
  if ((attackerOkTransfer as any)?.res?.result !== 200) {
    throw new Error(`Expected attacker baseline ok transfer but got: ${JSON.stringify(attackerOkTransfer)}`)
  }

  const waitAfterAttackerOk = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterAttackerOk.ok) throw new Error("Consensus wait failed after attacker baseline ok transfer")

  // Capture script hook context shape (useful to explain why this scenario uses admin-controlled releases).
  const debugCtxPerNode: Record<string, any> = {}
  for (const url of targets) {
    const res = await callView(url, tokenAddress, "getDebugCtx", [])
    debugCtxPerNode[url] = res
  }

  // Branch 1: before any unlock, transfer from "other" should reject with vesting_locked.
  const preUnlockTx = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount: 1n, nonce })
    },
  })

  const preUnlockReject = await broadcastSignedTransferOnAllNodes({
    rpcUrls: targets,
    mnemonic: otherMnemonic,
    signedTx: (preUnlockTx as any).signedTx,
    expectedRejectSubstring: "vesting_locked",
  })

  async function sendAdminCommand(amount: bigint) {
    return await withDemosWallet({
      rpcUrl,
      mnemonic: ownerMnemonic,
      fn: async (demos) => {
        const nonce = Number(await demos.getAddressNonce(owner)) + 1
        return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount, nonce })
      },
    })
  }

  // Unlock 2 tokens for "other".
  const unlock2 = await sendAdminCommand(cmdUnlock2)
  if ((unlock2 as any)?.res?.result !== 200) throw new Error(`Unlock2 command failed: ${JSON.stringify(unlock2)}`)

  const waitAfterUnlock2 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterUnlock2.ok) throw new Error("Consensus wait failed after unlock2")

  // Branch 2: with unlocked=2, reject 3 and allow 1.
  const midRejectTx = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount: 3n, nonce })
    },
  })

  const midReject = await broadcastSignedTransferOnAllNodes({
    rpcUrls: targets,
    mnemonic: otherMnemonic,
    signedTx: (midRejectTx as any).signedTx,
    expectedRejectSubstring: "vesting_locked",
  })

  const midOkTx = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount: 1n, nonce })
    },
  })

  const midOkTransfer = await broadcastSignedTxOnce({ rpcUrl, mnemonic: otherMnemonic, signedTx: (midOkTx as any).signedTx })
  if ((midOkTransfer as any)?.res?.result !== 200) {
    throw new Error(`Expected mid ok transfer but got: ${JSON.stringify(midOkTransfer)}`)
  }

  const waitAfterMidOk = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterMidOk.ok) throw new Error("Consensus wait failed after mid ok transfer")

  // Unlock remaining 3 (total unlocked becomes 5).
  const unlock3 = await sendAdminCommand(cmdUnlock3)
  if ((unlock3 as any)?.res?.result !== 200) throw new Error(`Unlock3 command failed: ${JSON.stringify(unlock3)}`)

  const waitAfterUnlock3 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterUnlock3.ok) throw new Error("Consensus wait failed after unlock3")

  // Branch 3: total unlocked=5, spent=1. Reject 5, allow 4.
  const afterUnlockRejectTx = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount: 5n, nonce })
    },
  })

  const afterUnlockReject = await broadcastSignedTransferOnAllNodes({
    rpcUrls: targets,
    mnemonic: otherMnemonic,
    signedTx: (afterUnlockRejectTx as any).signedTx,
    expectedRejectSubstring: "vesting_locked",
  })

  const balancesBeforeFinal = {
    owner: await getBalance(rpcUrl, tokenAddress, owner),
    other: await getBalance(rpcUrl, tokenAddress, other),
  }

  const finalOkTx = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos) => {
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount: 4n, nonce })
    },
  })

  const finalOkTransfer = await broadcastSignedTxOnce({ rpcUrl, mnemonic: otherMnemonic, signedTx: (finalOkTx as any).signedTx })
  if ((finalOkTransfer as any)?.res?.result !== 200) {
    throw new Error(`Expected final ok transfer but got: ${JSON.stringify(finalOkTransfer)}`)
  }

  const waitAfterFinal = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterFinal.ok) throw new Error("Consensus wait failed after final ok transfer")

  const balancesAfterFinal = {
    owner: await getBalance(rpcUrl, tokenAddress, owner),
    other: await getBalance(rpcUrl, tokenAddress, other),
  }

  const ownerDelta = balancesAfterFinal.owner - balancesBeforeFinal.owner
  const otherDelta = balancesBeforeFinal.other - balancesAfterFinal.other
  if (ownerDelta !== 4n || otherDelta !== 4n) {
    throw new Error(
      `Expected final transfer to move 4 tokens but got deltas: ${stringifyJson({
        ownerDelta: ownerDelta.toString(),
        otherDelta: otherDelta.toString(),
        balancesBeforeFinal: {
          owner: balancesBeforeFinal.owner.toString(),
          other: balancesBeforeFinal.other.toString(),
        },
        balancesAfterFinal: {
          owner: balancesAfterFinal.owner.toString(),
          other: balancesAfterFinal.other.toString(),
        },
      })}`,
    )
  }

  // Verify vesting status view is deterministic across nodes and reflects unlocked>=5 and spent=5.
  const vestingPerNode: Record<string, any> = {}
  const vestingHashPerNode: Record<string, string> = {}
  for (const url of targets) {
    const res = await callView(url, tokenAddress, "getVestingStatus", [other])
    vestingPerNode[url] = res
    if (res?.result !== 200) throw new Error(`getVestingStatus failed on ${url}: ${JSON.stringify(res)}`)
    vestingHashPerNode[url] = stableHashJson(res?.response?.value ?? null)
    const spent = parseBigintOrZero(res?.response?.value?.spent)
    if (spent !== 5n) throw new Error(`Expected vesting spent=5 but got ${spent.toString()} on ${url}: ${JSON.stringify(res)}`)
    const unlocked = parseBigintOrZero(res?.response?.value?.unlocked)
    if (unlocked < 5n) throw new Error(`Expected vesting unlocked>=5 but got ${unlocked.toString()} on ${url}: ${JSON.stringify(res)}`)
  }
  const first = targets[0]!
  for (const url of targets) {
    if (vestingHashPerNode[url] !== vestingHashPerNode[first]) {
      throw new Error(`Non-deterministic getVestingStatus across nodes: ${stringifyJson({ vestingHashPerNode, vestingPerNode })}`)
    }
  }

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_complex_policy_vesting_lockup`
  const summary = {
    runId: run.runId,
    scenario: "token_script_complex_policy_vesting_lockup",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, other, attacker },
    vesting: {
      total: total.toString(),
      commandBase: commandBase.toString(),
      cmdUnlock2: cmdUnlock2.toString(),
      cmdUnlock3: cmdUnlock3.toString(),
    },
    txs: { mintToOther, upgrade, attackerOkTransfer, unlock2, unlock3, midOkTransfer, finalOkTransfer },
    rejects: { preUnlockReject, midReject, afterUnlockReject },
    balances: {
      beforeFinal: { owner: balancesBeforeFinal.owner.toString(), other: balancesBeforeFinal.other.toString() },
      afterFinal: { owner: balancesAfterFinal.owner.toString(), other: balancesAfterFinal.other.toString() },
    },
    debugCtxPerNode,
    vestingHashPerNode,
    ok: true,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_script_complex_policy_vesting_lockup_summary: summary }, null, 2))
}

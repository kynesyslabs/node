import {
  buildSignedTokenTransferTxWithDemos,
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenTransferTxWithDemos,
  sendTokenUpgradeScriptTxWithDemos,
  withDemosWallet,
} from "./token_shared"
import { createHash } from "crypto"
import { getRunConfig, writeJson } from "./framework/io"
import { buildComplexPolicyScript } from "./token_script_complex_policy_shared"

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
  for (const k of [
    "escrow_no_entry",
    "escrow_missing_entry",
    "escrow_no_beneficiary",
    "vesting_locked",
    "denylist",
    "not_allowlisted",
    "quota",
    "amount_limit",
    "zero_amount",
  ]) {
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

async function tokenGetCommittedWithFallback(rpcUrl: string, tokenAddress: string): Promise<any> {
  const committed = await nodeCall(
    rpcUrl,
    "token.getCommitted",
    { tokenAddress },
    `token.getCommitted:escrow:${rpcUrl.replace(/[^a-z0-9]+/gi, "_")}`,
  )
  if (committed?.result === 409) {
    return await nodeCall(
      rpcUrl,
      "token.get",
      { tokenAddress },
      `token.get:fallback:escrow:${rpcUrl.replace(/[^a-z0-9]+/gi, "_")}`,
    )
  }
  return committed
}

async function callView(rpcUrl: string, tokenAddress: string, method: string, args: any[]) {
  return await nodeCall(rpcUrl, "token.callView", { tokenAddress, method, args }, `token.callView:${method}`)
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

export async function runTokenScriptComplexPolicyEscrowStateMachine() {
  maybeSilenceConsole()

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_complex_policy_escrow_state_machine`

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_script_complex_policy_escrow_state_machine requires 3 wallets (owner, other, vault)")
  const ownerMnemonic = wallets[0]!
  const otherMnemonic = wallets[1]!
  const vaultMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, otherMnemonic, vaultMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const other = walletAddresses[1]!
  const vault = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const commandBase = 1000n
  const scriptCode = buildComplexPolicyScript({
    allowlist: [],
    denylist: [],
    quotaPerBucket: 0,
    bucketMs: 60_000,
    amountLimit: 1_000_000n,
    feeThreshold: 1_000_000n,
    feeFixed: 0n,
    feeSink: null,
    escrow: { vault },
    dynamicPolicy: {
      admin: owner,
      commandBase,
      presets: {},
      vestingUnlocks: {},
      escrowCmds: {
        "1": { type: "setBeneficiary", id: 1, beneficiary: owner },
        "2": { type: "approveRelease", id: 1 },
        "3": { type: "approveRefund", id: 2 },
      },
    },
  })

  const upgrade = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenUpgradeScriptTxWithDemos({
        demos,
        tokenAddress,
        scriptCode,
        methodNames: [],
        nonce,
      })
    },
  })
  if ((upgrade as any)?.res?.result !== 200) throw new Error(`Upgrade failed: ${JSON.stringify(upgrade)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const deposit1 = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== other) throw new Error(`other identity mismatch: ${fromHex} !== ${other}`)
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: vault,
        amount: 5n,
        nonce,
      })
    },
  })
  if ((deposit1 as any)?.res?.result !== 200) throw new Error(`Deposit1 failed: ${JSON.stringify(deposit1)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const cmdSetBeneficiary = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: owner,
        amount: commandBase + 1n,
        nonce,
      })
    },
  })
  if ((cmdSetBeneficiary as any)?.res?.result !== 200) throw new Error(`cmdSetBeneficiary failed: ${JSON.stringify(cmdSetBeneficiary)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const cmdApproveRelease = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: owner,
        amount: commandBase + 2n,
        nonce,
      })
    },
  })
  if ((cmdApproveRelease as any)?.res?.result !== 200) throw new Error(`cmdApproveRelease failed: ${JSON.stringify(cmdApproveRelease)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const signedRejectOut = await withDemosWallet({
    rpcUrl,
    mnemonic: vaultMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== vault) throw new Error(`vault identity mismatch: ${fromHex} !== ${vault}`)
      const nonce = Number(await demos.getAddressNonce(vault)) + 1
      return await buildSignedTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: owner,
        amount: 6n,
        nonce,
      })
    },
  })

  const rejectPerNode: Record<string, any> = {}
  for (const url of targets) {
    rejectPerNode[url] = await broadcastSignedTxOnce({
      rpcUrl: url,
      mnemonic: vaultMnemonic,
      signedTx: (signedRejectOut as any).signedTx,
    })
  }
  const rejectSignatures = targets.map(url => ({ url, sig: extractRejectSignature(rejectPerNode[url]?.res) }))
  const deterministic = rejectSignatures.every(e => !!e.sig) && rejectSignatures.every(e => e.sig === rejectSignatures[0]!.sig)
  if (!deterministic) {
    throw new Error(`Non-deterministic escrow reject across nodes: ${stringifyJson({ rejectSignatures, rejectPerNode })}`)
  }
  for (const url of targets) assertRejected(rejectPerNode[url]?.res, "escrow_no_entry")

  const release1 = await withDemosWallet({
    rpcUrl,
    mnemonic: vaultMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== vault) throw new Error(`vault identity mismatch: ${fromHex} !== ${vault}`)
      const nonce = Number(await demos.getAddressNonce(vault)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: owner,
        amount: 3n,
        nonce,
      })
    },
  })
  if ((release1 as any)?.res?.result !== 200) throw new Error(`Release1 failed: ${JSON.stringify(release1)}`)

  const release2 = await withDemosWallet({
    rpcUrl,
    mnemonic: vaultMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== vault) throw new Error(`vault identity mismatch: ${fromHex} !== ${vault}`)
      const nonce = Number(await demos.getAddressNonce(vault)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: owner,
        amount: 2n,
        nonce,
      })
    },
  })
  if ((release2 as any)?.res?.result !== 200) throw new Error(`Release2 failed: ${JSON.stringify(release2)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const entry1PerNode: Record<string, any> = {}
  for (const url of targets) {
    const res = await callView(url, tokenAddress, "getEscrowEntry", [1])
    if (res?.result !== 200) throw new Error(`getEscrowEntry(1) failed on ${url}: ${JSON.stringify(res)}`)
    entry1PerNode[url] = res?.response?.value
  }

  const entry1HashPerNode = Object.fromEntries(Object.entries(entry1PerNode).map(([k, v]) => [k, stableHashJson(v)]))
  const entry1Hashes = Object.values(entry1HashPerNode)
  if (!entry1Hashes.every(h => h === entry1Hashes[0])) {
    throw new Error(`Non-deterministic escrow entry#1 across nodes: ${stringifyJson({ entry1HashPerNode, entry1PerNode })}`)
  }

  const entry1 = entry1PerNode[targets[0]!]!
  if (String(entry1?.status) !== "claimed") {
    throw new Error(`Expected entry#1 status=claimed, got: ${stringifyJson(entry1)}`)
  }
  if (parseBigintOrZero(entry1?.released) !== 5n) {
    throw new Error(`Expected entry#1 released=5, got: ${stringifyJson(entry1)}`)
  }

  const deposit2 = await withDemosWallet({
    rpcUrl,
    mnemonic: otherMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== other) throw new Error(`other identity mismatch: ${fromHex} !== ${other}`)
      const nonce = Number(await demos.getAddressNonce(other)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: vault,
        amount: 4n,
        nonce,
      })
    },
  })
  if ((deposit2 as any)?.res?.result !== 200) throw new Error(`Deposit2 failed: ${JSON.stringify(deposit2)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const cmdApproveRefund = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: owner,
        amount: commandBase + 3n,
        nonce,
      })
    },
  })
  if ((cmdApproveRefund as any)?.res?.result !== 200) throw new Error(`cmdApproveRefund failed: ${JSON.stringify(cmdApproveRefund)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const refund = await withDemosWallet({
    rpcUrl,
    mnemonic: vaultMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== vault) throw new Error(`vault identity mismatch: ${fromHex} !== ${vault}`)
      const nonce = Number(await demos.getAddressNonce(vault)) + 1
      return await sendTokenTransferTxWithDemos({
        demos,
        tokenAddress,
        to: other,
        amount: 4n,
        nonce,
      })
    },
  })
  if ((refund as any)?.res?.result !== 200) throw new Error(`Refund failed: ${JSON.stringify(refund)}`)

  await waitForConsensusRounds({ rpcUrls: targets, rounds: 2, timeoutSec: 60, pollMs: 1000 })

  const entry2PerNode: Record<string, any> = {}
  for (const url of targets) {
    const res = await callView(url, tokenAddress, "getEscrowEntry", [2])
    if (res?.result !== 200) throw new Error(`getEscrowEntry(2) failed on ${url}: ${JSON.stringify(res)}`)
    entry2PerNode[url] = res?.response?.value
  }
  const entry2HashPerNode = Object.fromEntries(Object.entries(entry2PerNode).map(([k, v]) => [k, stableHashJson(v)]))
  const entry2Hashes = Object.values(entry2HashPerNode)
  if (!entry2Hashes.every(h => h === entry2Hashes[0])) {
    throw new Error(`Non-deterministic escrow entry#2 across nodes: ${stringifyJson({ entry2HashPerNode, entry2PerNode })}`)
  }
  const entry2 = entry2PerNode[targets[0]!]!
  if (String(entry2?.status) !== "refunded") {
    throw new Error(`Expected entry#2 status=refunded, got: ${stringifyJson(entry2)}`)
  }

  const committedPerNode: Record<string, any> = {}
  for (const url of targets) {
    const res = await tokenGetCommittedWithFallback(url, tokenAddress)
    if (res?.result !== 200) throw new Error(`token.getCommitted failed on ${url}: ${JSON.stringify(res)}`)
    committedPerNode[url] = res?.response
  }
  const committedHashes = Object.fromEntries(Object.entries(committedPerNode).map(([k, v]) => [k, stableHashJson(v)]))
  const values = Object.values(committedHashes)
  if (!values.every(h => h === values[0])) {
    throw new Error(`Non-deterministic committed token state across nodes: ${stringifyJson({ committedHashes })}`)
  }

  const summary = {
    runId: run.runId,
    scenario: "token_script_complex_policy_escrow_state_machine",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, other, vault },
    txs: {
      upgrade,
      deposit1,
      cmdSetBeneficiary,
      cmdApproveRelease,
      rejectSignatures,
      release1,
      release2,
      deposit2,
      cmdApproveRefund,
      refund,
    },
    escrow: {
      entry1,
      entry2,
    },
    committedHash: values[0],
    ok: true,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_script_complex_policy_escrow_state_machine_summary: summary }, null, 2))
}

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
import { logNonCriticalErrorOnce } from "./framework/common"
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
  for (const k of ["denylist", "not_allowlisted", "quota", "amount_limit", "zero_amount"]) {
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

function parseBigintOrZero(value: any): bigint {
  try {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(value)
    if (typeof value === "string") return BigInt(value)
  } catch (error) {
    logNonCriticalErrorOnce("token_script_complex_policy_dynamic_updates.parseBigintOrZero", "token_script_complex_policy_dynamic_updates.parseBigintOrZero", error, { value })
  }
  return 0n
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

async function tokenGetCommittedWithFallback(rpcUrl: string, tokenAddress: string): Promise<any> {
  const committed = await nodeCall(
    rpcUrl,
    "token.getCommitted",
    { tokenAddress },
    `token.getCommitted:dyn_policy:${rpcUrl.replace(/[^a-z0-9]+/gi, "_")}`,
  )
  if (committed?.result === 409) {
    return await nodeCall(
      rpcUrl,
      "token.get",
      { tokenAddress },
      `token.get:fallback:dyn_policy:${rpcUrl.replace(/[^a-z0-9]+/gi, "_")}`,
    )
  }
  return committed
}

function assertPolicyHas(value: any, expect: { denyHas?: string; allowHas?: string; allowMissing?: string; quotaPerBucket?: number }) {
  const policy = value?.policy
  if (!policy) throw new Error(`getPolicy missing policy: ${JSON.stringify(value)}`)
  if (expect.denyHas) {
    const deny = Array.isArray(policy.denylist) ? policy.denylist.map(normalizeHexAddress) : []
    if (!deny.includes(normalizeHexAddress(expect.denyHas))) {
      throw new Error(`Expected denylist to include ${expect.denyHas} but got: ${JSON.stringify(policy.denylist)}`)
    }
  }
  if (expect.allowHas) {
    const allow = Array.isArray(policy.allowlist) ? policy.allowlist.map(normalizeHexAddress) : []
    if (!allow.includes(normalizeHexAddress(expect.allowHas))) {
      throw new Error(`Expected allowlist to include ${expect.allowHas} but got: ${JSON.stringify(policy.allowlist)}`)
    }
  }
  if (expect.allowMissing) {
    const allow = Array.isArray(policy.allowlist) ? policy.allowlist.map(normalizeHexAddress) : []
    if (allow.includes(normalizeHexAddress(expect.allowMissing))) {
      throw new Error(`Expected allowlist to NOT include ${expect.allowMissing} but got: ${JSON.stringify(policy.allowlist)}`)
    }
  }
  if (typeof expect.quotaPerBucket === "number") {
    const quota = Number(policy.quotaPerBucket ?? 0)
    if (quota !== expect.quotaPerBucket) {
      throw new Error(`Expected quotaPerBucket=${expect.quotaPerBucket} but got ${quota}: ${JSON.stringify(policy)}`)
    }
  }
}

export async function runTokenScriptComplexPolicyDynamicUpdates() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_script_complex_policy_dynamic_updates requires 3 wallets (owner, other, attacker)")
  const ownerMnemonic = wallets[0]!
  const otherMnemonic = wallets[1]!
  const attackerMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, otherMnemonic, attackerMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const other = walletAddresses[1]!
  const attacker = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const commandBase = 9_000_000n
  const cmdDenyAttacker = commandBase + 1n
  const cmdClearDeny = commandBase + 2n
  const cmdAllowNoAttacker = commandBase + 3n
  const cmdAllowWithAttacker = commandBase + 4n
  const cmdQuota1 = commandBase + 5n
  const cmdQuota3 = commandBase + 6n

  const scriptCode = buildComplexPolicyScript({
    allowlist: [owner, other, attacker],
    denylist: [],
    quotaPerBucket: 3,
    bucketMs: 60_000,
    amountLimit: 20_000_000n,
    feeThreshold: 10n,
    feeFixed: 1n,
    feeSink: owner,
    dynamicPolicy: {
      admin: owner,
      commandBase,
      presets: {
        "1": { denylist: [attacker] },
        "2": { denylist: [] },
        "3": { allowlist: [owner, other] },
        "4": { allowlist: [owner, other, attacker] },
        "5": { quotaPerBucket: 1 },
        "6": { quotaPerBucket: 3 },
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
        methodNames: ["ping", "getHookCounts", "getPolicy", "getSenderStats"],
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

  // Baseline: attacker transfer should be OK (allowlisted, not denied).
  const attackerOk1 = await withDemosWallet({
    rpcUrl,
    mnemonic: attackerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== attacker) throw new Error(`attacker identity mismatch: ${fromHex} !== ${attacker}`)
      const nonce = Number(await demos.getAddressNonce(attacker)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: 1n, nonce })
    },
  })
  if ((attackerOk1 as any)?.res?.result !== 200) throw new Error(`Expected attacker ok transfer but got: ${JSON.stringify(attackerOk1)}`)

  const waitAfterBaseline = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterBaseline.ok) throw new Error("Consensus wait failed after baseline transfer")

  async function sendAdminCommand(amount: bigint) {
    return await withDemosWallet({
      rpcUrl,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
        const nonce = Number(await demos.getAddressNonce(owner)) + 1
        return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount, nonce })
      },
    })
  }

  async function assertPolicyDeterministic(expect: Parameters<typeof assertPolicyHas>[1]) {
    const perNode: Record<string, any> = {}
    const policyHashPerNode: Record<string, string> = {}
    const storageHashPerNode: Record<string, string> = {}
    for (const url of targets) {
      const policyRes = await callView(url, tokenAddress, "getPolicy", [])
      perNode[url] = policyRes
      if (policyRes?.result !== 200) throw new Error(`getPolicy failed on ${url}: ${JSON.stringify(policyRes)}`)
      const value = policyRes?.response?.value
      assertPolicyHas(value, expect)
      policyHashPerNode[url] = stableHashJson(value?.policy ?? null)
      storageHashPerNode[url] = stableHashJson(value?.storage ?? null)
    }

    const first = targets[0]!
    for (const url of targets) {
      if (policyHashPerNode[url] !== policyHashPerNode[first]) {
        throw new Error(`Non-deterministic policy across nodes: ${stringifyJson({ policyHashPerNode, perNode })}`)
      }
      if (storageHashPerNode[url] !== storageHashPerNode[first]) {
        throw new Error(`Non-deterministic storage across nodes: ${stringifyJson({ storageHashPerNode, perNode })}`)
      }
    }

    return { perNode, policyHashPerNode, storageHashPerNode }
  }

  // 1) Deny attacker via admin command.
  const cmd1 = await sendAdminCommand(cmdDenyAttacker)
  if ((cmd1 as any)?.res?.result !== 200) throw new Error(`Expected admin cmd1 applied: ${JSON.stringify(cmd1)}`)

  const waitAfterCmd1 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterCmd1.ok) throw new Error("Consensus wait failed after cmd1")

  const polAfterCmd1 = await assertPolicyDeterministic({ denyHas: attacker })

  // Attacker transfer should now reject on all nodes.
  const invalidTx = await withDemosWallet({
    rpcUrl,
    mnemonic: attackerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== attacker) throw new Error(`attacker identity mismatch: ${fromHex} !== ${attacker}`)
      const nonce = Number(await demos.getAddressNonce(attacker)) + 1
      const timestamp = Date.now()
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: 1n, nonce, timestamp })
    },
  })

  const rejectPerNode: Record<string, any> = {}
  for (const url of targets) {
    const out = await withDemosWallet({
      rpcUrl: url,
      mnemonic: attackerMnemonic,
      fn: async (demos, fromHex) => {
        if (normalizeHexAddress(fromHex) !== attacker) throw new Error(`attacker identity mismatch: ${fromHex} !== ${attacker}`)
        const validity = await (demos as any).confirm(invalidTx.signedTx)
        const res = await (demos as any).broadcast(validity)
        return { validity, res }
      },
    })
    rejectPerNode[url] = out
  }

  const rejectSignatures = targets.map(url => ({ url, sig: extractRejectSignature(rejectPerNode[url]?.res) }))
  const rejectDeterministic =
    rejectSignatures.every(e => !!e.sig) && rejectSignatures.every(e => e.sig === rejectSignatures[0]!.sig)
  if (!rejectDeterministic) {
    throw new Error(`Non-deterministic reject across nodes: ${stringifyJson({ rejectSignatures, rejectPerNode })}`)
  }
  for (const url of targets) assertRejected(rejectPerNode[url]?.res, "denylist")

  // 2) Clear denylist; attacker becomes OK again.
  const cmd2 = await sendAdminCommand(cmdClearDeny)
  if ((cmd2 as any)?.res?.result !== 200) throw new Error(`Expected admin cmd2 applied: ${JSON.stringify(cmd2)}`)

  const waitAfterCmd2 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterCmd2.ok) throw new Error("Consensus wait failed after cmd2")

  const polAfterCmd2 = await assertPolicyDeterministic({ allowHas: attacker })

  const attackerOk2 = await withDemosWallet({
    rpcUrl,
    mnemonic: attackerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== attacker) throw new Error(`attacker identity mismatch: ${fromHex} !== ${attacker}`)
      const nonce = Number(await demos.getAddressNonce(attacker)) + 1
      return await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: 1n, nonce })
    },
  })
  if ((attackerOk2 as any)?.res?.result !== 200) throw new Error(`Expected attacker ok transfer after clear deny but got: ${JSON.stringify(attackerOk2)}`)

  const waitAfterOk2 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterOk2.ok) throw new Error("Consensus wait failed after attacker ok2")

  // 3) Remove attacker from allowlist; should reject not_allowlisted.
  const cmd3 = await sendAdminCommand(cmdAllowNoAttacker)
  if ((cmd3 as any)?.res?.result !== 200) throw new Error(`Expected admin cmd3 applied: ${JSON.stringify(cmd3)}`)

  const waitAfterCmd3 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterCmd3.ok) throw new Error("Consensus wait failed after cmd3")

  const polAfterCmd3 = await assertPolicyDeterministic({ allowMissing: attacker })

  const invalidTx2 = await withDemosWallet({
    rpcUrl,
    mnemonic: attackerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== attacker) throw new Error(`attacker identity mismatch: ${fromHex} !== ${attacker}`)
      const nonce = Number(await demos.getAddressNonce(attacker)) + 1
      const timestamp = Date.now()
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: 1n, nonce, timestamp })
    },
  })

  const rejectPerNode2: Record<string, any> = {}
  for (const url of targets) {
    const out = await withDemosWallet({
      rpcUrl: url,
      mnemonic: attackerMnemonic,
      fn: async (demos, fromHex) => {
        if (normalizeHexAddress(fromHex) !== attacker) throw new Error(`attacker identity mismatch: ${fromHex} !== ${attacker}`)
        const validity = await (demos as any).confirm(invalidTx2.signedTx)
        const res = await (demos as any).broadcast(validity)
        return { validity, res }
      },
    })
    rejectPerNode2[url] = out
  }
  for (const url of targets) assertRejected(rejectPerNode2[url]?.res, "not_allowlisted")

  // 4) Add attacker back to allowlist.
  const cmd4 = await sendAdminCommand(cmdAllowWithAttacker)
  if ((cmd4 as any)?.res?.result !== 200) throw new Error(`Expected admin cmd4 applied: ${JSON.stringify(cmd4)}`)

  const waitAfterCmd4 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterCmd4.ok) throw new Error("Consensus wait failed after cmd4")

  const polAfterCmd4 = await assertPolicyDeterministic({ allowHas: attacker })

  // 5) Update quota to 1 and verify only 1/3 applies (same bucket, sequential nonces).
  const cmd5 = await sendAdminCommand(cmdQuota1)
  if ((cmd5 as any)?.res?.result !== 200) throw new Error(`Expected admin cmd5 applied: ${JSON.stringify(cmd5)}`)

  const waitAfterCmd5 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterCmd5.ok) throw new Error("Consensus wait failed after cmd5")

  const polAfterCmd5 = await assertPolicyDeterministic({ quotaPerBucket: 1 })

  const quotaBefore = {
    owner: await getBalance(rpcUrl, tokenAddress, owner),
    other: await getBalance(rpcUrl, tokenAddress, other),
  }

  const quotaTimestamp = Date.now()
  const quotaResults: any[] = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const baseNonce = Number(await demos.getAddressNonce(owner))
      const out: any[] = []
      for (let i = 0; i < 3; i++) {
        const nonce = baseNonce + 1 + i
        const tx = await buildSignedTokenTransferTxWithDemos({
          demos,
          tokenAddress,
          to: other,
          amount: 1n,
          nonce,
          timestamp: quotaTimestamp,
        })
        const validity = await (demos as any).confirm(tx.signedTx)
        const res = await (demos as any).broadcast(validity)
        out.push({ tx, validity, out: res })
      }
      return out
    },
  })

  const waitAfterQuota = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterQuota.ok) throw new Error("Consensus wait failed after quota burst")

  const quotaAfter = {
    owner: await getBalance(rpcUrl, tokenAddress, owner),
    other: await getBalance(rpcUrl, tokenAddress, other),
  }

  const ownerDelta = quotaBefore.owner - quotaAfter.owner
  const otherDelta = quotaAfter.other - quotaBefore.other
  if (ownerDelta !== 1n || otherDelta !== 1n) {
    throw new Error(
      `Expected quota=1 to apply only 1/3 transfers but got deltas: ${stringifyJson({
        ownerDelta: ownerDelta.toString(),
        otherDelta: otherDelta.toString(),
        quotaResults: quotaResults.map(r => r?.out),
      })}`,
    )
  }

  // Reset quota back to 3 for future runs (idempotent).
  const cmd6 = await sendAdminCommand(cmdQuota3)
  if ((cmd6 as any)?.res?.result !== 200) throw new Error(`Expected admin cmd6 applied: ${JSON.stringify(cmd6)}`)

  const waitAfterCmd6 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitAfterCmd6.ok) throw new Error("Consensus wait failed after cmd6")

  const polAfterCmd6 = await assertPolicyDeterministic({ quotaPerBucket: 3 })

  // Supply invariant (per node): totalSupply == sum(balances)
  const supplyPerNode: Record<string, any> = {}
  for (const url of targets) {
    const tokenGet = await tokenGetCommittedWithFallback(url, tokenAddress)
    supplyPerNode[url] = tokenGet
    if (tokenGet?.result !== 200) throw new Error(`token.getCommitted failed on ${url}: ${JSON.stringify(tokenGet)}`)
    const state = tokenGet?.response?.state ?? {}
    const totalSupply = parseBigintOrZero(state?.totalSupply)
    const balances = state?.balances ?? {}
    let sum = 0n
    for (const v of Object.values(balances)) sum += parseBigintOrZero(v)
    if (totalSupply !== sum) {
      throw new Error(
        `Supply invariant failed on ${url}: totalSupply != sum(balances): ${stringifyJson({
          totalSupply: totalSupply.toString(),
          sumBalances: sum.toString(),
        })}`,
      )
    }
  }

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_complex_policy_dynamic_updates`
  const summary = {
    runId: run.runId,
    scenario: "token_script_complex_policy_dynamic_updates",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, other, attacker },
    txs: {
      upgrade,
      attackerOk1,
      cmd1,
      cmd2,
      attackerOk2,
      cmd3,
      cmd4,
      cmd5,
      cmd6,
    },
    policySnapshots: {
      afterCmd1: polAfterCmd1,
      afterCmd2: polAfterCmd2,
      afterCmd3: polAfterCmd3,
      afterCmd4: polAfterCmd4,
      afterCmd5: polAfterCmd5,
      afterCmd6: polAfterCmd6,
    },
    rejects: {
      afterCmd1: { rejectPerNode, rejectSignatures },
      afterCmd3: { rejectPerNode: rejectPerNode2 },
    },
    quota: {
      before: { owner: quotaBefore.owner.toString(), other: quotaBefore.other.toString() },
      after: { owner: quotaAfter.owner.toString(), other: quotaAfter.other.toString() },
      broadcastResults: quotaResults.map(r => ({ out: r?.out, result: r?.out?.result })),
    },
    invariants: {
      supplyOk: true,
    },
    ok: true,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_script_complex_policy_dynamic_updates_summary: summary }, null, 2))
}

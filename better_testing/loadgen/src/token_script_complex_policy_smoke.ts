import {
  buildSignedTokenTransferTxWithDemos,
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
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

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)
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

function safeBigIntFromString(value: any): bigint {
  try {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(value)
    return BigInt(String(value ?? "0"))
  } catch {
    return 0n
  }
}

function sumBigintStringMap(map: any): bigint {
  if (!map || typeof map !== "object") return 0n
  let sum = 0n
  for (const v of Object.values(map)) sum += safeBigIntFromString(v)
  return sum
}

async function tokenGetCommittedWithFallback(rpcUrl: string, tokenAddress: string): Promise<any> {
  const committed = await nodeCall(
    rpcUrl,
    "token.getCommitted",
    { tokenAddress },
    `token.getCommitted:complex_policy:${rpcUrl.replace(/[^a-z0-9]+/gi, "_")}`,
  )
  if (committed?.result === 409) {
    return await nodeCall(
      rpcUrl,
      "token.get",
      { tokenAddress },
      `token.get:fallback:complex_policy:${rpcUrl.replace(/[^a-z0-9]+/gi, "_")}`,
    )
  }
  return committed
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

export async function runTokenScriptComplexPolicySmoke() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_script_complex_policy_smoke requires 3 wallets (owner, other, attacker)")
  const ownerMnemonic = wallets[0]!
  const otherMnemonic = wallets[1]!
  const attackerMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, otherMnemonic, attackerMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const other = walletAddresses[1]!
  const attacker = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const scriptCode = buildComplexPolicyScript({
    allowlist: [owner, other], // attacker is not allowlisted
    denylist: [attacker], // explicit deny branch
    quotaPerBucket: 3,
    bucketMs: 60_000,
    amountLimit: 1000n,
    feeThreshold: 10n,
    feeFixed: 1n,
    feeSink: owner,
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

  const waitConsensus = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitConsensus.ok) throw new Error("Consensus wait failed after upgradeScript")

  // 1) allowlisted transfer (owner -> other), amount >= feeThreshold to exercise fee branch
  const baseTimestamp = Date.now()
  const okTransferTx = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await buildSignedTokenTransferTxWithDemos({ demos, tokenAddress, to: other, amount: 10n, nonce, timestamp: baseTimestamp })
    },
  })
  const okTransfer = await broadcastSignedTxOnce({ rpcUrl, mnemonic: ownerMnemonic, signedTx: (okTransferTx as any).signedTx })
  if ((okTransfer as any)?.res?.result !== 200) {
    throw new Error(`Expected ok transfer but got: ${JSON.stringify(okTransfer)}`)
  }

  const waitConsensusAfterOk = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitConsensusAfterOk.ok) throw new Error("Consensus wait failed after ok transfer")

  // 2) attacker transfer should reject deterministically on all nodes (denylist + not_allowlisted).
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

  const invalidBroadcastPerNode: Record<string, any> = {}
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
    invalidBroadcastPerNode[url] = out
  }

  const rejectSignatures = targets.map(url => ({ url, sig: extractRejectSignature(invalidBroadcastPerNode[url]?.res) }))
  const rejectDeterministic =
    rejectSignatures.every(e => !!e.sig) && rejectSignatures.every(e => e.sig === rejectSignatures[0]!.sig)
  if (!rejectDeterministic) {
    throw new Error(`Non-deterministic reject across nodes: ${stringifyJson({ rejectSignatures, invalidBroadcastPerNode })}`)
  }
  for (const url of targets) {
    assertRejected(invalidBroadcastPerNode[url]?.res, "denylist")
  }

  // 3) quota branch: 3 transfers in the same bucket should reject the 3rd.
  const quotaBefore = {
    owner: await getBalance(rpcUrl, tokenAddress, owner),
    other: await getBalance(rpcUrl, tokenAddress, other),
  }

  const quotaTimestamp = baseTimestamp
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

  const waitConsensus3 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitConsensus3.ok) throw new Error("Consensus wait failed after quota burst")

  const quotaAfter = {
    owner: await getBalance(rpcUrl, tokenAddress, owner),
    other: await getBalance(rpcUrl, tokenAddress, other),
  }

  const appliedCount =
    quotaBefore.owner - quotaAfter.owner === 2n && quotaAfter.other - quotaBefore.other === 2n ? 2 : null
  if (appliedCount !== 2) {
    throw new Error(
      `Expected quota to apply only 2/3 transfers but got deltas: ${stringifyJson({
        ownerDelta: (quotaBefore.owner - quotaAfter.owner).toString(),
        otherDelta: (quotaAfter.other - quotaBefore.other).toString(),
        quotaResults: quotaResults.map(r => r?.out),
      })}`,
    )
  }

  const waitConsensus2 = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitConsensus2.ok) throw new Error("Consensus wait failed after policy transfers")

  // Verify policy views respond on all nodes and customState (storage) has the expected structure.
  const policyPerNode: Record<string, any> = {}
  const senderStatsPerNode: Record<string, any> = {}
  for (const url of targets) {
    const policy = await callView(url, tokenAddress, "getPolicy", [])
    policyPerNode[url] = policy
    if (policy?.result !== 200) throw new Error(`getPolicy failed on ${url}: ${JSON.stringify(policy)}`)
    const stats = await callView(url, tokenAddress, "getSenderStats", [owner])
    senderStatsPerNode[url] = stats
    if (stats?.result !== 200) throw new Error(`getSenderStats failed on ${url}: ${JSON.stringify(stats)}`)
  }

  // Invariants: (1) customState deterministic across nodes, (2) fee accounting, (3) quotas/counters, (4) totalSupply == sum(balances)
  const policyValuePerNode: Record<string, any> = {}
  const policyStorageHashPerNode: Record<string, string> = {}
  const policyHashPerNode: Record<string, string> = {}
  for (const url of targets) {
    const value = policyPerNode[url]?.response?.value
    if (!value || typeof value !== "object") {
      throw new Error(`getPolicy missing response.value on ${url}: ${JSON.stringify(policyPerNode[url])}`)
    }
    policyValuePerNode[url] = value
    policyStorageHashPerNode[url] = stableHashJson(value.storage ?? null)
    policyHashPerNode[url] = stableHashJson(value.policy ?? null)
  }

  const firstStorageHash = policyStorageHashPerNode[targets[0]!]!
  const firstPolicyHash = policyHashPerNode[targets[0]!]!
  for (const url of targets) {
    if (policyStorageHashPerNode[url] !== firstStorageHash) {
      throw new Error(
        `Non-deterministic policy storage across nodes: ${stringifyJson({ policyStorageHashPerNode, policyValuePerNode })}`,
      )
    }
    if (policyHashPerNode[url] !== firstPolicyHash) {
      throw new Error(`Non-deterministic policy config across nodes: ${stringifyJson({ policyHashPerNode, policyValuePerNode })}`)
    }
  }

  const canonicalStorage = policyValuePerNode[targets[0]!]!.storage ?? {}
  const fees = canonicalStorage?.fees ?? {}
  const feeTotal = safeBigIntFromString(fees?.total ?? "0")
  const feeBySenderSum = sumBigintStringMap(fees?.bySender ?? {})
  const feeBySinkSum = sumBigintStringMap(fees?.bySink ?? {})
  if (feeTotal !== feeBySenderSum) {
    throw new Error(`Fee invariant failed: fees.total != sum(fees.bySender): ${stringifyJson({ fees })}`)
  }
  if (feeTotal !== feeBySinkSum) {
    throw new Error(`Fee invariant failed: fees.total != sum(fees.bySink): ${stringifyJson({ fees })}`)
  }
  if (feeTotal !== 1n) {
    throw new Error(`Fee invariant failed: expected fees.total == 1 but got ${feeTotal.toString()}: ${stringifyJson({ fees })}`)
  }
  if (safeBigIntFromString(fees?.bySender?.[owner] ?? "0") !== 1n) {
    throw new Error(`Fee invariant failed: expected fees.bySender[owner] == 1: ${stringifyJson({ fees, owner })}`)
  }
  if (safeBigIntFromString(fees?.bySink?.[owner] ?? "0") !== 1n) {
    throw new Error(`Fee invariant failed: expected fees.bySink[owner] == 1: ${stringifyJson({ fees, owner })}`)
  }

  const counts = canonicalStorage?.counts ?? {}
  if (Number(counts?.beforeTransfer ?? 0) !== 3 || Number(counts?.afterTransfer ?? 0) !== 3) {
    throw new Error(`Counter invariant failed: expected before/afterTransfer == 3: ${stringifyJson({ counts })}`)
  }
  const quotaOwnerBucket0 = canonicalStorage?.quotas?.[owner]?.["0"] ?? canonicalStorage?.quotas?.[owner]?.[0]
  if (Number(quotaOwnerBucket0 ?? 0) !== 3) {
    throw new Error(`Quota invariant failed: expected quotas[owner][0] == 3: ${stringifyJson({ quotas: canonicalStorage?.quotas })}`)
  }

  const supplyInvariantPerNode: Record<string, any> = {}
  for (const url of targets) {
    const tokenGet = await tokenGetCommittedWithFallback(url, tokenAddress)
    supplyInvariantPerNode[url] = tokenGet
    if (tokenGet?.result !== 200) {
      throw new Error(`Supply invariant: token.getCommitted failed on ${url}: ${JSON.stringify(tokenGet)}`)
    }
    const state = tokenGet?.response?.state ?? {}
    const totalSupply = safeBigIntFromString(state?.totalSupply ?? "0")
    const balances = state?.balances ?? {}
    let sumBalances = 0n
    for (const v of Object.values(balances)) sumBalances += safeBigIntFromString(v)
    if (totalSupply !== sumBalances) {
      throw new Error(
        `Supply invariant failed on ${url}: totalSupply != sum(balances): ${stringifyJson({
          totalSupply: totalSupply.toString(),
          sumBalances: sumBalances.toString(),
        })}`,
      )
    }
  }

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_script_complex_policy_smoke`
  const summary = {
    runId: run.runId,
    scenario: "token_script_complex_policy_smoke",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, other, attacker },
    txs: { upgrade, okTransfer },
    invalidBroadcastPerNode,
    rejectSignatures,
    quota: {
      baseTimestamp,
      before: { owner: quotaBefore.owner.toString(), other: quotaBefore.other.toString() },
      after: { owner: quotaAfter.owner.toString(), other: quotaAfter.other.toString() },
      broadcastResults: quotaResults.map(r => ({ out: r?.out, result: r?.out?.result })),
    },
    policyPerNode,
    senderStatsPerNode,
    invariants: {
      policyStorageHashPerNode,
      policyHashPerNode,
      fees: {
        expectedTotal: "1",
        observed: fees,
      },
      counts,
      quotas: canonicalStorage?.quotas ?? null,
      supply: {
        ok: true,
        perNode: targets.map(url => ({ rpcUrl: url, ok: supplyInvariantPerNode[url]?.result === 200 })),
      },
    },
    ok: true,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_script_complex_policy_smoke_summary: summary }, null, 2))
}

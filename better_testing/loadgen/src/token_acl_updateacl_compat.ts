import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenMintTxWithDemos,
  sendTokenUpdateAclTxWithDemos,
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

function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2)
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

  const balances: Record<string, string> = {}
  for (const a of addresses) {
    const bal = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    if (bal?.result !== 200) throw new Error(`token.getBalance failed: ${JSON.stringify(bal)}`)
    balances[a] = String(bal?.response?.balance ?? "0")
  }

  return { owner, paused, aclEntries, balances }
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

export async function runTokenAclUpdateAclCompat() {
  maybeSilenceConsole()

  const targets = getTokenTargets().map(normalizeRpcUrl)
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("token_acl_updateacl_compat requires at least 3 wallets (owner, grantee, outsider)")

  const ownerMnemonic = wallets[0]!
  const granteeMnemonic = wallets[1]!
  const outsiderMnemonic = wallets[2]!

  const walletAddresses = (await getWalletAddresses(rpcUrl, [ownerMnemonic, granteeMnemonic, outsiderMnemonic])).map(normalizeHexAddress)
  const owner = walletAddresses[0]!
  const grantee = walletAddresses[1]!
  const outsider = walletAddresses[2]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, walletAddresses)

  const mintAmount = BigInt(process.env.TOKEN_MINT_AMOUNT ?? "1")
  const applyTimeoutSec = envInt("TOKEN_WAIT_APPLY_SEC", 120)

  const before = await snapshot(rpcUrl, tokenAddress, [owner, grantee, outsider])
  if (before.owner !== owner) throw new Error(`Token owner mismatch: ${before.owner} !== ${owner}`)

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

  const preUpdateAcl = await withDemosWallet({
    rpcUrl,
    mnemonic: outsiderMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== outsider) throw new Error(`outsider identity mismatch: ${fromHex} !== ${outsider}`)
      const nonce = Number(await demos.getAddressNonce(outsider)) + 1
      return await sendTokenUpdateAclTxWithDemos({
        demos,
        tokenAddress,
        action: "grant",
        targetAddress: outsider,
        permissions: ["canMint"],
        nonce,
      })
    },
  })
  assertRejected(preUpdateAcl?.res, "No ACL modification permission")

  const grantViaUpdateAcl = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenUpdateAclTxWithDemos({
        demos,
        tokenAddress,
        action: "grant",
        targetAddress: grantee,
        permissions: ["canMint"],
        nonce,
      })
    },
  })

  const waitGrant = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitGrant.ok) throw new Error("Consensus wait failed after updateACL grant")

  const afterGrantVisible = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s => getEntryPerms(s.aclEntries, grantee).includes("canMint"),
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

  const waitMint = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: envInt("CONSENSUS_ROUNDS", 1),
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 180),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })
  if (!waitMint.ok) throw new Error("Consensus wait failed after mint")

  const afterMintApplied = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s => {
      const beforeBal = BigInt(afterGrant.balances[grantee] ?? "0")
      const afterBal = BigInt(s.balances[grantee] ?? "0")
      return afterBal === beforeBal + mintAmount
    },
  })
  const afterMint = afterMintApplied.snapshot
  const mintApplied = afterMintApplied.ok

  const revokeViaUpdateAcl = await withDemosWallet({
    rpcUrl,
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== owner) throw new Error(`owner identity mismatch: ${fromHex} !== ${owner}`)
      const nonce = Number(await demos.getAddressNonce(owner)) + 1
      return await sendTokenUpdateAclTxWithDemos({
        demos,
        tokenAddress,
        action: "revoke",
        targetAddress: grantee,
        permissions: ["canMint"],
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
  if (!waitRevoke.ok) throw new Error("Consensus wait failed after updateACL revoke")

  const afterRevokeVisible = await waitForSnapshotUntil({
    rpcUrl,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: applyTimeoutSec,
    pollMs: 500,
    predicate: s => !getEntryPerms(s.aclEntries, grantee).includes("canMint"),
  })
  const afterRevoke = afterRevokeVisible.snapshot
  const revokeVisible = afterRevokeVisible.ok

  const postMint = await withDemosWallet({
    rpcUrl,
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      if (normalizeHexAddress(fromHex) !== grantee) throw new Error(`grantee identity mismatch: ${fromHex} !== ${grantee}`)
      const nonce = Number(await demos.getAddressNonce(grantee)) + 1
      return await sendTokenMintTxWithDemos({ demos, tokenAddress, to: grantee, amount: mintAmount, nonce })
    },
  })
  assertRejected(postMint?.res, "No mint permission")

  const crossNodeTokenGet = await waitForCrossNodeTokenGetConsistency({
    rpcUrls: targets,
    tokenAddress,
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const crossNodeBalances = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: [owner, grantee, outsider],
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_acl_updateacl_compat`
  const summary = {
    runId: run.runId,
    scenario: "token_acl_updateacl_compat",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, grantee, outsider },
    txs: {
      preMint,
      preUpdateAcl,
      grantViaUpdateAcl,
      mintOk,
      revokeViaUpdateAcl,
      postMint,
    },
    snapshots: {
      before,
      afterGrant,
      afterMint,
      afterRevoke,
    },
    assertions: {
      grantVisible,
      mintApplied,
      revokeVisible,
      crossNodeTokenGetOk: crossNodeTokenGet.ok,
      crossNodeBalancesOk: crossNodeBalances.ok,
    },
    crossNodeTokenGet,
    crossNodeBalances,
    ok: grantVisible && mintApplied && revokeVisible && crossNodeTokenGet.ok && crossNodeBalances.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(stringifyJson({ token_acl_updateacl_compat_summary: summary }))
  if (!summary.ok) throw new Error("token_acl_updateacl_compat failed assertions")
}


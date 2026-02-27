import { appendJsonl, getRunConfig, writeJson } from "./run_io"
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
  waitForCrossNodeHolderPointersMatchBalances,
  waitForCrossNodeTokenConsistency,
  withDemosWallet,
} from "./token_shared"

type Config = {
  targets: string[]
  granteeIndex: number
  attackerIndex: number
  mintAmount: bigint
  burnAmount: bigint
  settleTimeoutSec: number
  holderPointerTimeoutSec: number
  pollMs: number
  logDetails: boolean
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true
    case "0":
    case "false":
    case "no":
    case "n":
    case "off":
      return false
    default:
      return fallback
  }
}

function normalizeHexAddress(address: string): string {
  const trimmed = (address ?? "").trim()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : ("0x" + trimmed).toLowerCase()
}

function stableBalances(addresses: string[], balances: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const a of addresses.map(normalizeHexAddress).sort()) out[a] = balances[a] ?? null
  return out
}

async function fetchTokenSnapshot(rpcUrl: string, tokenAddress: string, addresses: string[]) {
  const addrNorm = addresses.map(normalizeHexAddress)

  const tokenRes = await nodeCall(rpcUrl, "token.get", { tokenAddress }, `token.get:${tokenAddress}`)
  if (tokenRes?.result !== 200) return { ok: false, snapshot: null, error: tokenRes }

  const balances: Record<string, string | null> = {}
  for (const a of addrNorm) {
    const balRes = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `token.getBalance:${a}`)
    if (balRes?.result === 200) balances[a] = balRes?.response?.balance ?? null
    else balances[a] = null
  }

  const snapshot = {
    tokenAddress,
    state: { totalSupply: tokenRes?.response?.state?.totalSupply ?? null },
    balances: stableBalances(addrNorm, balances),
  }

  return { ok: true, snapshot, error: null }
}

function snapshotsEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function getConfig(): Config {
  return {
    targets: getTokenTargets(),
    granteeIndex: Math.max(1, envInt("ACL_GRANTEE_INDEX", 1)),
    attackerIndex: Math.max(2, envInt("ACL_ATTACKER_INDEX", 2)),
    mintAmount: BigInt(process.env.ACL_MINT_AMOUNT ?? "10"),
    burnAmount: BigInt(process.env.ACL_BURN_AMOUNT ?? "1"),
    settleTimeoutSec: envInt("POST_RUN_SETTLE_TIMEOUT_SEC", 120),
    holderPointerTimeoutSec: envInt("POST_RUN_HOLDER_POINTER_TIMEOUT_SEC", 120),
    pollMs: envInt("POST_RUN_SETTLE_POLL_MS", 500),
    logDetails: envBool("ACL_LOG_DETAILS", false),
  }
}

function pickTarget(targets: string[], idx: number): string {
  if (targets.length === 0) throw new Error("No TARGETS configured")
  return targets[Math.abs(idx) % targets.length]!
}

export async function runTokenAclSmoke() {
  maybeSilenceConsole()
  const cfg = getConfig()

  const wallets = await readWalletMnemonics()
  if (wallets.length < 3) throw new Error("Need at least 3 wallets for ACL smoke. Configure WALLET_FILES/WALLETS.")

  const bootstrapRpc = pickTarget(cfg.targets, 0)
  const walletAddresses = await getWalletAddresses(bootstrapRpc, wallets)

  const ownerMnemonic = wallets[0]!
  const ownerAddress = normalizeHexAddress(walletAddresses[0]!)

  if (cfg.granteeIndex >= wallets.length) throw new Error(`ACL_GRANTEE_INDEX=${cfg.granteeIndex} out of range`)
  if (cfg.attackerIndex >= wallets.length) throw new Error(`ACL_ATTACKER_INDEX=${cfg.attackerIndex} out of range`)

  const granteeMnemonic = wallets[cfg.granteeIndex]!
  const granteeAddress = normalizeHexAddress(walletAddresses[cfg.granteeIndex]!)
  const attackerMnemonic = wallets[cfg.attackerIndex]!
  const attackerAddress = normalizeHexAddress(walletAddresses[cfg.attackerIndex]!)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_acl_smoke`
  const artifacts = {
    runId: run.runId,
    runDir: run.runDir,
    summaryPath: `${artifactBase}.summary.json`,
    logPath: `${artifactBase}.log.jsonl`,
  }

  function logEvent(event: any) {
    appendJsonl(artifacts.logPath, { t: new Date().toISOString(), ...event })
  }

  const { tokenAddress } = await ensureTokenAndBalances(bootstrapRpc, ownerMnemonic, [
    ownerAddress,
    granteeAddress,
    attackerAddress,
  ])

  logEvent({
    phase: "bootstrap",
    tokenAddress,
    ownerAddress,
    granteeAddress,
    attackerAddress,
    targets: cfg.targets,
  })

  // 1) Grant canMint+canBurn to grantee
  const grantRes = await withDemosWallet({
    rpcUrl: pickTarget(cfg.targets, 0),
    mnemonic: ownerMnemonic,
    fn: async (demos, fromHex) => {
      const grantNonce = Number(await demos.getAddressNonce(fromHex)) + 1
      const grant = await sendTokenGrantPermissionTxWithDemos({
        demos,
        tokenAddress,
        grantee: granteeAddress,
        permissions: ["canMint", "canBurn"],
        nonce: grantNonce,
      })
      return { grantNonce, grant }
    },
  })

  logEvent({
    phase: "grantPermission",
    nonce: grantRes.grantNonce,
    result: grantRes.grant.res?.result,
    response: cfg.logDetails ? grantRes.grant.res : undefined,
  })

  // 2) Grantee mints to owner (permissioned)
  const mintRes = await withDemosWallet({
    rpcUrl: pickTarget(cfg.targets, 1),
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
      const mint = await sendTokenMintTxWithDemos({
        demos,
        tokenAddress,
        to: ownerAddress,
        amount: cfg.mintAmount,
        nonce,
      })
      return { nonce, mint }
    },
  })
  logEvent({
    phase: "granteeMint",
    nonce: mintRes.nonce,
    result: mintRes.mint.res?.result,
    response: cfg.logDetails ? mintRes.mint.res : undefined,
  })

  // 3) Grantee burns from owner (permissioned; burn-from-any requires canBurn)
  const burnRes = await withDemosWallet({
    rpcUrl: pickTarget(cfg.targets, 1),
    mnemonic: granteeMnemonic,
    fn: async (demos, fromHex) => {
      const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
      const burn = await sendTokenBurnTxWithDemos({
        demos,
        tokenAddress,
        from: ownerAddress,
        amount: cfg.burnAmount,
        nonce,
      })
      return { nonce, burn }
    },
  })
  logEvent({
    phase: "granteeBurnFromOwner",
    nonce: burnRes.nonce,
    result: burnRes.burn.res?.result,
    response: cfg.logDetails ? burnRes.burn.res : undefined,
  })

  // 4) Settle: cross-node state consistency + holder pointers
  const settleAddresses = [ownerAddress, granteeAddress, attackerAddress]
  const settle = await waitForCrossNodeTokenConsistency({
    rpcUrls: cfg.targets,
    tokenAddress,
    addresses: settleAddresses,
    timeoutSec: cfg.settleTimeoutSec,
    pollMs: cfg.pollMs,
  })

  const expectedPresent: Record<string, boolean> = {}
  if (settle.ok && settle.perNode?.[0]?.snapshot?.balances) {
    for (const [addr, balRaw] of Object.entries(settle.perNode[0].snapshot.balances)) {
      try {
        expectedPresent[addr] = BigInt(balRaw ?? "0") > 0n
      } catch {
        expectedPresent[addr] = false
      }
    }
  }

  const holderPointers =
    settle.ok && Object.keys(expectedPresent).length > 0
      ? await waitForCrossNodeHolderPointersMatchBalances({
        rpcUrls: cfg.targets,
        tokenAddress,
        expectedPresent,
        timeoutSec: cfg.holderPointerTimeoutSec,
        pollMs: cfg.pollMs,
      })
      : null

  // 5) Negative: attacker mint/burn should not change state
  const baseline = await fetchTokenSnapshot(bootstrapRpc, tokenAddress, [ownerAddress, attackerAddress])
  if (!baseline.ok || !baseline.snapshot) throw new Error(`Failed to read baseline snapshot: ${JSON.stringify(baseline.error)}`)

  const attackerDemos = await connectWallet(pickTarget(cfg.targets, 2), attackerMnemonic)
  let attackerNextNonce = await nextNonce(attackerDemos, attackerAddress)

  const attackerMintAttempt = await sendTokenMintTxWithDemos({
    demos: attackerDemos,
    tokenAddress,
    to: attackerAddress,
    amount: 1n,
    nonce: attackerNextNonce++,
  }).catch((err: any) => ({ res: { result: -1, error: String(err) } }))
  logEvent({ phase: "attackerMintAttempt", result: (attackerMintAttempt as any)?.res?.result, error: (attackerMintAttempt as any)?.res?.error })

  const afterMint = await waitForCrossNodeTokenConsistency({
    rpcUrls: cfg.targets,
    tokenAddress,
    addresses: [ownerAddress, attackerAddress],
    timeoutSec: cfg.settleTimeoutSec,
    pollMs: cfg.pollMs,
  })
  const afterMintSnapshot = afterMint?.perNode?.[0]?.snapshot
  const baselineLike = {
    tokenAddress,
    metadata: { name: null, ticker: null, decimals: null },
    state: { totalSupply: baseline.snapshot.state.totalSupply },
    balances: baseline.snapshot.balances,
  }
  const afterMintLike = afterMintSnapshot
    ? {
      tokenAddress,
      metadata: { name: null, ticker: null, decimals: null },
      state: { totalSupply: afterMintSnapshot.state.totalSupply },
      balances: stableBalances(Object.keys(baseline.snapshot.balances), afterMintSnapshot.balances),
    }
    : null

  const attackerMintOk = !!afterMintLike && snapshotsEqual(baselineLike, afterMintLike)

  const attackerBurnAttempt = await sendTokenBurnTxWithDemos({
    demos: attackerDemos,
    tokenAddress,
    from: ownerAddress,
    amount: 1n,
    nonce: attackerNextNonce++,
  }).catch((err: any) => ({ res: { result: -1, error: String(err) } }))
  logEvent({ phase: "attackerBurnAttempt", result: (attackerBurnAttempt as any)?.res?.result, error: (attackerBurnAttempt as any)?.res?.error })

  const afterBurn = await waitForCrossNodeTokenConsistency({
    rpcUrls: cfg.targets,
    tokenAddress,
    addresses: [ownerAddress, attackerAddress],
    timeoutSec: cfg.settleTimeoutSec,
    pollMs: cfg.pollMs,
  })
  const afterBurnSnapshot = afterBurn?.perNode?.[0]?.snapshot
  const afterBurnLike = afterBurnSnapshot
    ? {
      tokenAddress,
      metadata: { name: null, ticker: null, decimals: null },
      state: { totalSupply: afterBurnSnapshot.state.totalSupply },
      balances: stableBalances(Object.keys(baseline.snapshot.balances), afterBurnSnapshot.balances),
    }
    : null

  const attackerBurnOk = !!afterBurnLike && snapshotsEqual(baselineLike, afterBurnLike)

  const summary = {
    scenario: "token_acl_smoke",
    tokenAddress,
    ownerAddress,
    granteeAddress,
    attackerAddress,
    config: {
      targets: cfg.targets,
      mintAmount: cfg.mintAmount.toString(),
      burnAmount: cfg.burnAmount.toString(),
      granteeIndex: cfg.granteeIndex,
      attackerIndex: cfg.attackerIndex,
      settleTimeoutSec: cfg.settleTimeoutSec,
      holderPointerTimeoutSec: cfg.holderPointerTimeoutSec,
    },
    postRun: {
      settle,
      holderPointers,
      negative: {
        baseline: baseline.snapshot,
        attackerMintNoStateChange: attackerMintOk,
        attackerBurnNoStateChange: attackerBurnOk,
      },
    },
    ok: settle.ok && (holderPointers?.ok ?? true) && attackerMintOk && attackerBurnOk,
    artifacts,
    timestamp: new Date().toISOString(),
  }

  writeJson(artifacts.summaryPath, summary)
  console.log(JSON.stringify({ token_acl_smoke_summary: summary }, null, 2))
}

import {
  ensureTokenAndBalances,
  getTokenTargets,
  getWalletAddresses,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  sendTokenBurnTxWithDemos,
  sendTokenMintTxWithDemos,
  sendTokenTransferTxWithDemos,
  withDemosWallet,
} from "./token_shared"
import { getRunConfig, writeJson } from "./framework/io"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
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

async function fetchSnapshot(rpcUrl: string, tokenAddress: string, addresses: string[]) {
  const tokenRes = await nodeCall(rpcUrl, "token.get", { tokenAddress }, "snapshot:token.get")
  if (tokenRes?.result !== 200) return { ok: false, error: tokenRes, snapshot: null as any }

  const balances: Record<string, string | null> = {}
  for (const a of addresses) {
    const balRes = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: a }, `snapshot:bal:${a}`)
    balances[a] = balRes?.result === 200 ? (balRes?.response?.balance ?? null) : null
  }

  return {
    ok: true,
    error: null,
    snapshot: {
      totalSupply: tokenRes?.response?.state?.totalSupply ?? null,
      balances,
    },
  }
}

function snapshotsEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function waitForBlockAdvance(params: { rpcUrl: string; before: number; timeoutSec: number }) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempt = 0
  while (Date.now() < deadline) {
    const res = await nodeCall(params.rpcUrl, "getLastBlockNumber", {}, `edge:lastBlock:${attempt}`)
    const raw = res?.response
    const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN
    if (Number.isFinite(parsed) && parsed > params.before) return parsed
    attempt++
    await new Promise(r => setTimeout(r, Math.min(2000, 100 + attempt * 100)))
  }
  return null
}

export async function runTokenEdgeCases() {
  maybeSilenceConsole()
  const targets = getTokenTargets()
  const rpcUrl = targets[0]!

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_edge_cases requires at least 2 wallets")

  const walletAddresses = await getWalletAddresses(rpcUrl, wallets.slice(0, 2))
  const ownerMnemonic = wallets[0]!
  const attackerMnemonic = wallets[1]!

  const owner = walletAddresses[0]!
  const attacker = walletAddresses[1]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, ownerMnemonic, [owner, attacker])

  const before = await fetchSnapshot(rpcUrl, tokenAddress, [owner, attacker])
  if (!before.ok) throw new Error(`Failed to fetch token snapshot before edge cases: ${JSON.stringify(before.error)}`)

  const cases: Array<{ name: string; expected: string; res: any }> = []

  // transfer amount 0
  {
    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: attacker, amount: 0n, nonce })).res
      },
    })
    assertRejected(res, "Transfer amount must be positive")
    cases.push({ name: "transfer_amount_0", expected: "Transfer amount must be positive", res })
  }

  // mint amount 0 (even owner should be rejected)
  {
    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenMintTxWithDemos({ demos, tokenAddress, to: owner, amount: 0n, nonce })).res
      },
    })
    assertRejected(res, "Mint amount must be positive")
    cases.push({ name: "mint_amount_0", expected: "Mint amount must be positive", res })
  }

  // burn amount 0 (self burn)
  {
    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: owner, amount: 0n, nonce })).res
      },
    })
    assertRejected(res, "Burn amount must be positive")
    cases.push({ name: "burn_amount_0", expected: "Burn amount must be positive", res })
  }

  // transfer > balance (attacker)
  {
    const balRes = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: attacker }, "edge:bal")
    const bal = BigInt(balRes?.response?.balance ?? "0")
    const tooMuch = bal + 1n

    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: attackerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount: tooMuch, nonce })).res
      },
    })
    assertRejected(res, "Insufficient balance")
    cases.push({ name: "transfer_insufficient_balance", expected: "Insufficient balance", res })
  }

  // burn > balance (attacker self-burn)
  {
    const balRes = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: attacker }, "edge:bal2")
    const bal = BigInt(balRes?.response?.balance ?? "0")
    const tooMuch = bal + 1n

    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: attackerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: attacker, amount: tooMuch, nonce })).res
      },
    })
    assertRejected(res, "Insufficient balance to burn")
    cases.push({ name: "burn_insufficient_balance", expected: "Insufficient balance to burn", res })
  }

  // burn from someone else without canBurn permission
  {
    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: attackerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenBurnTxWithDemos({ demos, tokenAddress, from: owner, amount: 1n, nonce })).res
      },
    })
    assertRejected(res, "No burn permission")
    cases.push({ name: "burn_other_no_permission", expected: "No burn permission", res })
  }

  // mint without canMint permission
  {
    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: attackerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenMintTxWithDemos({ demos, tokenAddress, to: attacker, amount: 1n, nonce })).res
      },
    })
    assertRejected(res, "No mint permission")
    cases.push({ name: "mint_no_permission", expected: "No mint permission", res })
  }

  // self-transfer should not mint or otherwise mutate token state
  {
    const lastBlockRes = await nodeCall(rpcUrl, "getLastBlockNumber", {}, "edge:lastBlock:beforeSelfTransfer")
    const lastBlockRaw = lastBlockRes?.response
    const lastBlockBefore =
      typeof lastBlockRaw === "string" ? Number.parseInt(lastBlockRaw, 10) : typeof lastBlockRaw === "number" ? lastBlockRaw : 0

    const amount = BigInt(process.env.SELF_TRANSFER_AMOUNT ?? "1")
    const res = await withDemosWallet({
      rpcUrl,
      mnemonic: ownerMnemonic,
      fn: async (demos, fromHex) => {
        const nonce = Number(await demos.getAddressNonce(fromHex)) + 1
        return (await sendTokenTransferTxWithDemos({ demos, tokenAddress, to: owner, amount, nonce })).res
      },
    })

    const appliedBlock =
      res?.result === 200
        ? await waitForBlockAdvance({ rpcUrl, before: Number.isFinite(lastBlockBefore) ? lastBlockBefore : 0, timeoutSec: envInt("WAIT_FOR_TX_SEC", 120) })
        : null

    cases.push({
      name: "self_transfer_noop",
      expected: "no token state mutation (totalSupply + balances unchanged)",
      res: { ...res, appliedBlock: appliedBlock ?? null },
    })
  }

  // non-existent token address read (expects non-200)
  const missingTokenAddress =
    process.env.MISSING_TOKEN_ADDRESS ??
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  const missingGet = await nodeCall(rpcUrl, "token.get", { tokenAddress: missingTokenAddress }, "edge:missing:get")

  const after = await fetchSnapshot(rpcUrl, tokenAddress, [owner, attacker])
  if (!after.ok) throw new Error(`Failed to fetch token snapshot after edge cases: ${JSON.stringify(after.error)}`)

  const stateUnchanged = snapshotsEqual(before.snapshot, after.snapshot)

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_edge_cases`
  const summary = {
    runId: run.runId,
    scenario: "token_edge_cases",
    rpcUrl,
    tokenAddress,
    owner,
    attacker,
    missingTokenAddress,
    missingGet,
    before: before.snapshot,
    after: after.snapshot,
    cases,
    stateUnchanged,
    waitForRpcSec: envInt("WAIT_FOR_RPC_SEC", 120),
    waitForTxSec: envInt("WAIT_FOR_TX_SEC", 120),
    timestamp: new Date().toISOString(),
    ok: stateUnchanged,
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_edge_cases_summary: summary }, null, 2))

  if (!stateUnchanged) {
    throw new Error("Edge cases mutated token state unexpectedly")
  }
}

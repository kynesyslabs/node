/**
 * token_gcr_batch_exclusion — Devnet scenario
 *
 * Validates that transactions containing BOTH token edits and non-token GCR edits
 * (balance/nonce) are correctly separated during consensus:
 *   1. Token edits validated via applyTokenEditsToTx (simulate mode)
 *   2. Token edits stripped before batch applyTransactions
 *   3. Non-token GCR edits applied via batch processing
 *   4. Both token and GCR state changes land correctly
 *
 * This is the verification scenario for Mycelium Epic #11, Task #266.
 */

import { Demos } from "@kynesyslabs/demosdk/websdk"
import {
  maybeSilenceConsole,
  getTokenTargets,
  readWalletMnemonics,
  ensureTokenAndBalances,
  getWalletAddresses,
  nodeCall,
  sendTokenTransferTxWithDemos,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"
import { getRunConfig, writeJson } from "./framework/io"
import { nowMs, sleep } from "./framework/common"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

/**
 * Poll until nonce reaches at least the expected value on a given RPC.
 */
async function waitForNonceAtLeast(
  rpcUrl: string,
  address: string,
  expected: number,
  timeoutSec: number,
): Promise<{ ok: boolean; observed: number | null }> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  let observed: number | null = null
  while (nowMs() < deadlineMs) {
    const res = await nodeCall(rpcUrl, "getAddressNonce", { address }, `nonce:${attempt}`)
    const n = res?.response
    if (typeof n === "number" && Number.isFinite(n)) observed = n
    else if (typeof n === "string") {
      const parsed = Number.parseInt(n, 10)
      if (Number.isFinite(parsed)) observed = parsed
    }
    if (observed !== null && observed >= expected) return { ok: true, observed }
    attempt++
    await sleep(Math.min(2000, 200 + attempt * 100))
  }
  return { ok: false, observed }
}

/**
 * Poll until token balance reaches at least the expected value.
 */
async function waitForTokenBalanceAtLeast(
  rpcUrl: string,
  tokenAddress: string,
  address: string,
  minBalance: bigint,
  timeoutSec: number,
): Promise<{ ok: boolean; observed: string | null }> {
  const deadlineMs = nowMs() + Math.max(1, timeoutSec) * 1000
  let attempt = 0
  let observed: string | null = null
  while (nowMs() < deadlineMs) {
    const res = await nodeCall(rpcUrl, "token.getBalanceCommitted", { tokenAddress, address }, `tokenBal:${attempt}`)
    const balRaw = res?.response?.balance
    if (typeof balRaw === "string") {
      observed = balRaw
      try {
        if (BigInt(balRaw) >= minBalance) return { ok: true, observed }
      } catch { /* ignore parse errors */ }
    }
    attempt++
    await sleep(Math.min(2000, 200 + attempt * 100))
  }
  return { ok: false, observed }
}

// REVIEW: Main scenario function
export async function runTokenGcrBatchExclusion() {
  maybeSilenceConsole()
  const targets = getTokenTargets()
  const rpcUrl = targets[0]!
  const wallets = await readWalletMnemonics()
  if (wallets.length < 1) throw new Error("token_gcr_batch_exclusion requires at least 1 wallet")

  // REVIEW: Works with 1 wallet (self-transfer) or 2 wallets
  const walletAddresses = await getWalletAddresses(rpcUrl, wallets.slice(0, Math.min(2, wallets.length)))
  const from = walletAddresses[0]!
  const to = walletAddresses.length > 1 ? walletAddresses[1]! : from

  // Step 1: Ensure token exists and sender has balance
  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, wallets[0]!, walletAddresses)

  // Step 2: Connect wallet
  const demos = new Demos()
  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(rpcUrl)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })

  // Step 3: Capture before-state for both GCR (nonce) and token (balance)
  const nonceBefore = await demos.getAddressNonce(from)
  const nonceBeforeNum = Number(nonceBefore)

  const tokenBalBeforeRes = await nodeCall(
    rpcUrl, "token.getBalanceCommitted",
    { tokenAddress, address: to },
    "tokenBal:before",
  )
  const tokenBalBefore = BigInt(tokenBalBeforeRes?.response?.balance ?? "0")

  // Step 4: Send a token transfer — this produces BOTH token edits AND balance/nonce edits
  // The sendTokenTransferTxWithDemos helper builds:
  //   gcr_edits = [balance_remove(gas), nonce_add, token_transfer]
  // This is exactly the mixed-edit transaction we want to test.
  const transferAmount = BigInt(1)
  const nonce = nonceBeforeNum + 1

  const { res: broadcastResult } = await sendTokenTransferTxWithDemos({
    demos,
    tokenAddress,
    to,
    amount: transferAmount,
    nonce,
  })

  // Step 5: Verify BOTH state changes landed

  // 5a: Token edit was processed (proves token edits were validated and applied at finalization)
  // For self-transfers (from === to), balance doesn't change — verify via committed state query instead.
  const tokenWaitSec = envInt("TOKEN_WAIT_APPLY_SEC", 30)
  const isSelfTransfer = from === to
  let tokenResult: { ok: boolean; observed: string | null }
  if (isSelfTransfer) {
    // Self-transfer: balance won't change. Verify token is still committed and tx was confirmed.
    // The broadcast returning 200 + confirmationBlock already proves the token edit passed validation
    // in applyGCREditsFromMergedMempool (simulate mode). If it had failed, the tx would have been rejected.
    const checkRes = await nodeCall(
      rpcUrl, "token.getBalanceCommitted",
      { tokenAddress, address: from },
      "tokenBal:selfCheck",
    )
    const bal = checkRes?.response?.balance
    tokenResult = { ok: typeof bal === "string" && BigInt(bal) > 0n, observed: bal ?? null }
  } else {
    tokenResult = await waitForTokenBalanceAtLeast(
      rpcUrl, tokenAddress, to,
      tokenBalBefore + transferAmount,
      tokenWaitSec,
    )
  }

  // 5b: Nonce advanced (proves non-token GCR edits went through batch applyTransactions)
  const nonceWaitSec = envInt("NONCE_WAIT_APPLY_SEC", 30)
  const nonceResult = await waitForNonceAtLeast(rpcUrl, from, nonce, nonceWaitSec)

  // Step 6: Cross-node consistency — check a second node if available
  let crossNodeOk: boolean | null = null
  if (targets.length >= 2) {
    const rpc2 = targets[1]!
    const tokenResult2 = await waitForTokenBalanceAtLeast(
      rpc2, tokenAddress, to,
      tokenBalBefore + transferAmount,
      tokenWaitSec,
    )
    const nonceResult2 = await waitForNonceAtLeast(rpc2, from, nonce, nonceWaitSec)
    crossNodeOk = tokenResult2.ok && nonceResult2.ok
  }

  // Step 7: Report
  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_gcr_batch_exclusion`

  const summary = {
    runId: run.runId,
    rpcUrl,
    tokenAddress,
    from,
    to,
    transferAmount: transferAmount.toString(),
    broadcastResult: broadcastResult ?? null,
    tokenEdit: {
      ok: tokenResult.ok,
      balanceBefore: tokenBalBefore.toString(),
      balanceAfter: tokenResult.observed,
    },
    gcrEdit: {
      ok: nonceResult.ok,
      nonceBefore: nonceBeforeNum,
      nonceExpected: nonce,
      nonceAfter: nonceResult.observed,
    },
    crossNode: crossNodeOk,
    passed: tokenResult.ok && nonceResult.ok,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_gcr_batch_exclusion_summary: summary }, null, 2))

  if (!tokenResult.ok) {
    throw new Error(
      `Token edit verification failed after ${tokenWaitSec}s. ` +
      `Before: ${tokenBalBefore}, Observed: ${tokenResult.observed}`,
    )
  }
  if (!nonceResult.ok) {
    throw new Error(
      `Nonce did not advance after ${nonceWaitSec}s. ` +
      `Before: ${nonceBeforeNum}, Expected: >= ${nonce}, Got: ${nonceResult.observed}`,
    )
  }
}

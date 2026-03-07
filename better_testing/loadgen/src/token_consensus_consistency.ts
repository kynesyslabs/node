import { Demos } from "@kynesyslabs/demosdk/websdk"
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
  waitForCrossNodeTokenConsistency,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"
import { getRunConfig, writeJson } from "./run_io"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type ConsensusWaitReport = {
  ok: boolean
  rounds: number
  timeoutSec: number
  pollMs: number
  durationMs: number
  startedAt: string
  endedAt: string
  start: Record<string, number | null>
  end: Record<string, number | null>
  perNodeOk: Record<string, boolean>
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
}): Promise<ConsensusWaitReport> {
  const startedAt = new Date()
  const deadlineMs = Date.now() + Math.max(1, params.timeoutSec) * 1000
  const pollMs = Math.max(100, Math.floor(params.pollMs))

  const start: Record<string, number | null> = {}
  for (const rpcUrl of params.rpcUrls) {
    start[rpcUrl] = await getLastBlockNumber(rpcUrl, `getLastBlockNumber:start:${rpcUrl}`)
  }

  const perNodeOk: Record<string, boolean> = {}
  const end: Record<string, number | null> = {}

  while (Date.now() < deadlineMs) {
    let allOk = true
    for (const rpcUrl of params.rpcUrls) {
      const current = await getLastBlockNumber(rpcUrl, `getLastBlockNumber:poll:${rpcUrl}`)
      end[rpcUrl] = current
      const base = start[rpcUrl]
      const ok = typeof base === "number" && typeof current === "number" && current >= base + params.rounds
      perNodeOk[rpcUrl] = ok
      if (!ok) allOk = false
    }

    if (allOk) {
      const endedAt = new Date()
      return {
        ok: true,
        rounds: params.rounds,
        timeoutSec: params.timeoutSec,
        pollMs,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        start,
        end,
        perNodeOk,
      }
    }

    await sleep(pollMs)
  }

  const endedAt = new Date()
  for (const rpcUrl of params.rpcUrls) {
    if (rpcUrl in end) continue
    end[rpcUrl] = await getLastBlockNumber(rpcUrl, `getLastBlockNumber:end:${rpcUrl}`)
    const base = start[rpcUrl]
    const current = end[rpcUrl]
    perNodeOk[rpcUrl] = typeof base === "number" && typeof current === "number" && current >= base + params.rounds
  }

  return {
    ok: false,
    rounds: params.rounds,
    timeoutSec: params.timeoutSec,
    pollMs,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    start,
    end,
    perNodeOk,
  }
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

export async function runTokenConsensusConsistency() {
  maybeSilenceConsole()
  const targets = getTokenTargets()
  const rpcUrl = targets[0]!
  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_consensus_consistency requires at least 2 wallets")

  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))

  const walletAddresses = await getWalletAddresses(rpcUrl, wallets.slice(0, 2))
  const owner = walletAddresses[0]!
  const other = walletAddresses[1]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, wallets[0]!, walletAddresses)

  const baselineToken = await nodeCall(rpcUrl, "token.get", { tokenAddress }, "baseline:token.get")
  const baselineSupply = parseBigintOrZero(baselineToken?.response?.state?.totalSupply)
  const baselineOwnerBal = parseBigintOrZero((await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: owner }, "baseline:ownerBal"))?.response?.balance)
  const baselineOtherBal = parseBigintOrZero((await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: other }, "baseline:otherBal"))?.response?.balance)

  const transferAmount = parseBigintOrZero(process.env.TOKEN_TRANSFER_AMOUNT ?? "1")
  const mintAmount = parseBigintOrZero(process.env.TOKEN_MINT_AMOUNT ?? "1")
  const burnAmount = parseBigintOrZero(process.env.TOKEN_BURN_AMOUNT ?? "1")

  const demos = new Demos()
  await demos.connect(rpcUrl)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })

  const currentNonce = await demos.getAddressNonce(owner)
  let nextNonce = Number(currentNonce) + 1

  const transferRes = await sendTokenTransferTxWithDemos({
    demos,
    tokenAddress,
    to: other,
    amount: transferAmount,
    nonce: nextNonce++,
  })

  const mintRes = await sendTokenMintTxWithDemos({
    demos,
    tokenAddress,
    to: other,
    amount: mintAmount,
    nonce: nextNonce++,
  })

  const burnRes = await sendTokenBurnTxWithDemos({
    demos,
    tokenAddress,
    from: owner,
    amount: burnAmount,
    nonce: nextNonce++,
  })

  const consensusRounds = envInt("CONSENSUS_ROUNDS", 1)
  const consensusWait = await waitForConsensusRounds({
    rpcUrls: targets,
    rounds: consensusRounds,
    timeoutSec: envInt("CONSENSUS_TIMEOUT_SEC", 120),
    pollMs: envInt("CONSENSUS_POLL_MS", 500),
  })

  const crossNode = await waitForCrossNodeTokenConsistency({
    rpcUrls: targets,
    tokenAddress,
    addresses: [owner, other],
    timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 180),
    pollMs: envInt("CROSS_NODE_POLL_MS", 500),
  })

  const expected = {
    totalSupply: (baselineSupply + mintAmount - burnAmount).toString(),
    balances: {
      [owner]: (baselineOwnerBal - transferAmount - burnAmount).toString(),
      [other]: (baselineOtherBal + transferAmount + mintAmount).toString(),
    },
  }

  const observed = crossNode?.perNode?.[0]?.snapshot
    ? {
      totalSupply: crossNode.perNode[0].snapshot.state.totalSupply,
      balances: crossNode.perNode[0].snapshot.balances,
    }
    : null

  const expectedOk =
    !!observed &&
    observed.totalSupply === expected.totalSupply &&
    observed.balances?.[owner]?.toString?.() === expected.balances[owner] &&
    observed.balances?.[other]?.toString?.() === expected.balances[other]

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_consensus_consistency`
  const summary = {
    runId: run.runId,
    scenario: "token_consensus_consistency",
    tokenAddress,
    rpcUrls: targets,
    addresses: { owner, other },
    baseline: {
      totalSupply: baselineSupply.toString(),
      balances: { [owner]: baselineOwnerBal.toString(), [other]: baselineOtherBal.toString() },
    },
    actions: {
      transfer: { amount: transferAmount.toString(), res: transferRes?.res ?? null },
      mint: { amount: mintAmount.toString(), res: mintRes?.res ?? null },
      burn: { amount: burnAmount.toString(), res: burnRes?.res ?? null },
    },
    consensusWait,
    crossNode,
    expected,
    observed,
    expectedOk,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_consensus_consistency_summary: summary }, null, 2))

  if (!consensusWait.ok) {
    throw new Error("Consensus wait did not reach required rounds on all nodes")
  }
  if (!crossNode.ok) {
    throw new Error("Cross-node token consistency check failed (token_consensus_consistency)")
  }
  if (!expectedOk) {
    throw new Error("Observed token snapshot does not match expected deltas (token_consensus_consistency)")
  }
}


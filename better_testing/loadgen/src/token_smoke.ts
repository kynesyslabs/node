import { Demos } from "@kynesyslabs/demosdk/websdk"
import {
  maybeSilenceConsole,
  getTokenTargets,
  readWalletMnemonics,
  ensureTokenAndBalances,
  getWalletAddresses,
  nodeCall,
  sendTokenTransferTxWithDemos,
  waitForCrossNodeTokenConsistency,
  waitForCrossNodeHolderPointersMatchBalances,
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

function expectPresentFromBalance(balance: string | null): boolean {
  try {
    return BigInt(balance ?? "0") > 0n
  } catch {
    return false
  }
}

async function waitForRecipientBalanceDelta(params: {
  rpcUrl: string
  tokenAddress: string
  address: string
  before: bigint
  delta: bigint
  timeoutSec: number
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempt = 0
  while (Date.now() < deadline) {
    const res = await nodeCall(
      params.rpcUrl,
      "token.getBalance",
      { tokenAddress: params.tokenAddress, address: params.address },
      `waitBalance:${attempt}`,
    )
    const balRaw = res?.response?.balance
    if (typeof balRaw === "string") {
      try {
        const bal = BigInt(balRaw)
        if (bal >= params.before + params.delta) return bal
      } catch {
        // ignore
      }
    }
    attempt++
    await new Promise(r => setTimeout(r, Math.min(2000, 100 + attempt * 100)))
  }
  return null
}

export async function runTokenSmoke() {
  maybeSilenceConsole()
  const targets = getTokenTargets()
  const rpcUrl = targets[0]!
  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("token_smoke requires at least 2 wallets")

  const walletAddresses = await getWalletAddresses(rpcUrl, wallets.slice(0, 2))
  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, wallets[0]!, walletAddresses)

  const amount = BigInt(process.env.TOKEN_TRANSFER_AMOUNT ?? "1")

  const from = walletAddresses[0]!
  const to = walletAddresses[1]!

  const demos = new Demos()
  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(rpcUrl)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })

  const beforeFrom = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: from }, "beforeFrom")
  const beforeTo = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: to }, "beforeTo")
  const beforeToBig = BigInt(beforeTo?.response?.balance ?? "0")

  const currentNonce = await demos.getAddressNonce(from)
  const nonce = Number(currentNonce) + 1

  const { res } = await sendTokenTransferTxWithDemos({
    demos,
    tokenAddress,
    to,
    amount,
    nonce,
  })

  const appliedTo = await waitForRecipientBalanceDelta({
    rpcUrl,
    tokenAddress,
    address: to,
    before: beforeToBig,
    delta: amount,
    timeoutSec: envInt("TOKEN_WAIT_APPLY_SEC", 30),
  })

  const afterFrom = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: from }, "afterFrom")
  const afterTo = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: to }, "afterTo")

  const crossNodeCheck = envBool("CROSS_NODE_CHECK", true)
  const crossNode = crossNodeCheck
    ? await waitForCrossNodeTokenConsistency({
      rpcUrls: targets,
      tokenAddress,
      addresses: [from, to],
      timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 120),
      pollMs: envInt("CROSS_NODE_POLL_MS", 500),
    })
    : null

  const holderPointerCheck = envBool("HOLDER_POINTER_CHECK", true)
  const expectedPresent =
    crossNode?.ok && crossNode.perNode?.[0]?.snapshot?.balances
      ? {
        [from]: expectPresentFromBalance(crossNode.perNode[0].snapshot.balances[from] ?? null),
        [to]: expectPresentFromBalance(crossNode.perNode[0].snapshot.balances[to] ?? null),
      }
      : {
        [from]: BigInt(afterFrom?.response?.balance ?? "0") > 0n,
        [to]: BigInt(afterTo?.response?.balance ?? "0") > 0n,
      }

  const holderPointers = holderPointerCheck
    ? await waitForCrossNodeHolderPointersMatchBalances({
      rpcUrls: targets,
      tokenAddress,
      expectedPresent,
      timeoutSec: envInt("HOLDER_POINTER_TIMEOUT_SEC", 120),
      pollMs: envInt("HOLDER_POINTER_POLL_MS", 500),
    })
    : null

  const run = getRunConfig()
  const artifactBase = `${run.runDir}/token_smoke`
  const summary = {
    runId: run.runId,
    tokenAddress,
    rpcUrl,
    from,
    to,
    amount: amount.toString(),
    transferResult: res ?? null,
    balances: {
      before: { from: beforeFrom?.response?.balance ?? null, to: beforeTo?.response?.balance ?? null },
      after: { from: afterFrom?.response?.balance ?? null, to: afterTo?.response?.balance ?? null },
    },
    applied: {
      toBalanceReached: appliedTo?.toString?.() ?? null,
      waitApplySec: envInt("TOKEN_WAIT_APPLY_SEC", 30),
    },
    crossNode,
    holderPointers,
    waitForRpcSec: envInt("WAIT_FOR_RPC_SEC", 120),
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_smoke_summary: summary }, null, 2))

  if (crossNodeCheck && crossNode && !crossNode.ok) {
    throw new Error("Cross-node token consistency check failed (token_smoke)")
  }
  if (holderPointerCheck && holderPointers && !holderPointers.ok) {
    throw new Error("Holder-pointer check failed (token_smoke)")
  }
}

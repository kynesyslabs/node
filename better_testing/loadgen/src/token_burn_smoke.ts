import { Demos } from "@kynesyslabs/demosdk/websdk"
import {
  getTokenTargets,
  maybeSilenceConsole,
  nodeCall,
  readWalletMnemonics,
  ensureTokenAndBalances,
  getWalletAddresses,
  sendTokenBurnTxWithDemos,
  waitForCrossNodeTokenConsistency,
  waitForCrossNodeHolderPointersMatchBalances,
  waitForRpcReady,
  waitForTxReady,
} from "./token_shared"
import { getRunConfig, writeJson } from "./framework/io"

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

async function waitForTotalSupplyDecrease(params: {
  rpcUrl: string
  tokenAddress: string
  before: bigint
  delta: bigint
  timeoutSec: number
}) {
  const deadline = Date.now() + Math.max(1, params.timeoutSec) * 1000
  let attempt = 0
  while (Date.now() < deadline) {
    const token = await nodeCall(params.rpcUrl, "token.get", { tokenAddress: params.tokenAddress }, `token.get:${attempt}`)
    const totalRaw = token?.response?.state?.totalSupply
    if (typeof totalRaw === "string") {
      try {
        const total = BigInt(totalRaw)
        if (total <= params.before - params.delta) return total
      } catch {
        // ignore
      }
    }
    attempt++
    await new Promise(r => setTimeout(r, Math.min(2000, 100 + attempt * 100)))
  }
  return null
}

export async function runTokenBurnSmoke() {
  maybeSilenceConsole()
  const targets = getTokenTargets()
  const rpcUrl = targets[0]!
  const wallets = await readWalletMnemonics()
  if (wallets.length < 1) throw new Error("token_burn_smoke requires at least 1 wallet")

  const addrs = await getWalletAddresses(rpcUrl, wallets.slice(0, 1))
  const burner = addrs[0]!

  const { tokenAddress } = await ensureTokenAndBalances(rpcUrl, wallets[0]!, addrs)
  const amount = BigInt(process.env.TOKEN_BURN_AMOUNT ?? "1")

  const demos = new Demos()
  await waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(rpcUrl)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })

  const beforeFrom = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: burner }, "beforeFrom")
  const beforeToken = await nodeCall(rpcUrl, "token.get", { tokenAddress }, "beforeToken")
  const beforeSupply = BigInt(beforeToken?.response?.state?.totalSupply ?? "0")

  const currentNonce = await demos.getAddressNonce(burner)
  const nonce = Number(currentNonce) + 1

  const { res } = await sendTokenBurnTxWithDemos({
    demos,
    tokenAddress,
    from: burner,
    amount,
    nonce,
  })

  const supplyReached = await waitForTotalSupplyDecrease({
    rpcUrl,
    tokenAddress,
    before: beforeSupply,
    delta: amount,
    timeoutSec: envInt("TOKEN_WAIT_APPLY_SEC", 30),
  })

  const afterFrom = await nodeCall(rpcUrl, "token.getBalance", { tokenAddress, address: burner }, "afterFrom")
  const afterToken = await nodeCall(rpcUrl, "token.get", { tokenAddress }, "afterToken")

  const crossNodeCheck = envBool("CROSS_NODE_CHECK", true)
  const crossNode = crossNodeCheck
    ? await waitForCrossNodeTokenConsistency({
      rpcUrls: targets,
      tokenAddress,
      addresses: [burner],
      timeoutSec: envInt("CROSS_NODE_TIMEOUT_SEC", 120),
      pollMs: envInt("CROSS_NODE_POLL_MS", 500),
    })
    : null

  const holderPointerCheck = envBool("HOLDER_POINTER_CHECK", true)
  const expectedPresent =
    crossNode?.ok && crossNode.perNode?.[0]?.snapshot?.balances
      ? {
        [burner]: expectPresentFromBalance(crossNode.perNode[0].snapshot.balances[burner] ?? null),
      }
      : {
        [burner]: BigInt(afterFrom?.response?.balance ?? "0") > 0n,
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
  const artifactBase = `${run.runDir}/token_burn_smoke`
  const summary = {
    runId: run.runId,
    tokenAddress,
    rpcUrl,
    burner,
    amount: amount.toString(),
    burnResult: res ?? null,
    balances: {
      before: beforeFrom?.response?.balance ?? null,
      after: afterFrom?.response?.balance ?? null,
    },
    totalSupply: {
      before: beforeToken?.response?.state?.totalSupply ?? null,
      after: afterToken?.response?.state?.totalSupply ?? null,
      reached: supplyReached?.toString?.() ?? null,
    },
    crossNode,
    holderPointers,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${artifactBase}.summary.json`, summary)
  console.log(JSON.stringify({ token_burn_smoke_summary: summary }, null, 2))

  if (crossNodeCheck && crossNode && !crossNode.ok) {
    throw new Error("Cross-node token consistency check failed (token_burn_smoke)")
  }
  if (holderPointerCheck && holderPointers && !holderPointers.ok) {
    throw new Error("Holder-pointer check failed (token_burn_smoke)")
  }
}

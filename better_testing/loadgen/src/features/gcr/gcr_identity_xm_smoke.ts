import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { Wallet } from "ethers"
import { envInt, normalizeHexAddress, normalizeRpcUrl, nowMs, sleep } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import {
  getTokenTargets,
  maybeSilenceConsole,
  readWalletMnemonics,
  waitForRpcReady,
  waitForTxReady,
} from "../../token_shared"

type XmIdentityProbe = {
  rpcUrl: string
  ok: boolean
  present: boolean
  error: any
}

function hasXmIdentity(value: any, chain: string, subchain: string, targetAddress: string): boolean {
  const entries = value?.response?.identities?.xm?.[chain]?.[subchain]
  if (!Array.isArray(entries)) return false
  const normalizedTarget = normalizeHexAddress(targetAddress)
  return entries.some(item => normalizeHexAddress(item?.address ?? "") === normalizedTarget)
}

async function probeXmIdentity(params: {
  rpcUrl: string
  ownerAddress: string
  chain: string
  subchain: string
  targetAddress: string
}): Promise<XmIdentityProbe> {
  const res = await nodeCall(
    params.rpcUrl,
    "getAddressInfo",
    { address: params.ownerAddress },
    `gcr:getAddressInfo:xm:${params.ownerAddress}`,
    NO_FALLBACKS,
  )
  return {
    rpcUrl: params.rpcUrl,
    ok: res?.result === 200,
    present: hasXmIdentity(res, params.chain, params.subchain, params.targetAddress),
    error: res?.result === 200 ? null : res,
  }
}

async function waitForPresence(params: {
  rpcUrls: string[]
  ownerAddress: string
  chain: string
  subchain: string
  targetAddress: string
  expectPresent: boolean
  timeoutSec: number
  pollMs: number
}): Promise<{ ok: boolean; attempts: number; probes: XmIdentityProbe[] }> {
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  while (nowMs() < deadlineMs) {
    attempts++
    const probes = await Promise.all(
      params.rpcUrls.map(rpcUrl =>
        probeXmIdentity({
          rpcUrl,
          ownerAddress: params.ownerAddress,
          chain: params.chain,
          subchain: params.subchain,
          targetAddress: params.targetAddress,
        }),
      ),
    )
    const ok = probes.every(p => p.ok && p.present === params.expectPresent)
    if (ok) return { ok: true, attempts, probes }
    await sleep(Math.max(50, params.pollMs))
  }

  const probes = await Promise.all(
    params.rpcUrls.map(rpcUrl =>
      probeXmIdentity({
        rpcUrl,
        ownerAddress: params.ownerAddress,
        chain: params.chain,
        subchain: params.subchain,
        targetAddress: params.targetAddress,
      }),
    ),
  )
  return { ok: false, attempts, probes }
}

async function submitXmIdentityTx(params: {
  rpcUrl: string
  mnemonic: string
  operation: "add" | "remove"
  ownerAddress: string
  chain: "evm"
  subchain: "mainnet"
  chainId: number
  xmWallet: Wallet
}) {
  const demos = new Demos()
  await waitForRpcReady(params.rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))
  await waitForTxReady(params.rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))
  await demos.connect(params.rpcUrl)
  await demos.connectWallet(params.mnemonic, { algorithm: "ed25519" })

  const nonce = Number(await demos.getAddressNonce(params.ownerAddress)) + 1
  const timestamp = Date.now()
  const tx = (demos as any).tx.empty()
  tx.content.type = "identity"
  tx.content.to = params.ownerAddress
  tx.content.amount = 0
  tx.content.nonce = nonce
  tx.content.timestamp = timestamp

  const targetAddressCase = (process.env.GCR_IDENTITY_XM_TARGET_CASE ?? "checksum").trim().toLowerCase()
  const targetAddress = targetAddressCase === "lower"
    ? params.xmWallet.address.toLowerCase()
    : params.xmWallet.address
  const payload = params.operation === "add"
    ? {
      method: "identity_assign_from_signature",
      target_identity: {
        chain: params.chain,
        subchain: params.subchain,
        chainId: params.chainId,
        isEVM: true,
        targetAddress,
        signedData: params.ownerAddress,
        signature: await params.xmWallet.signMessage(params.ownerAddress),
        displayAddress: params.xmWallet.address,
      },
    }
    : {
      chain: params.chain,
      subchain: params.subchain,
      targetAddress,
      isEVM: true,
    }

  tx.content.data = [
    "identity",
    {
      method: params.operation === "add" ? "xm_identity_assign" : "xm_identity_remove",
      context: "xm",
      payload,
    },
  ]

  tx.content.from = params.ownerAddress
  tx.content.from_ed25519_address = params.ownerAddress
  const signedTx = await (demos as any).sign(tx)

  const validity = await (demos as any).confirm(signedTx)
  if (validity?.result !== 200 || validity?.response?.data?.valid !== true) {
    throw new Error(`gcr_identity_xm_smoke ${params.operation} confirm failed: ${JSON.stringify(validity)}`)
  }

  const broadcast = await (demos as any).broadcast(validity)
  if (broadcast?.result !== 200) {
    throw new Error(`gcr_identity_xm_smoke ${params.operation} broadcast failed: ${JSON.stringify(broadcast)}`)
  }

  return { nonce, validity, broadcast, targetAddress, signedData: params.ownerAddress }
}

export async function runGcrIdentityXmSmoke() {
  maybeSilenceConsole()

  const rpcUrls = getTokenTargets().map(normalizeRpcUrl)
  await Promise.all(rpcUrls.map(url => waitForRpcReady(url, envInt("WAIT_FOR_RPC_SEC", 120))))
  await Promise.all(rpcUrls.map(url => waitForTxReady(url, envInt("WAIT_FOR_TX_SEC", 120))))

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("gcr_identity_xm_smoke requires at least 1 wallet")

  const rpcBootstrap = rpcUrls[0]!
  const demos = new Demos()
  await demos.connect(rpcBootstrap)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const ownerAddress = uint8ArrayToHex(publicKey)

  const chain = "evm" as const
  const subchain = "mainnet" as const
  const chainId = 1
  const xmWallet = Wallet.createRandom()
  const timeoutSec = envInt("GCR_IDENTITY_XM_TIMEOUT_SEC", 120)
  const pollMs = envInt("GCR_IDENTITY_XM_POLL_MS", 500)

  const before = await Promise.all(
    rpcUrls.map(rpcUrl =>
      probeXmIdentity({
        rpcUrl,
        ownerAddress,
        chain,
        subchain,
        targetAddress: xmWallet.address,
      }),
    ),
  )

  const addTx = await submitXmIdentityTx({
    rpcUrl: rpcBootstrap,
    mnemonic: wallets[0]!,
    operation: "add",
    ownerAddress,
    chain,
    subchain,
    chainId,
    xmWallet,
  })

  const addSettled = await waitForPresence({
    rpcUrls,
    ownerAddress,
    chain,
    subchain,
    targetAddress: addTx.targetAddress,
    expectPresent: true,
    timeoutSec,
    pollMs,
  })

  const removeTx = await submitXmIdentityTx({
    rpcUrl: rpcBootstrap,
    mnemonic: wallets[0]!,
    operation: "remove",
    ownerAddress,
    chain,
    subchain,
    chainId,
    xmWallet,
  })

  const removeSettled = await waitForPresence({
    rpcUrls,
    ownerAddress,
    chain,
    subchain,
    targetAddress: addTx.targetAddress,
    expectPresent: false,
    timeoutSec,
    pollMs,
  })

  const ok = addSettled.ok && removeSettled.ok
  const run = getRunConfig()
  const summary = {
    scenario: "gcr_identity_xm_smoke",
    ok,
    rpcUrls,
    ownerAddress,
    targetIdentity: {
      chain,
      subchain,
      chainId,
      isEVM: true,
      targetAddress: addTx.targetAddress,
      displayAddress: xmWallet.address,
      signedData: addTx.signedData,
    },
    recipe: {
      description: "EVM wallet signs the Demos ed25519 owner address; recovered signer must equal targetAddress",
      verificationRule: "verifyMessage(signedData, signature) === targetAddress",
      targetAddressCase: (process.env.GCR_IDENTITY_XM_TARGET_CASE ?? "checksum").trim().toLowerCase(),
    },
    addTx,
    removeTx,
    before,
    afterAdd: addSettled.probes,
    afterRemove: removeSettled.probes,
    attempts: {
      add: addSettled.attempts,
      remove: removeSettled.attempts,
    },
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/gcr/gcr_identity_xm_smoke.summary.json`, summary)
  console.log(JSON.stringify({ gcr_identity_xm_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("gcr_identity_xm_smoke failed: XM identity state did not converge")
  }
}

if (import.meta.main) {
  await runGcrIdentityXmSmoke()
}

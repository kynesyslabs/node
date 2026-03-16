import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
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

type IdentityProbe = {
  rpcUrl: string
  ok: boolean
  present: boolean
  error: any
}

function hasPqcIdentity(value: any, algorithm: string, identityAddress: string): boolean {
  const entries = value?.response?.identities?.pqc?.[algorithm]
  if (!Array.isArray(entries)) return false
  const normalizedTarget = normalizeHexAddress(identityAddress)
  return entries.some(item => normalizeHexAddress(item?.address ?? "") === normalizedTarget)
}

async function probeIdentity(params: {
  rpcUrl: string
  address: string
  algorithm: string
  identityAddress: string
}): Promise<IdentityProbe> {
  const res = await nodeCall(
    params.rpcUrl,
    "getAddressInfo",
    { address: params.address },
    `gcr:getAddressInfo:identity:${params.address}`,
    NO_FALLBACKS,
  )
  return {
    rpcUrl: params.rpcUrl,
    ok: res?.result === 200,
    present: hasPqcIdentity(res, params.algorithm, params.identityAddress),
    error: res?.result === 200 ? null : res,
  }
}

async function waitForPresence(params: {
  rpcUrls: string[]
  address: string
  algorithm: string
  identityAddress: string
  expectPresent: boolean
  timeoutSec: number
  pollMs: number
}): Promise<{ ok: boolean; attempts: number; probes: IdentityProbe[] }> {
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  while (nowMs() < deadlineMs) {
    attempts++
    const probes = await Promise.all(
      params.rpcUrls.map(rpcUrl =>
        probeIdentity({
          rpcUrl,
          address: params.address,
          algorithm: params.algorithm,
          identityAddress: params.identityAddress,
        }),
      ),
    )
    const ok = probes.every(p => p.ok && p.present === params.expectPresent)
    if (ok) return { ok: true, attempts, probes }
    await sleep(Math.max(50, params.pollMs))
  }

  const probes = await Promise.all(
    params.rpcUrls.map(rpcUrl =>
      probeIdentity({
        rpcUrl,
        address: params.address,
        algorithm: params.algorithm,
        identityAddress: params.identityAddress,
      }),
    ),
  )
  return { ok: false, attempts, probes }
}

function buildUniqueIdentityAddress(): string {
  const nowHex = Math.floor(Date.now() / 1000).toString(16)
  const randomHex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
  const body = (nowHex + randomHex).padStart(64, "0").slice(-64)
  return normalizeHexAddress("0x" + body)
}

async function submitPqcIdentityTx(params: {
  rpcUrl: string
  mnemonic: string
  operation: "add" | "remove"
  ownerAddress: string
  algorithm: string
  identityAddress: string
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
  const identityPayload = params.operation === "add"
    ? {
      algorithm: params.algorithm,
      address: params.identityAddress,
      signature: uint8ArrayToHex(
        (
          await demos.crypto.sign(
            "ed25519",
            new TextEncoder().encode(params.identityAddress),
          )
        ).signature,
      ),
      timestamp,
    }
    : {
      algorithm: params.algorithm,
      address: params.identityAddress,
    }
  tx.content.data = [
    "identity",
    {
      method: params.operation === "add" ? "pqc_identity_assign" : "pqc_identity_remove",
      context: "pqc",
      payload: [identityPayload],
    },
  ]

  tx.content.from = params.ownerAddress
  tx.content.from_ed25519_address = params.ownerAddress
  const signedTx = await (demos as any).sign(tx)

  const validity = await (demos as any).confirm(signedTx)
  if (validity?.result !== 200) {
    throw new Error(`gcr_identity_remove ${params.operation} confirm failed: ${JSON.stringify(validity)}`)
  }

  const broadcast = await (demos as any).broadcast(validity)
  if (broadcast?.result !== 200) {
    throw new Error(`gcr_identity_remove ${params.operation} broadcast failed: ${JSON.stringify(broadcast)}`)
  }

  return { nonce, validity, broadcast }
}

export async function runGcrIdentityRemove() {
  maybeSilenceConsole()

  const rpcUrls = getTokenTargets().map(normalizeRpcUrl)
  await Promise.all(rpcUrls.map(url => waitForRpcReady(url, envInt("WAIT_FOR_RPC_SEC", 120))))
  await Promise.all(rpcUrls.map(url => waitForTxReady(url, envInt("WAIT_FOR_TX_SEC", 120))))

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("gcr_identity_remove requires at least 1 wallet")

  const rpcBootstrap = rpcUrls[0]!
  const demo = new Demos()
  await demo.connect(rpcBootstrap)
  await demo.connectWallet(wallets[0]!, { algorithm: "ed25519" })
  const { publicKey } = await demo.crypto.getIdentity("ed25519")
  const ownerAddress = uint8ArrayToHex(publicKey as Uint8Array)

  const algorithm = "falcon"
  const identityAddress = buildUniqueIdentityAddress()
  const timeoutSec = envInt("GCR_IDENTITY_REMOVE_TIMEOUT_SEC", 120)
  const pollMs = envInt("GCR_IDENTITY_REMOVE_POLL_MS", 500)

  const before = await Promise.all(
    rpcUrls.map(rpcUrl =>
      probeIdentity({
        rpcUrl,
        address: ownerAddress,
        algorithm,
        identityAddress,
      }),
    ),
  )

  const addTx = await submitPqcIdentityTx({
    rpcUrl: rpcBootstrap,
    mnemonic: wallets[0]!,
    operation: "add",
    ownerAddress,
    algorithm,
    identityAddress,
  })

  const addSettled = await waitForPresence({
    rpcUrls,
    address: ownerAddress,
    algorithm,
    identityAddress,
    expectPresent: true,
    timeoutSec,
    pollMs,
  })

  const removeTx = await submitPqcIdentityTx({
    rpcUrl: rpcBootstrap,
    mnemonic: wallets[0]!,
    operation: "remove",
    ownerAddress,
    algorithm,
    identityAddress,
  })

  const removeSettled = await waitForPresence({
    rpcUrls,
    address: ownerAddress,
    algorithm,
    identityAddress,
    expectPresent: false,
    timeoutSec,
    pollMs,
  })

  const ok = addSettled.ok && removeSettled.ok
  const run = getRunConfig()
  const summary = {
    scenario: "gcr_identity_remove",
    ok,
    rpcUrls,
    ownerAddress,
    identityAddress,
    algorithm,
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

  writeJson(`${run.runDir}/features/gcr/gcr_identity_remove.summary.json`, summary)
  console.log(JSON.stringify({ gcr_identity_remove_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("gcr_identity_remove failed: identity add/remove did not converge on all nodes")
  }
}

if (import.meta.main) {
  await runGcrIdentityRemove()
}

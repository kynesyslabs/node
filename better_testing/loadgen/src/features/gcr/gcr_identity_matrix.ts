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

type MatrixStep = {
  label: string
  algorithm: string
  identityAddress: string
  operation: "add" | "remove"
  expectSuccess: boolean
  expectMessageLike?: string
  outcome: {
    ok: boolean
    resultCode: number | null
    payload: any
  }
}

function buildIdentityAddress(seed: string): string {
  const body = seed.replace(/[^0-9a-f]/gi, "").padStart(64, "0").slice(-64)
  return normalizeHexAddress("0x" + body)
}

async function getPqcPresenceByNode(params: {
  rpcUrls: string[]
  ownerAddress: string
  algorithm: string
  identityAddress: string
}) {
  const out: Record<string, boolean> = {}
  const target = normalizeHexAddress(params.identityAddress)
  for (const rpcUrl of params.rpcUrls) {
    const res = await nodeCall(rpcUrl, "getAddressInfo", { address: params.ownerAddress }, `gcr:matrix:getAddressInfo:${params.ownerAddress}`, NO_FALLBACKS)
    if (res?.result !== 200) {
      out[rpcUrl] = false
      continue
    }
    const list = res?.response?.identities?.pqc?.[params.algorithm]
    if (!Array.isArray(list)) {
      out[rpcUrl] = false
      continue
    }
    out[rpcUrl] = list.some((item: any) => normalizeHexAddress(item?.address ?? "") === target)
  }
  return out
}

async function waitForPresence(params: {
  rpcUrls: string[]
  ownerAddress: string
  algorithm: string
  identityAddress: string
  expectPresent: boolean
  timeoutSec: number
  pollMs: number
}) {
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  while (nowMs() < deadlineMs) {
    const byNode = await getPqcPresenceByNode(params)
    const ok = Object.values(byNode).every(v => v === params.expectPresent)
    if (ok) return { ok: true, byNode }
    await sleep(Math.max(50, params.pollMs))
  }
  const byNode = await getPqcPresenceByNode(params)
  return { ok: false, byNode }
}

async function submitPqcTx(params: {
  demos: Demos
  ownerAddress: string
  algorithm: string
  identityAddress: string
  operation: "add" | "remove"
}) {
  const nonce = Number(await params.demos.getAddressNonce(params.ownerAddress)) + 1
  const timestamp = Date.now()
  const tx = (params.demos as any).tx.empty()
  tx.content.type = "identity"
  tx.content.to = params.ownerAddress
  tx.content.amount = 0
  tx.content.nonce = nonce
  tx.content.timestamp = timestamp

  const payload = params.operation === "add"
    ? [{
      algorithm: params.algorithm,
      address: params.identityAddress,
      signature: uint8ArrayToHex(
        (
          await params.demos.crypto.sign(
            "ed25519",
            new TextEncoder().encode(params.identityAddress),
          )
        ).signature,
      ),
      timestamp,
    }]
    : [{ algorithm: params.algorithm, address: params.identityAddress }]

  tx.content.data = [
    "identity",
    {
      method: params.operation === "add" ? "pqc_identity_assign" : "pqc_identity_remove",
      context: "pqc",
      payload,
    },
  ]
  tx.content.from = params.ownerAddress
  tx.content.from_ed25519_address = params.ownerAddress

  const signedTx = await (params.demos as any).sign(tx)
  const validity = await (params.demos as any).confirm(signedTx)
  if (validity?.result !== 200 || validity?.response?.data?.valid !== true) {
    return { ok: false, resultCode: validity?.result ?? null, payload: validity }
  }
  const broadcast = await (params.demos as any).broadcast(validity)
  return {
    ok: broadcast?.result === 200,
    resultCode: typeof broadcast?.result === "number" ? broadcast.result : null,
    payload: broadcast,
  }
}

export async function runGcrIdentityMatrix() {
  maybeSilenceConsole()

  const rpcUrls = getTokenTargets().map(normalizeRpcUrl)
  await Promise.all(rpcUrls.map(url => waitForRpcReady(url, envInt("WAIT_FOR_RPC_SEC", 120))))
  await Promise.all(rpcUrls.map(url => waitForTxReady(url, envInt("WAIT_FOR_TX_SEC", 120))))

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("gcr_identity_matrix requires at least 1 wallet")

  const rpcBootstrap = rpcUrls[0]!
  const demos = new Demos()
  await demos.connect(rpcBootstrap)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const ownerAddress = uint8ArrayToHex(publicKey as Uint8Array)

  const timeoutSec = envInt("GCR_IDENTITY_MATRIX_TIMEOUT_SEC", 60)
  const pollMs = envInt("GCR_IDENTITY_MATRIX_POLL_MS", 300)

  const addresses = {
    falcon: buildIdentityAddress("fa1c0n" + Date.now().toString(16)),
    "ml-dsa": buildIdentityAddress("m1d5a" + (Date.now() + 1).toString(16)),
  } as const

  const steps: MatrixStep[] = [
    {
      label: "falcon:add:new",
      algorithm: "falcon",
      identityAddress: addresses.falcon,
      operation: "add",
      expectSuccess: true,
      outcome: { ok: false, resultCode: null, payload: null },
    },
    {
      label: "falcon:add:duplicate",
      algorithm: "falcon",
      identityAddress: addresses.falcon,
      operation: "add",
      expectSuccess: false,
      expectMessageLike: "already exists",
      outcome: { ok: false, resultCode: null, payload: null },
    },
    {
      label: "falcon:remove:existing",
      algorithm: "falcon",
      identityAddress: addresses.falcon,
      operation: "remove",
      expectSuccess: true,
      outcome: { ok: false, resultCode: null, payload: null },
    },
    {
      label: "falcon:remove:missing",
      algorithm: "falcon",
      identityAddress: addresses.falcon,
      operation: "remove",
      expectSuccess: false,
      expectMessageLike: "not found",
      outcome: { ok: false, resultCode: null, payload: null },
    },
    {
      label: "ml-dsa:add:new",
      algorithm: "ml-dsa",
      identityAddress: addresses["ml-dsa"],
      operation: "add",
      expectSuccess: true,
      outcome: { ok: false, resultCode: null, payload: null },
    },
    {
      label: "ml-dsa:remove:existing",
      algorithm: "ml-dsa",
      identityAddress: addresses["ml-dsa"],
      operation: "remove",
      expectSuccess: true,
      outcome: { ok: false, resultCode: null, payload: null },
    },
  ]

  const stepReports: Array<MatrixStep & { presence?: any; stepOk: boolean; reason?: string }> = []
  for (const step of steps) {
    const outcome = await submitPqcTx({
      demos,
      ownerAddress,
      algorithm: step.algorithm,
      identityAddress: step.identityAddress,
      operation: step.operation,
    })
    step.outcome = outcome

    let stepOk = step.expectSuccess ? outcome.ok : !outcome.ok
    let reason = ""

    if (!step.expectSuccess && step.expectMessageLike) {
      const payloadText = JSON.stringify(outcome.payload ?? {})
      if (!payloadText.toLowerCase().includes(step.expectMessageLike.toLowerCase())) {
        stepOk = false
        reason = `expected failure message containing '${step.expectMessageLike}', got ${payloadText}`
      }
    }

    let presence: any = null
    if (step.expectSuccess) {
      const expectPresent = step.operation === "add"
      presence = await waitForPresence({
        rpcUrls,
        ownerAddress,
        algorithm: step.algorithm,
        identityAddress: step.identityAddress,
        expectPresent,
        timeoutSec,
        pollMs,
      })
      if (!presence.ok) {
        stepOk = false
        reason = `cross-node presence mismatch after ${step.label}`
      }
    }

    stepReports.push({ ...step, presence, stepOk, reason: reason || undefined })
  }

  const finalPresence = {
    falcon: await getPqcPresenceByNode({
      rpcUrls,
      ownerAddress,
      algorithm: "falcon",
      identityAddress: addresses.falcon,
    }),
    "ml-dsa": await getPqcPresenceByNode({
      rpcUrls,
      ownerAddress,
      algorithm: "ml-dsa",
      identityAddress: addresses["ml-dsa"],
    }),
  }

  const finalAbsent =
    Object.values(finalPresence.falcon).every(v => v === false) &&
    Object.values(finalPresence["ml-dsa"]).every(v => v === false)

  const ok = stepReports.every(s => s.stepOk) && finalAbsent

  const run = getRunConfig()
  const summary = {
    scenario: "gcr_identity_matrix",
    ok,
    rpcUrls,
    ownerAddress,
    timeoutSec,
    pollMs,
    addresses,
    steps: stepReports,
    finalPresence,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/gcr/gcr_identity_matrix.summary.json`, summary)
  console.log(JSON.stringify({ gcr_identity_matrix_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("gcr_identity_matrix failed: one or more matrix expectations did not hold")
  }
}

if (import.meta.main) {
  await runGcrIdentityMatrix()
}

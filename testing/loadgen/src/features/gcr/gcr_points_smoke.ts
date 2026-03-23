import { envInt, normalizeRpcUrl, nowMs, sleep } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { nodeCall, NO_FALLBACKS, rpcPost } from "../../framework/rpc"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import {
  getWalletAddresses,
  getTokenTargets,
  maybeSilenceConsole,
  readWalletMnemonics,
  waitForRpcReady,
} from "../../token_shared"

type PointsProbe = {
  rpcUrl: string
  ok: boolean
  points: number | null
  error: any
}

type SignedRpcHeaders = {
  identity: string
  signature: string
}

function readTotalPoints(value: any): number | null {
  const raw = value?.response?.points?.totalPoints
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null
}

async function maybeBuildSudoHeaders(): Promise<SignedRpcHeaders | null> {
  const explicitMnemonic = (process.env.SUDO_MNEMONIC ?? "").trim()
  const walletFile = (process.env.SUDO_WALLET_FILE ?? "").trim()
  let mnemonic = explicitMnemonic

  if (!mnemonic && walletFile) {
    const dir = (process.env.MNEMONICS_DIR ?? "testing/devnet/identities").replace(/\/+$/, "")
    mnemonic = (await Bun.file(`${dir}/${walletFile}`).text()).trim()
  }

  if (!mnemonic) return null

  const rpcUrl = normalizeRpcUrl((process.env.SUDO_RPC_URL ?? process.env.TARGETS?.split(",")[0] ?? "http://node-1:53551").trim())
  const demos = new Demos()
  await demos.connect(rpcUrl)
  await demos.connectWallet(mnemonic, { algorithm: "ed25519" })
  const identity = await demos.crypto.getIdentity("ed25519")
  const publicKeyHex = uint8ArrayToHex(identity.publicKey as Uint8Array)
  const signatureHex = uint8ArrayToHex(
    (await demos.crypto.sign("ed25519", new TextEncoder().encode(publicKeyHex))).signature,
  )

  return {
    identity: `ed25519:${publicKeyHex}`,
    signature: signatureHex,
  }
}

async function probePoints(rpcUrl: string, address: string): Promise<PointsProbe> {
  const res = await nodeCall(rpcUrl, "getAddressInfo", { address }, `gcr:getAddressInfo:points:${address}`, NO_FALLBACKS)
  const points = readTotalPoints(res)
  return {
    rpcUrl,
    ok: res?.result === 200 && points !== null,
    points,
    error: res?.result === 200 ? null : res,
  }
}

async function waitForPointsAtLeast(params: {
  rpcUrls: string[]
  address: string
  minPoints: number
  timeoutSec: number
  pollMs: number
}): Promise<{ ok: boolean; attempts: number; probes: PointsProbe[] }> {
  const deadlineMs = nowMs() + Math.max(1, params.timeoutSec) * 1000
  let attempts = 0
  while (nowMs() < deadlineMs) {
    attempts++
    const probes = await Promise.all(params.rpcUrls.map(rpcUrl => probePoints(rpcUrl, params.address)))
    const ok = probes.every(p => p.ok && (p.points ?? -1) >= params.minPoints)
    if (ok) return { ok: true, attempts, probes }
    await sleep(Math.max(50, params.pollMs))
  }
  const probes = await Promise.all(params.rpcUrls.map(rpcUrl => probePoints(rpcUrl, params.address)))
  return { ok: false, attempts, probes }
}

export async function runGcrPointsSmoke() {
  maybeSilenceConsole()

  const rpcUrls = getTokenTargets().map(normalizeRpcUrl)
  await Promise.all(rpcUrls.map(url => waitForRpcReady(url, envInt("WAIT_FOR_RPC_SEC", 120))))

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("gcr_points_smoke requires at least 1 wallet")

  const rpcBootstrap = rpcUrls[0]!
  const addresses = await getWalletAddresses(rpcBootstrap, [wallets[0]!])
  const recipientAddress = addresses[0]!

  const pointsDelta = Math.max(1, envInt("GCR_POINTS_DELTA", 1))
  const timeoutSec = envInt("GCR_POINTS_TIMEOUT_SEC", 120)
  const pollMs = envInt("GCR_POINTS_POLL_MS", 500)

  const before = await Promise.all(rpcUrls.map(rpcUrl => probePoints(rpcUrl, recipientAddress)))
  const baseline = before
    .map(b => b.points)
    .filter((v): v is number => typeof v === "number")
    .reduce((max, value) => Math.max(max, value), 0)
  const expectedMin = baseline + pointsDelta

  const awardRequest = {
    method: "awardPoints",
    params: [{ message: [{ address: recipientAddress, points: pointsDelta }] }],
  }
  const sudoHeaders = await maybeBuildSudoHeaders()
  const awardRes = await rpcPost(rpcBootstrap, awardRequest, sudoHeaders ? { headers: sudoHeaders } : {})
  const awardJson = awardRes.json
  const unauthorized = awardJson?.result === 401

  const settled = unauthorized
    ? { ok: true, attempts: 0, probes: before }
    : await waitForPointsAtLeast({
      rpcUrls,
      address: recipientAddress,
      minPoints: expectedMin,
      timeoutSec,
      pollMs,
    })

  if (!unauthorized && awardJson?.result !== 200) {
    throw new Error(`gcr_points_smoke awardPoints failed: ${JSON.stringify(awardJson)}`)
  }

  const ok = settled.ok
  const run = getRunConfig()
  const summary = {
    scenario: "gcr_points_smoke",
    ok,
    skipped: unauthorized,
    skipReason: unauthorized ? "awardPoints requires SUDO sender on this node" : null,
    rpcUrls,
    recipientAddress,
    pointsDelta,
    baseline,
    expectedMin,
    awardRequest,
    authenticatedAs: sudoHeaders?.identity ?? null,
    awardResponse: awardJson,
    attempts: settled.attempts,
    before,
    after: settled.probes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/gcr/gcr_points_smoke.summary.json`, summary)
  console.log(JSON.stringify({ gcr_points_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("gcr_points_smoke failed: points did not reach expected minimum on all nodes")
  }
}

if (import.meta.main) {
  await runGcrPointsSmoke()
}

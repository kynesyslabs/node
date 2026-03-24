import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole } from "../../token_shared"
import {
  buildUniqueHex64,
  getHealthyZkTargets,
  getNullifierStatus,
  getZkTargets,
  INVALID_GROTH16_PROOF,
  verifyProofRpc,
} from "./shared"

export async function runZkAttestationSmoke() {
  maybeSilenceConsole()

  const rpcUrls = getZkTargets()
  if (rpcUrls.length === 0) throw new Error("zk_attestation_smoke requires at least one RPC target")

  const health = await getHealthyZkTargets(rpcUrls)
  const run = getRunConfig()
  if (health.healthyRpcUrls.length === 0) {
    const summary = {
      scenario: "zk_attestation_smoke",
      ok: true,
      skipped: true,
      skipReason: "no healthy ZK RPC targets available",
      rpcUrls,
      probes: health.probes,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/zk/zk_attestation_smoke.summary.json`, summary)
    console.log(JSON.stringify({ zk_attestation_smoke_summary: summary }, null, 2))
    return
  }

  const healthyRpcUrls = health.healthyRpcUrls
  const nullifierHash = buildUniqueHex64("attestation")
  const root = health.probes.find(probe => probe.rpcUrl === healthyRpcUrls[0])?.merkleRoot?.rootHash ?? "0"
  const publicSignals = [nullifierHash, root, "loadgen-smoke"]
  const before = await Promise.all(
    healthyRpcUrls.map(async rpcUrl => ({
      rpcUrl,
      status: await getNullifierStatus(rpcUrl, nullifierHash),
    })),
  )
  const proofResults = await Promise.all(
    healthyRpcUrls.map(async rpcUrl => ({
      rpcUrl,
      result: await verifyProofRpc(rpcUrl, INVALID_GROTH16_PROOF, publicSignals),
    })),
  )
  const after = await Promise.all(
    healthyRpcUrls.map(async rpcUrl => ({
      rpcUrl,
      status: await getNullifierStatus(rpcUrl, nullifierHash),
    })),
  )

  const rejectedOnAllNodes = proofResults.every(entry => {
    const body = entry.result.json
    return body?.result === 400 && body?.response?.valid === false
  })
  const nullifierUntouched = [...before, ...after].every(entry => entry.status.status === 200 && entry.status.json?.used === false)
  const ok = rejectedOnAllNodes && nullifierUntouched

  const summary = {
    scenario: "zk_attestation_smoke",
    ok,
    skipped: false,
    rpcUrls,
    healthyRpcUrls,
    unhealthyRpcUrls: health.unhealthyRpcUrls,
    probes: health.probes,
    invalidProofSignals: {
      nullifierHash,
      merkleRoot: root,
      context: publicSignals[2],
    },
    before,
    proofResults,
    after,
    timeoutSec: envInt("WAIT_FOR_RPC_SEC", 120),
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/zk/zk_attestation_smoke.summary.json`, summary)
  console.log(JSON.stringify({ zk_attestation_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("zk_attestation_smoke failed: invalid proof was not rejected cleanly on all healthy nodes")
  }
}

if (import.meta.main) {
  await runZkAttestationSmoke()
}

import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole } from "../../token_shared"
import { getHealthyZkTargets, getMerkleProof, getZkTargets, verifyMerkleInclusion } from "./shared"

export async function runZkMerkleInclusion() {
  maybeSilenceConsole()

  const rpcUrls = getZkTargets()
  if (rpcUrls.length === 0) throw new Error("zk_merkle_inclusion requires at least one RPC target")

  const health = await getHealthyZkTargets(rpcUrls)
  const run = getRunConfig()
  if (health.healthyRpcUrls.length === 0) {
    const summary = {
      scenario: "zk_merkle_inclusion",
      ok: true,
      skipped: true,
      skipReason: "no healthy ZK RPC targets available",
      rpcUrls,
      probes: health.probes,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/zk/zk_merkle_inclusion.summary.json`, summary)
    console.log(JSON.stringify({ zk_merkle_inclusion_summary: summary }, null, 2))
    return
  }

  const commitment = (process.env.ZK_COMMITMENT ?? "").trim().toLowerCase()
  const maxLeafCount = Math.max(...health.probes.map(probe => probe.merkleRoot?.leafCount ?? 0))
  if (!commitment) {
    const summary = {
      scenario: "zk_merkle_inclusion",
      ok: true,
      skipped: true,
      skipReason: maxLeafCount === 0
        ? "Merkle tree is empty on all healthy nodes; no commitment is available for inclusion proof validation"
        : "set ZK_COMMITMENT to validate Merkle inclusion for a known commitment",
      rpcUrls,
      healthyRpcUrls: health.healthyRpcUrls,
      unhealthyRpcUrls: health.unhealthyRpcUrls,
      probes: health.probes,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/zk/zk_merkle_inclusion.summary.json`, summary)
    console.log(JSON.stringify({ zk_merkle_inclusion_summary: summary }, null, 2))
    return
  }

  const proofs = await Promise.all(
    health.healthyRpcUrls.map(async rpcUrl => ({
      rpcUrl,
      response: await getMerkleProof(rpcUrl, commitment),
    })),
  )

  const verified = await Promise.all(proofs.map(async entry => {
    if (!entry.response.ok || entry.response.status !== 200 || !entry.response.json?.proof) {
      return {
        rpcUrl: entry.rpcUrl,
        ok: false,
        reason: entry.response.json?.error ?? `HTTP ${entry.response.status}`,
      }
    }
    const proof = entry.response.json.proof
    return {
      rpcUrl: entry.rpcUrl,
      ok: await verifyMerkleInclusion(commitment, proof),
      root: proof.root,
      leafIndex: proof.leafIndex,
      siblingDepth: Array.isArray(proof.siblings) ? proof.siblings.length : 0,
      pathDepth: Array.isArray(proof.pathIndices) ? proof.pathIndices.length : 0,
    }
  }))

  const ok = verified.every(entry => entry.ok)
  const summary = {
    scenario: "zk_merkle_inclusion",
    ok,
    skipped: false,
    rpcUrls,
    healthyRpcUrls: health.healthyRpcUrls,
    unhealthyRpcUrls: health.unhealthyRpcUrls,
    probes: health.probes,
    commitment,
    proofs,
    verified,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/zk/zk_merkle_inclusion.summary.json`, summary)
  console.log(JSON.stringify({ zk_merkle_inclusion_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("zk_merkle_inclusion failed: proof endpoint did not return a valid inclusion proof on all healthy nodes")
  }
}

if (import.meta.main) {
  await runZkMerkleInclusion()
}

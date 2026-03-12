import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { envInt, sleep } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole, readWalletMnemonics, waitForRpcReady, waitForTxReady } from "../../token_shared"
import { buildUniqueHex64, getHealthyZkTargets, getMerkleProof, getMerkleRoot, getZkTargets, verifyMerkleInclusion } from "./shared"

async function waitForLeafCountIncrease(rpcUrls: string[], baseline: number, timeoutSec: number, pollMs: number) {
  const deadlineMs = Date.now() + Math.max(1, timeoutSec) * 1000
  let attempts = 0
  while (Date.now() < deadlineMs) {
    attempts++
    const roots = await Promise.all(rpcUrls.map(async rpcUrl => ({ rpcUrl, root: await getMerkleRoot(rpcUrl) })))
    const ok = roots.every(entry => entry.root.status === 200 && Number(entry.root.json?.leafCount ?? -1) >= baseline + 1)
    if (ok) return { ok: true, attempts, roots }
    await sleep(Math.max(100, pollMs))
  }
  const roots = await Promise.all(rpcUrls.map(async rpcUrl => ({ rpcUrl, root: await getMerkleRoot(rpcUrl) })))
  return { ok: false, attempts, roots }
}

export async function runZkCommitmentSmoke() {
  maybeSilenceConsole()

  const rpcUrls = getZkTargets()
  if (rpcUrls.length === 0) throw new Error("zk_commitment_smoke requires at least one RPC target")

  const health = await getHealthyZkTargets(rpcUrls)
  const run = getRunConfig()
  if (health.healthyRpcUrls.length === 0) {
    const summary = {
      scenario: "zk_commitment_smoke",
      ok: true,
      skipped: true,
      skipReason: "no healthy ZK RPC targets available",
      rpcUrls,
      probes: health.probes,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/zk/zk_commitment_smoke.summary.json`, summary)
    console.log(JSON.stringify({ zk_commitment_smoke_summary: summary }, null, 2))
    return
  }

  const healthyRpcUrls = health.healthyRpcUrls
  const bootstrapRpc = healthyRpcUrls[0]!
  await Promise.all(healthyRpcUrls.map(rpcUrl => waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))))
  await Promise.all(healthyRpcUrls.map(rpcUrl => waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))))

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("zk_commitment_smoke requires at least one wallet mnemonic")

  const demos = new Demos()
  await demos.connect(bootstrapRpc)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const ownerAddress = uint8ArrayToHex(publicKey)
  const nonce = Number(await demos.getAddressNonce(ownerAddress)) + 1
  const timestamp = Date.now()
  const commitmentHash = buildUniqueHex64("commit")
  const provider = process.env.ZK_PROVIDER ?? "github"
  const rootsBefore = await Promise.all(
    healthyRpcUrls.map(async rpcUrl => ({ rpcUrl, root: await getMerkleRoot(rpcUrl) })),
  )
  const maxLeafCountBefore = Math.max(...rootsBefore.map(entry => Number(entry.root.json?.leafCount ?? 0)))

  const tx = (demos as any).tx.empty()
  tx.content.type = "identity"
  tx.content.to = ownerAddress
  tx.content.amount = 0
  tx.content.nonce = nonce
  tx.content.timestamp = timestamp
  tx.content.data = [
    "identity",
    {
      method: "zk_commitmentadd",
      context: "zk",
      payload: [{
        commitment_hash: commitmentHash,
        provider,
        timestamp,
      }],
    },
  ]
  tx.content.from = ownerAddress
  tx.content.from_ed25519_address = ownerAddress

  const signedTx = await (demos as any).sign(tx)
  const validity = await (demos as any).confirm(signedTx)
  const shapedTx = validity?.response?.data?.transaction
  const shapedIdentityEdit = shapedTx?.content?.gcr_edits?.find((edit: any) => edit?.type === "identity")
  const malformedGcrEditDetected =
    validity?.result === 200 &&
    (!shapedIdentityEdit ||
      shapedIdentityEdit.operation !== "zk_commitmentadd" ||
      shapedIdentityEdit.context !== "zk" ||
      shapedIdentityEdit.data == null)

  let broadcast: any = null
  let settle: any = null
  let proofResponses: any[] = []
  let verifiedProofs: any[] = []

  if (!malformedGcrEditDetected && validity?.result === 200) {
    broadcast = await (demos as any).broadcast(validity)
    if (broadcast?.result === 200) {
      settle = await waitForLeafCountIncrease(
        healthyRpcUrls,
        maxLeafCountBefore,
        envInt("ZK_COMMITMENT_TIMEOUT_SEC", 120),
        envInt("ZK_COMMITMENT_POLL_MS", 500),
      )
      if (settle.ok) {
        proofResponses = await Promise.all(
          healthyRpcUrls.map(async rpcUrl => ({
            rpcUrl,
            response: await getMerkleProof(rpcUrl, commitmentHash),
          })),
        )
        verifiedProofs = await Promise.all(proofResponses.map(async entry => {
          if (entry.response.status !== 200 || !entry.response.json?.proof) {
            return { rpcUrl: entry.rpcUrl, ok: false, error: entry.response.json?.error ?? `HTTP ${entry.response.status}` }
          }
          return {
            rpcUrl: entry.rpcUrl,
            ok: await verifyMerkleInclusion(commitmentHash, entry.response.json.proof),
            proof: entry.response.json.proof,
          }
        }))
      }
    }
  }

  const ok =
    validity?.result === 200 &&
    !malformedGcrEditDetected &&
    broadcast?.result === 200 &&
    settle?.ok === true &&
    verifiedProofs.length === healthyRpcUrls.length &&
    verifiedProofs.every(entry => entry.ok)

  const summary = {
    scenario: "zk_commitment_smoke",
    ok,
    skipped: false,
    rpcUrls,
    healthyRpcUrls,
    unhealthyRpcUrls: health.unhealthyRpcUrls,
    probes: health.probes,
    ownerAddress,
    provider,
    commitmentHash,
    rootsBefore,
    validity,
    shapedIdentityEdit,
    malformedGcrEditDetected,
    broadcast,
    settle,
    proofResponses,
    verifiedProofs,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/zk/zk_commitment_smoke.summary.json`, summary)
  console.log(JSON.stringify({ zk_commitment_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("zk_commitment_smoke failed: ZK commitment transaction path did not produce a valid commitment insertion flow")
  }
}

if (import.meta.main) {
  await runZkCommitmentSmoke()
}

// A real identity attestation through the network: the SDK registers a
// commitment, proves membership with the ceremony's final key, and every node
// must apply the attestation, while a forged proof and a replay of the same
// nullifier are refused. Confirm checks only the signature; the proof is
// checked when the transaction is broadcast and again when its block applies.
import { randomBytes } from "node:crypto"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex, zK } from "@kynesyslabs/demosdk/encryption"
import { envInt, sleep } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole, readWalletMnemonics, waitForRpcReady, waitForTxReady } from "../../token_shared"
import { getHealthyZkTargets, getMerkleProof, getMerkleRoot, getNullifierStatus, getZkTargets } from "./shared"

const httpBase = (rpcUrl: string) => rpcUrl.replace(/\/+$/, "")

async function pollAll<T>(
  rpcUrls: string[],
  probe: (rpcUrl: string) => Promise<T>,
  done: (results: T[]) => boolean,
  timeoutSec: number,
) {
  const started = Date.now()
  let results: T[] = []
  while (Date.now() - started < timeoutSec * 1000) {
    results = await Promise.all(rpcUrls.map(probe))
    if (done(results)) return { ok: true, ms: Date.now() - started, results }
    await sleep(envInt("ZK_POLL_MS", 500))
  }
  return { ok: false, ms: Date.now() - started, results }
}

async function submitIdentity(demos: Demos, owner: string, data: unknown, broadcast: boolean) {
  const tx = (demos as any).tx.empty()
  tx.content.type = "identity"
  tx.content.to = owner
  tx.content.from = owner
  tx.content.from_ed25519_address = owner
  tx.content.amount = 0
  tx.content.nonce = Number(await demos.getAddressNonce(owner)) + 1
  tx.content.timestamp = Date.now()
  tx.content.data = ["identity", data]
  const validity = await (demos as any).confirm(await (demos as any).sign(tx))
  if (!broadcast || validity?.result !== 200) return { validity, broadcast: null }
  return { validity, broadcast: await (demos as any).broadcast(validity) }
}

// Refused for the stated reason, not for an unrelated error such as a nonce clash.
const refusedFor = (r: { validity: any; broadcast: any }, reason: RegExp) =>
  r.validity?.result === 200 && r.broadcast?.result !== 200 && reason.test(String(r.broadcast?.extra?.message ?? ""))

const text = (v: unknown) => (typeof v === "string" ? v : null)
const brief = (r: any) => ({
  result: r?.result ?? null,
  message: text(r?.response?.message) ?? text(r?.response?.data?.message) ?? text(r?.response),
  extra: text(r?.extra?.message),
})

export async function runZkIdentityE2e() {
  maybeSilenceConsole()
  const rpcUrls = getZkTargets()
  if (rpcUrls.length === 0) throw new Error("zk_identity_e2e requires at least one RPC target")
  await Promise.all(rpcUrls.map(rpcUrl => waitForRpcReady(rpcUrl, envInt("WAIT_FOR_RPC_SEC", 120))))
  await Promise.all(rpcUrls.map(rpcUrl => waitForTxReady(rpcUrl, envInt("WAIT_FOR_TX_SEC", 120))))
  const health = await getHealthyZkTargets(rpcUrls)
  if (health.healthyRpcUrls.length !== rpcUrls.length) {
    throw new Error(`zk_identity_e2e needs every target healthy: ${JSON.stringify(health.probes)}`)
  }
  const run = getRunConfig()
  const timeoutSec = envInt("ZK_E2E_TIMEOUT_SEC", 180)

  const wallets = await readWalletMnemonics()
  if (wallets.length === 0) throw new Error("zk_identity_e2e requires a wallet mnemonic")
  const demos = new Demos()
  await demos.connect(rpcUrls[0]!)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const owner = uint8ArrayToHex(publicKey as Uint8Array)

  const tag = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`
  const provider = process.env.ZK_PROVIDER ?? "github"
  const identity = new zK.identity.ZKIdentity(`${provider}:loadgen-${tag}`)
  const commitment = identity.getCommitment()
  const context = `loadgen:${tag}`
  const checks: Record<string, boolean> = {}

  // 1. Commitment enters the tree on every node, with one root everywhere.
  const commit = await submitIdentity(
    demos,
    owner,
    { method: "zk_commitmentadd", context: "zk", payload: [{ commitment_hash: commitment, provider, timestamp: Date.now() }] },
    true,
  )
  checks.commitment_accepted = commit.validity?.result === 200 && commit.broadcast?.result === 200
  const inTree = checks.commitment_accepted
    ? await pollAll(rpcUrls, rpcUrl => getMerkleProof(rpcUrl, commitment), rs => rs.every(r => r.status === 200), timeoutSec)
    : { ok: false, ms: 0, results: [] }
  checks.commitment_in_tree_on_every_node = inTree.ok
  const roots = await pollAll(
    rpcUrls,
    getMerkleRoot,
    rs => rs.every(r => r.status === 200 && r.json?.rootHash === rs[0]!.json?.rootHash),
    timeoutSec,
  )
  checks.same_root_on_every_node = roots.ok

  // 2. The SDK proves membership and checks the proof itself.
  let attestation: any = null
  let proveMs = 0
  let proveError: string | null = null
  if (inTree.ok) {
    const started = Date.now()
    try {
      attestation = await identity.createAttestationTransaction(httpBase(rpcUrls[0]!), context)
    } catch (error) {
      proveError = error instanceof Error ? error.message : String(error)
    }
    proveMs = Date.now() - started
  }
  checks.sdk_proved = attestation !== null
  checks.sdk_verified = attestation !== null && (await zK.identity.ZKIdentity.verifyAttestation(attestation))

  // 3. The proof bound to another context must be refused. Public signals are
  // [nullifier, context, merkle_root].
  let forged: any = null
  if (attestation) {
    const signals = [...attestation.public_signals]
    signals[1] = (BigInt(signals[1]) + 1n).toString()
    forged = await submitIdentity(demos, owner, { method: "zk_attestationadd", context: "zk", payload: [{ ...attestation, public_signals: signals }] }, true)
    checks.forged_proof_refused = refusedFor(forged, /proof failed/i)
  }

  // 4. The real attestation is applied on every node.
  let attest: any = null
  let applied: any = { ok: false, ms: 0, results: [] }
  if (attestation && checks.forged_proof_refused) {
    attest = await submitIdentity(demos, owner, { method: "zk_attestationadd", context: "zk", payload: [attestation] }, true)
    checks.attestation_accepted = attest.validity?.result === 200 && attest.broadcast?.result === 200
    if (checks.attestation_accepted) {
      applied = await pollAll(
        rpcUrls,
        rpcUrl => getNullifierStatus(rpcUrl, attestation.nullifier_hash),
        rs => rs.every(r => r.status === 200 && r.json?.used === true),
        timeoutSec,
      )
    }
    checks.nullifier_used_on_every_node = applied.ok
  }

  // 5. The same nullifier cannot be spent twice.
  let replay: any = null
  if (applied.ok) {
    replay = await submitIdentity(demos, owner, { method: "zk_attestationadd", context: "zk", payload: [attestation] }, true)
    checks.replay_refused = refusedFor(replay, /nullifier already used/i)
  }

  const expected = [
    "commitment_accepted",
    "commitment_in_tree_on_every_node",
    "same_root_on_every_node",
    "sdk_proved",
    "sdk_verified",
    "forged_proof_refused",
    "attestation_accepted",
    "nullifier_used_on_every_node",
    "replay_refused",
  ]
  const ok = expected.every(name => checks[name] === true)
  const summary = {
    scenario: "zk_identity_e2e",
    ok,
    rpcUrls,
    owner,
    commitment,
    context,
    checks,
    timings: { commitmentToTreeMs: inTree.ms, proveMs, attestationToNullifierMs: applied.ms },
    proveError,
    commit: { validity: brief(commit.validity), broadcast: brief(commit.broadcast) },
    forged: forged && { validity: brief(forged.validity), broadcast: brief(forged.broadcast) },
    attest: attest && { validity: brief(attest.validity), broadcast: brief(attest.broadcast) },
    replay: replay && { validity: brief(replay.validity), broadcast: brief(replay.broadcast) },
    roots: roots.results.map((r: any, i) => ({ rpcUrl: rpcUrls[i], rootHash: r.json?.rootHash, leafCount: r.json?.leafCount })),
    timestamp: new Date().toISOString(),
  }
  writeJson(`${run.runDir}/features/zk/zk_identity_e2e.summary.json`, summary)
  console.log(JSON.stringify({ zk_identity_e2e_summary: summary }, null, 2))
  if (!ok) {
    const failed = expected.filter(name => checks[name] !== true)
    throw new Error(`zk_identity_e2e failed: ${failed.join(", ")}`)
  }
}

if (import.meta.main) {
  await runZkIdentityE2e()
}

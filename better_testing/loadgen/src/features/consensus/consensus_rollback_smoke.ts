import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { maybeSilenceConsole, readWalletMnemonics } from "../../token_shared"
import { getConsensusTargets, getAddressNonceViaRpc, waitForBlockAdvance, waitForConsensusTargets, waitForTxByHash } from "./shared"

function extractTxHash(value: any): string | null {
  const candidates = [
    value?.response?.data?.transaction?.hash,
    value?.response?.transaction?.hash,
    value?.response?.hash,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate
  }
  return null
}

export async function runConsensusRollbackSmoke() {
  maybeSilenceConsole()

  const rpcUrls = getConsensusTargets()
  if (rpcUrls.length === 0) throw new Error("consensus_rollback_smoke requires at least one RPC target")
  await waitForConsensusTargets(rpcUrls, true)

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("consensus_rollback_smoke requires at least 2 wallets")

  const bootstrap = rpcUrls[0]!
  const demos = new Demos()
  await demos.connect(bootstrap)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })

  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const senderAddress = uint8ArrayToHex(publicKey)
  const recipientDemos = new Demos()
  await recipientDemos.connect(bootstrap)
  await recipientDemos.connectWallet(wallets[1]!, { algorithm: "ed25519" })
  const recipientAddress = uint8ArrayToHex((await recipientDemos.crypto.getIdentity("ed25519")).publicKey)

  const senderNonceBefore = await getAddressNonceViaRpc(bootstrap, senderAddress, "consensus:rollback:nonce:before")
  if (typeof senderNonceBefore !== "number") {
    throw new Error(`consensus_rollback_smoke could not read sender nonce for ${senderAddress}`)
  }

  const tx = demos.tx.empty()
  tx.content.to = recipientAddress
  tx.content.nonce = senderNonceBefore + 1
  tx.content.amount = Math.max(1, envInt("CONSENSUS_TRANSFER_AMOUNT", 1))
  tx.content.type = "native"
  tx.content.timestamp = Date.now()
  tx.content.data = ["native", { nativeOperation: "send", args: [recipientAddress, tx.content.amount] }]

  const signedTx = await demos.sign(tx)
  const invalidTx = structuredClone(signedTx)
  invalidTx.content.from = recipientAddress
  if (invalidTx.content.from_ed25519_address) {
    invalidTx.content.from_ed25519_address = recipientAddress
  }

  const validity = await (demos as any).confirm(invalidTx).catch((error: unknown) => ({
    result: 599,
    response: error instanceof Error ? error.message : String(error),
  }))

  let broadcast: any = null
  if (validity?.result === 200) {
    broadcast = await (demos as any).broadcast(validity).catch((error: unknown) => ({
      result: 599,
      response: error instanceof Error ? error.message : String(error),
    }))
  }

  const txHash = extractTxHash(validity) ?? extractTxHash(broadcast)
  const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 60)
  const pollMs = envInt("CONSENSUS_POLL_MS", 500)
  const blockAdvance = await waitForBlockAdvance({
    rpcUrls: [bootstrap],
    requiredDelta: 1,
    timeoutSec,
    pollMs,
  })

  const senderNonceAfter = await getAddressNonceViaRpc(bootstrap, senderAddress, "consensus:rollback:nonce:after")
  const txLookup = txHash
    ? await waitForTxByHash({
      rpcUrls: [bootstrap],
      hash: txHash,
      timeoutSec: Math.min(10, timeoutSec),
      pollMs,
    })
    : null

  const statePreserved = senderNonceAfter === senderNonceBefore
  const rejected = validity?.result !== 200 || (broadcast && broadcast?.result !== 200)
  const txAbsent = !txHash || !txLookup?.ok
  const ok = rejected && statePreserved && blockAdvance.ok && txAbsent

  const run = getRunConfig()
  const summary = {
    scenario: "consensus_rollback_smoke",
    ok,
    coverage: "validation_rejection_only",
    rollbackPathExercised: false,
    note: "This smoke verifies a tampered signed transaction is rejected and does not mutate chain state. It does not trigger the internal BlockInvalidError rollback path.",
    bootstrap,
    senderAddress,
    recipientAddress,
    senderNonceBefore,
    senderNonceAfter,
    invalidationMode: "tampered_from_after_sign",
    txHash,
    confirmResult: validity?.result ?? null,
    broadcastResult: broadcast?.result ?? null,
    rejected,
    txAbsent,
    blockAdvance,
    txLookup,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/consensus/consensus_rollback_smoke.summary.json`, summary)
  console.log(JSON.stringify({ consensus_rollback_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("consensus_rollback_smoke failed: rejected tx appears to have mutated chain state or was unexpectedly accepted")
  }
}

if (import.meta.main) {
  await runConsensusRollbackSmoke()
}

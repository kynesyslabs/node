import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { envInt } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { getWalletAddresses, maybeSilenceConsole, readWalletMnemonics } from "../../token_shared"
import {
  getAddressNonceViaRpc,
  getConsensusTargets,
  waitForBlockAdvance,
  waitForConsensusTargets,
  waitForNonceAdvance,
  waitForTxByHash,
} from "./shared"

function extractTxHash(...values: any[]): string | null {
  const candidates = [
    values[0]?.hash,
    values[0]?.content?.hash,
    values[1]?.response?.data?.transaction?.hash,
    values[1]?.response?.transaction?.hash,
    values[1]?.response?.hash,
    values[2]?.response?.data?.transaction?.hash,
    values[2]?.response?.transaction?.hash,
    values[2]?.response?.hash,
  ]
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return null
}

export async function runConsensusTxInclusion() {
  maybeSilenceConsole()

  const rpcUrls = getConsensusTargets()
  if (rpcUrls.length === 0) throw new Error("consensus_tx_inclusion requires at least one RPC target")

  await waitForConsensusTargets(rpcUrls, true)

  const wallets = await readWalletMnemonics()
  if (wallets.length < 2) throw new Error("consensus_tx_inclusion requires at least 2 wallets")

  const bootstrap = rpcUrls[0]!
  const [senderAddress, recipientAddress] = await getWalletAddresses(bootstrap, wallets.slice(0, 2))
  const transferAmount = Math.max(1, envInt("CONSENSUS_TRANSFER_AMOUNT", 1))

  const senderNonceBefore = await getAddressNonceViaRpc(bootstrap, senderAddress!, "consensus:tx:senderNonce:before")
  if (typeof senderNonceBefore !== "number") {
    throw new Error(`consensus_tx_inclusion could not read sender nonce for ${senderAddress}`)
  }

  const demos = new Demos()
  await demos.connect(bootstrap)
  await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
  const { publicKey } = await demos.crypto.getIdentity("ed25519")
  const connectedSender = uint8ArrayToHex(publicKey)
  if (connectedSender.toLowerCase() !== senderAddress!.toLowerCase()) {
    throw new Error(`consensus_tx_inclusion wallet/address mismatch: ${connectedSender} != ${senderAddress}`)
  }

  const tx = demos.tx.empty()
  tx.content.to = recipientAddress
  tx.content.nonce = senderNonceBefore + 1
  tx.content.amount = transferAmount
  tx.content.type = "native"
  tx.content.timestamp = Date.now()
  tx.content.data = ["native", { nativeOperation: "send", args: [recipientAddress, transferAmount] }]

  const signedTx = await demos.sign(tx)
  const validity = await (demos as any).confirm(signedTx)
  if (validity?.result !== 200) {
    throw new Error(`consensus_tx_inclusion confirm failed: ${JSON.stringify(validity)}`)
  }
  const broadcast = await (demos as any).broadcast(validity)
  if (broadcast?.result !== 200) {
    throw new Error(`consensus_tx_inclusion broadcast failed: ${JSON.stringify(broadcast)}`)
  }

  const txHash = extractTxHash(signedTx, validity, broadcast)
  const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 60)
  const pollMs = envInt("CONSENSUS_POLL_MS", 500)

  const nonceWait = await waitForNonceAdvance({
    rpcUrls,
    address: senderAddress!,
    expectedAtLeast: senderNonceBefore + 1,
    timeoutSec,
    pollMs,
  })

  const blockAdvance = await waitForBlockAdvance({
    rpcUrls,
    requiredDelta: 1,
    timeoutSec,
    pollMs,
  })

  const txByHash = txHash
    ? await waitForTxByHash({
      rpcUrls: [bootstrap],
      hash: txHash,
      timeoutSec,
      pollMs,
    })
    : null

  const ok = nonceWait.ok && blockAdvance.ok && (!txHash || !!txByHash?.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "consensus_tx_inclusion",
    ok,
    rpcUrls,
    bootstrap,
    senderAddress,
    recipientAddress,
    transferAmount,
    senderNonceBefore,
    expectedSenderNonce: senderNonceBefore + 1,
    txHash,
    txHashObserved: txHash ? txByHash?.ok ?? false : null,
    txHashCheckSkipped: txHash ? false : true,
    confirmResult: validity?.result ?? null,
    broadcastResult: broadcast?.result ?? null,
    nonceWait,
    blockAdvance,
    txByHash,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/consensus/consensus_tx_inclusion.summary.json`, summary)
  console.log(JSON.stringify({ consensus_tx_inclusion_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("consensus_tx_inclusion failed: tx effects were not observed on chain")
  }
}

if (import.meta.main) {
  await runConsensusTxInclusion()
}


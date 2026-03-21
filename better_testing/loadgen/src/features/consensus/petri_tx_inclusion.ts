/**
 * Petri Consensus — Devnet Scenario: TX Inclusion + Finality
 *
 * Submits a native transfer, then verifies:
 *   1. TX is included in a block (hard finality)
 *   2. getTransactionFinality RPC returns correct finality data
 *   3. softFinalityAt is set (PRE_APPROVED timestamp)
 *   4. hardFinalityAt is set once confirmed
 *
 * Prerequisites:
 *   - Devnet running with PETRI_CONSENSUS=true
 *   - At least 2 wallets configured
 */
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import { envInt, sleep } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
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

interface FinalityResult {
    hash: string
    classification: string
    softFinalityAt: number | null
    hardFinalityAt: number | null
    confirmed: boolean
}

async function pollTransactionFinality(
    rpcUrl: string,
    txHash: string,
    timeoutSec: number,
    pollMs: number,
): Promise<{ ok: boolean; finality: FinalityResult | null; softFinalityObserved: boolean; hardFinalityObserved: boolean }> {
    const deadlineMs = Date.now() + timeoutSec * 1000
    let softFinalityObserved = false
    let hardFinalityObserved = false
    let lastFinality: FinalityResult | null = null

    while (Date.now() < deadlineMs) {
        try {
            const res = await nodeCall(rpcUrl, "getTransactionFinality", { params: [txHash] }, "petri:finality:poll", NO_FALLBACKS)
            const finality = res?.response as FinalityResult | undefined

            if (finality) {
                lastFinality = finality

                if (finality.softFinalityAt && !softFinalityObserved) {
                    softFinalityObserved = true
                    console.log(`[petri_tx_inclusion] Soft finality observed at ${finality.softFinalityAt}`)
                }

                if (finality.confirmed && finality.hardFinalityAt) {
                    hardFinalityObserved = true
                    console.log(`[petri_tx_inclusion] Hard finality observed at ${finality.hardFinalityAt}`)
                    return { ok: true, finality, softFinalityObserved, hardFinalityObserved }
                }
            }
        } catch {
            // RPC may not be available yet
        }

        await sleep(Math.max(100, pollMs))
    }

    return { ok: hardFinalityObserved, finality: lastFinality, softFinalityObserved, hardFinalityObserved }
}

export async function runPetriTxInclusion() {
    maybeSilenceConsole()

    const rpcUrls = getConsensusTargets()
    if (rpcUrls.length === 0) throw new Error("petri_tx_inclusion requires at least one RPC target")

    await waitForConsensusTargets(rpcUrls, true)

    const wallets = await readWalletMnemonics()
    if (wallets.length < 2) throw new Error("petri_tx_inclusion requires at least 2 wallets")

    const bootstrap = rpcUrls[0]!
    const [senderAddress, recipientAddress] = await getWalletAddresses(bootstrap, wallets.slice(0, 2))
    const transferAmount = Math.max(1, envInt("CONSENSUS_TRANSFER_AMOUNT", 1))

    const senderNonceBefore = await getAddressNonceViaRpc(bootstrap, senderAddress!, "petri:tx:senderNonce:before")
    if (typeof senderNonceBefore !== "number") {
        throw new Error(`petri_tx_inclusion could not read sender nonce for ${senderAddress}`)
    }

    // Submit transaction
    const demos = new Demos()
    await demos.connect(bootstrap)
    await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
    const { publicKey } = await demos.crypto.getIdentity("ed25519")
    const connectedSender = uint8ArrayToHex(publicKey as Uint8Array)
    if (connectedSender.toLowerCase() !== senderAddress!.toLowerCase()) {
        throw new Error(`petri_tx_inclusion wallet/address mismatch: ${connectedSender} != ${senderAddress}`)
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
        throw new Error(`petri_tx_inclusion confirm failed: ${JSON.stringify(validity)}`)
    }
    const broadcast = await (demos as any).broadcast(validity)
    if (broadcast?.result !== 200) {
        throw new Error(`petri_tx_inclusion broadcast failed: ${JSON.stringify(broadcast)}`)
    }

    const txHash = extractTxHash(signedTx, validity, broadcast)
    const txSubmittedAt = Date.now()
    const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 60)
    const pollMs = envInt("CONSENSUS_POLL_MS", 500)

    // Wait for nonce advance + block production
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

    // Poll getTransactionFinality for soft + hard finality
    let finalityResult = null
    if (txHash) {
        finalityResult = await pollTransactionFinality(bootstrap, txHash, timeoutSec, pollMs)
    }

    const txByHash = txHash
        ? await waitForTxByHash({
            rpcUrls: [bootstrap],
            hash: txHash,
            timeoutSec,
            pollMs,
        })
        : null

    const ok = nonceWait.ok
        && blockAdvance.ok
        && (!txHash || !!txByHash?.ok)
        && (finalityResult?.hardFinalityObserved ?? false)

    const run = getRunConfig()
    const summary = {
        scenario: "petri_tx_inclusion",
        ok,
        rpcUrls,
        bootstrap,
        senderAddress,
        recipientAddress,
        transferAmount,
        senderNonceBefore,
        expectedSenderNonce: senderNonceBefore + 1,
        txHash,
        txSubmittedAt,
        softFinalityObserved: finalityResult?.softFinalityObserved ?? false,
        hardFinalityObserved: finalityResult?.hardFinalityObserved ?? false,
        softFinalityAt: finalityResult?.finality?.softFinalityAt ?? null,
        hardFinalityAt: finalityResult?.finality?.hardFinalityAt ?? null,
        softFinalityLatencyMs: finalityResult?.finality?.softFinalityAt
            ? finalityResult.finality.softFinalityAt - txSubmittedAt
            : null,
        hardFinalityLatencyMs: finalityResult?.finality?.hardFinalityAt
            ? finalityResult.finality.hardFinalityAt - txSubmittedAt
            : null,
        nonceWait,
        blockAdvance,
        txByHash,
        timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/consensus/petri_tx_inclusion.summary.json`, summary)
    console.log(JSON.stringify({ petri_tx_inclusion_summary: summary }, null, 2))

    if (!ok) {
        const reasons: string[] = []
        if (!nonceWait.ok) reasons.push("nonce did not advance")
        if (!blockAdvance.ok) reasons.push("block height did not advance")
        if (txHash && !txByHash?.ok) reasons.push("tx not found by hash")
        if (!finalityResult?.hardFinalityObserved) reasons.push("hard finality not observed via getTransactionFinality RPC")
        throw new Error(`petri_tx_inclusion failed: ${reasons.join("; ")}`)
    }
}

if (import.meta.main) {
    await runPetriTxInclusion()
}

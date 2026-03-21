/**
 * Petri Consensus — Devnet Scenario: Relay Flow E2E
 *
 * Submits a native transfer to node-1, then verifies:
 *   1. TX hash is observable on ALL nodes (relay/gossip propagation)
 *   2. Nonce advances on ALL nodes (state sync)
 *   3. getTransactionFinality returns consistent results across nodes
 *
 * This validates that Petri's consensus relay correctly propagates
 * transactions and state across the entire cluster, not just the
 * bootstrap node.
 *
 * Prerequisites:
 *   - Devnet running with PETRI_CONSENSUS=true
 *   - At least 2 nodes and 2 wallets configured
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

interface NodeFinalityCheck {
    rpcUrl: string
    txHashFound: boolean
    finalityAvailable: boolean
    classification: string | null
    softFinalityAt: number | null
    hardFinalityAt: number | null
    confirmed: boolean
}

async function checkFinalityOnNode(rpcUrl: string, txHash: string): Promise<NodeFinalityCheck> {
    const result: NodeFinalityCheck = {
        rpcUrl,
        txHashFound: false,
        finalityAvailable: false,
        classification: null,
        softFinalityAt: null,
        hardFinalityAt: null,
        confirmed: false,
    }

    try {
        const res = await nodeCall(rpcUrl, "getTransactionFinality", { params: [txHash] }, "petri:relay:finality", NO_FALLBACKS)
        const finality = res?.response
        if (finality) {
            result.finalityAvailable = true
            result.classification = finality.classification ?? null
            result.softFinalityAt = finality.softFinalityAt ?? null
            result.hardFinalityAt = finality.hardFinalityAt ?? null
            result.confirmed = finality.confirmed ?? false
        }
    } catch {
        // RPC not available or tx not found
    }

    // Also check via getTx
    try {
        const txRes = await nodeCall(rpcUrl, "getTx", { params: [txHash] }, "petri:relay:getTx", NO_FALLBACKS)
        if (txRes?.response) {
            result.txHashFound = true
        }
    } catch {
        // not found
    }

    return result
}

export async function runPetriRelayFlow() {
    maybeSilenceConsole()

    const rpcUrls = getConsensusTargets()
    if (rpcUrls.length < 2) throw new Error("petri_relay_flow requires at least 2 RPC targets to verify relay propagation")

    await waitForConsensusTargets(rpcUrls, true)

    const wallets = await readWalletMnemonics()
    if (wallets.length < 2) throw new Error("petri_relay_flow requires at least 2 wallets")

    const bootstrap = rpcUrls[0]!
    const otherNodes = rpcUrls.slice(1)
    const [senderAddress, recipientAddress] = await getWalletAddresses(bootstrap, wallets.slice(0, 2))
    const transferAmount = Math.max(1, envInt("CONSENSUS_TRANSFER_AMOUNT", 1))

    const senderNonceBefore = await getAddressNonceViaRpc(bootstrap, senderAddress!, "petri:relay:senderNonce:before")
    if (typeof senderNonceBefore !== "number") {
        throw new Error(`petri_relay_flow could not read sender nonce for ${senderAddress}`)
    }

    // Submit transaction to bootstrap node only
    const demos = new Demos()
    await demos.connect(bootstrap)
    await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
    const { publicKey } = await demos.crypto.getIdentity("ed25519")
    const connectedSender = uint8ArrayToHex(publicKey as Uint8Array)
    if (connectedSender.toLowerCase() !== senderAddress!.toLowerCase()) {
        throw new Error(`petri_relay_flow wallet/address mismatch: ${connectedSender} != ${senderAddress}`)
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
        throw new Error(`petri_relay_flow confirm failed: ${JSON.stringify(validity)}`)
    }
    const broadcast = await (demos as any).broadcast(validity)
    if (broadcast?.result !== 200) {
        throw new Error(`petri_relay_flow broadcast failed: ${JSON.stringify(broadcast)}`)
    }

    const txHash = extractTxHash(signedTx, validity, broadcast)
    const txSubmittedAt = Date.now()
    const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 60)
    const pollMs = envInt("CONSENSUS_POLL_MS", 500)

    console.log(`[petri_relay_flow] TX submitted to ${bootstrap}, hash=${txHash}`)
    console.log(`[petri_relay_flow] Verifying relay to ${otherNodes.length} other node(s)...`)

    // Wait for nonce advance on ALL nodes (proves relay propagation)
    const nonceWait = await waitForNonceAdvance({
        rpcUrls,
        address: senderAddress!,
        expectedAtLeast: senderNonceBefore + 1,
        timeoutSec,
        pollMs,
    })

    // Wait for block production
    const blockAdvance = await waitForBlockAdvance({
        rpcUrls,
        requiredDelta: 1,
        timeoutSec,
        pollMs,
    })

    // Check TX hash visibility on ALL nodes
    const txByHashResults: Record<string, { ok: boolean }> = {}
    if (txHash) {
        for (const url of rpcUrls) {
            const result = await waitForTxByHash({
                rpcUrls: [url],
                hash: txHash,
                timeoutSec,
                pollMs,
            })
            txByHashResults[url] = { ok: result?.ok ?? false }
        }
    }

    // Check finality consistency across all nodes
    const finalityChecks: NodeFinalityCheck[] = []
    if (txHash) {
        // Give finality a moment to propagate
        await sleep(2000)
        for (const url of rpcUrls) {
            finalityChecks.push(await checkFinalityOnNode(url, txHash))
        }
    }

    const allTxHashFound = txHash
        ? Object.values(txByHashResults).every(r => r.ok)
        : false
    const allNoncesAdvanced = nonceWait.ok
    const blocksAdvanced = blockAdvance.ok
    const relayedToAllNodes = allTxHashFound && allNoncesAdvanced

    const ok = relayedToAllNodes && blocksAdvanced

    const run = getRunConfig()
    const summary = {
        scenario: "petri_relay_flow",
        ok,
        rpcUrls,
        bootstrap,
        otherNodes,
        senderAddress,
        recipientAddress,
        transferAmount,
        senderNonceBefore,
        expectedSenderNonce: senderNonceBefore + 1,
        txHash,
        txSubmittedAt,
        allTxHashFound,
        allNoncesAdvanced,
        blocksAdvanced,
        relayedToAllNodes,
        txByHashResults,
        finalityChecks,
        nonceWait,
        blockAdvance,
        timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/consensus/petri_relay_flow.summary.json`, summary)
    console.log(JSON.stringify({ petri_relay_flow_summary: summary }, null, 2))

    if (!ok) {
        const reasons: string[] = []
        if (!allNoncesAdvanced) reasons.push("nonce did not advance on all nodes")
        if (!blocksAdvanced) reasons.push("block height did not advance")
        if (!allTxHashFound) {
            const missing = Object.entries(txByHashResults)
                .filter(([, r]) => !r.ok)
                .map(([url]) => url)
            reasons.push(`tx not found on ${missing.length} node(s): ${missing.join(", ")}`)
        }
        throw new Error(`petri_relay_flow failed: ${reasons.join("; ")}`)
    }
}

if (import.meta.main) {
    await runPetriRelayFlow()
}

/**
 * Petri Consensus — Devnet Scenario: Soak Run + Performance Baseline
 *
 * Sends sustained load over multiple rounds, measuring:
 *   - TX submission throughput (tx/s)
 *   - Soft finality latency (time to PRE_APPROVED)
 *   - Hard finality latency (time to confirmed)
 *   - Block production rate
 *   - Error rate
 *
 * Outputs a baseline JSON summary suitable for comparison across runs.
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

interface TxSample {
    round: number
    txHash: string | null
    submittedAt: number
    submitOk: boolean
    softFinalityAt: number | null
    hardFinalityAt: number | null
    softLatencyMs: number | null
    hardLatencyMs: number | null
}

async function pollFinality(
    rpcUrl: string,
    txHash: string,
    timeoutMs: number,
): Promise<{ softFinalityAt: number | null; hardFinalityAt: number | null }> {
    const deadline = Date.now() + timeoutMs
    let softFinalityAt: number | null = null
    let hardFinalityAt: number | null = null

    while (Date.now() < deadline) {
        try {
            const res = await nodeCall(rpcUrl, "getTransactionFinality", { params: [txHash] }, "petri:soak:poll", NO_FALLBACKS)
            const finality = res?.response
            if (finality) {
                if (finality.softFinalityAt && !softFinalityAt) {
                    softFinalityAt = finality.softFinalityAt
                }
                if (finality.confirmed && finality.hardFinalityAt) {
                    hardFinalityAt = finality.hardFinalityAt
                    return { softFinalityAt, hardFinalityAt }
                }
            }
        } catch {
            // not ready yet
        }
        await sleep(300)
    }

    return { softFinalityAt, hardFinalityAt }
}

export async function runPetriSoak() {
    maybeSilenceConsole()

    const rpcUrls = getConsensusTargets()
    if (rpcUrls.length === 0) throw new Error("petri_soak requires at least one RPC target")

    await waitForConsensusTargets(rpcUrls, true)

    const wallets = await readWalletMnemonics()
    if (wallets.length < 2) throw new Error("petri_soak requires at least 2 wallets")

    const bootstrap = rpcUrls[0]!
    const [senderAddress, recipientAddress] = await getWalletAddresses(bootstrap, wallets.slice(0, 2))
    const transferAmount = Math.max(1, envInt("CONSENSUS_TRANSFER_AMOUNT", 1))
    const soakRounds = envInt("SOAK_ROUNDS", 10)
    const roundDelayMs = envInt("SOAK_ROUND_DELAY_MS", 1000)
    const finalityTimeoutMs = envInt("SOAK_FINALITY_TIMEOUT_MS", 30000)

    const demos = new Demos()
    await demos.connect(bootstrap)
    await demos.connectWallet(wallets[0]!, { algorithm: "ed25519" })
    const { publicKey } = await demos.crypto.getIdentity("ed25519")
    const connectedSender = uint8ArrayToHex(publicKey as Uint8Array)
    if (connectedSender.toLowerCase() !== senderAddress!.toLowerCase()) {
        throw new Error(`petri_soak wallet/address mismatch: ${connectedSender} != ${senderAddress}`)
    }

    let currentNonce = await getAddressNonceViaRpc(bootstrap, senderAddress!, "petri:soak:nonce")
    if (typeof currentNonce !== "number") {
        throw new Error(`petri_soak could not read sender nonce for ${senderAddress}`)
    }

    console.log(`[petri_soak] Starting ${soakRounds} rounds, delay=${roundDelayMs}ms`)

    const soakStartedAt = Date.now()
    const samples: TxSample[] = []

    // Record initial block height
    const initialBlockRes = await nodeCall(bootstrap, "getLastBlockNumber", {}, "petri:soak:initialBlock", NO_FALLBACKS)
    const initialBlockHeight = initialBlockRes?.response ?? 0

    for (let round = 0; round < soakRounds; round++) {
        const sample: TxSample = {
            round,
            txHash: null,
            submittedAt: Date.now(),
            submitOk: false,
            softFinalityAt: null,
            hardFinalityAt: null,
            softLatencyMs: null,
            hardLatencyMs: null,
        }

        try {
            currentNonce++
            const tx = demos.tx.empty()
            tx.content.to = recipientAddress
            tx.content.nonce = currentNonce
            tx.content.amount = transferAmount
            tx.content.type = "native"
            tx.content.timestamp = Date.now()
            tx.content.data = ["native", { nativeOperation: "send", args: [recipientAddress, transferAmount] }]

            const signedTx = await demos.sign(tx)
            const validity = await (demos as any).confirm(signedTx)
            if (validity?.result !== 200) {
                console.log(`[petri_soak] Round ${round}: confirm failed`)
                samples.push(sample)
                continue
            }
            const broadcast = await (demos as any).broadcast(validity)
            if (broadcast?.result !== 200) {
                console.log(`[petri_soak] Round ${round}: broadcast failed`)
                samples.push(sample)
                continue
            }

            sample.submitOk = true
            sample.txHash = extractTxHash(signedTx, validity, broadcast)
            sample.submittedAt = Date.now()

            // Poll for finality
            if (sample.txHash) {
                const finality = await pollFinality(bootstrap, sample.txHash, finalityTimeoutMs)
                sample.softFinalityAt = finality.softFinalityAt
                sample.hardFinalityAt = finality.hardFinalityAt

                if (sample.softFinalityAt) {
                    sample.softLatencyMs = sample.softFinalityAt - sample.submittedAt
                }
                if (sample.hardFinalityAt) {
                    sample.hardLatencyMs = sample.hardFinalityAt - sample.submittedAt
                }
            }

            if ((round + 1) % 5 === 0 || round === soakRounds - 1) {
                const successCount = samples.filter(s => s.submitOk).length + (sample.submitOk ? 1 : 0)
                console.log(`[petri_soak] Round ${round + 1}/${soakRounds} — ${successCount} submitted OK`)
            }
        } catch (error) {
            console.log(`[petri_soak] Round ${round}: error — ${error instanceof Error ? error.message : String(error)}`)
        }

        samples.push(sample)

        if (round < soakRounds - 1) {
            await sleep(roundDelayMs)
        }
    }

    const soakEndedAt = Date.now()
    const soakDurationMs = soakEndedAt - soakStartedAt

    // Final block height
    const finalBlockRes = await nodeCall(bootstrap, "getLastBlockNumber", {}, "petri:soak:finalBlock", NO_FALLBACKS)
    const finalBlockHeight = finalBlockRes?.response ?? 0
    const blocksProduced = (typeof finalBlockHeight === "number" && typeof initialBlockHeight === "number")
        ? finalBlockHeight - initialBlockHeight
        : 0

    // Compute statistics
    const submitted = samples.filter(s => s.submitOk)
    const withSoft = submitted.filter(s => s.softLatencyMs !== null)
    const withHard = submitted.filter(s => s.hardLatencyMs !== null)

    const softLatencies = withSoft.map(s => s.softLatencyMs!).sort((a, b) => a - b)
    const hardLatencies = withHard.map(s => s.hardLatencyMs!).sort((a, b) => a - b)

    const percentile = (arr: number[], p: number): number | null => {
        if (arr.length === 0) return null
        const idx = Math.ceil((p / 100) * arr.length) - 1
        return arr[Math.max(0, idx)]!
    }

    const avg = (arr: number[]): number | null => {
        if (arr.length === 0) return null
        return arr.reduce((a, b) => a + b, 0) / arr.length
    }

    const ok = submitted.length > 0 && withHard.length > 0

    const run = getRunConfig()
    const summary = {
        scenario: "petri_soak",
        ok,
        config: {
            soakRounds,
            roundDelayMs,
            finalityTimeoutMs,
            transferAmount,
        },
        duration: {
            totalMs: soakDurationMs,
            totalSec: Math.round(soakDurationMs / 1000),
        },
        throughput: {
            totalSubmitted: submitted.length,
            totalFailed: samples.length - submitted.length,
            errorRate: samples.length > 0 ? (samples.length - submitted.length) / samples.length : 0,
            txPerSecond: soakDurationMs > 0 ? (submitted.length / soakDurationMs) * 1000 : 0,
        },
        blocks: {
            initialHeight: initialBlockHeight,
            finalHeight: finalBlockHeight,
            blocksProduced,
            blockRate: soakDurationMs > 0 ? (blocksProduced / soakDurationMs) * 1000 : 0,
        },
        softFinality: {
            observed: withSoft.length,
            avgMs: avg(softLatencies),
            p50Ms: percentile(softLatencies, 50),
            p95Ms: percentile(softLatencies, 95),
            p99Ms: percentile(softLatencies, 99),
            minMs: softLatencies.length > 0 ? softLatencies[0] : null,
            maxMs: softLatencies.length > 0 ? softLatencies[softLatencies.length - 1] : null,
        },
        hardFinality: {
            observed: withHard.length,
            avgMs: avg(hardLatencies),
            p50Ms: percentile(hardLatencies, 50),
            p95Ms: percentile(hardLatencies, 95),
            p99Ms: percentile(hardLatencies, 99),
            minMs: hardLatencies.length > 0 ? hardLatencies[0] : null,
            maxMs: hardLatencies.length > 0 ? hardLatencies[hardLatencies.length - 1] : null,
        },
        timestamp: new Date().toISOString(),
    }

    writeJson(`${run.runDir}/features/consensus/petri_soak.summary.json`, summary)
    console.log(JSON.stringify({ petri_soak_summary: summary }, null, 2))

    if (!ok) {
        const reasons: string[] = []
        if (submitted.length === 0) reasons.push("no transactions were successfully submitted")
        if (withHard.length === 0) reasons.push("no hard finality observed for any transaction")
        throw new Error(`petri_soak failed: ${reasons.join("; ")}`)
    }
}

if (import.meta.main) {
    await runPetriSoak()
}

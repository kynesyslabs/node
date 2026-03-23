import { envInt, sleep } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import { maybeSilenceConsole } from "../../token_shared"
import { getConsensusTargets } from "./shared"

type NodeState = {
  ok: boolean
  blockNumber: number | null
  blockHash: string | null
  error?: string
}

type Observation = {
  timestamp: string
  healthyNodeCount: number
  byNode: Record<string, NodeState>
  distinctBlockNumbers: Array<number | null>
  distinctBlockHashes: string[]
  converged: boolean
}

async function getNodeState(rpcUrl: string): Promise<NodeState> {
  const [numberRes, hashRes] = await Promise.all([
    nodeCall(rpcUrl, "getLastBlockNumber", {}, `consensus:partition:number:${rpcUrl}`, NO_FALLBACKS).catch((error: unknown) => ({
      result: 599,
      extra: error instanceof Error ? error.message : String(error),
    })),
    nodeCall(rpcUrl, "getLastBlockHash", {}, `consensus:partition:hash:${rpcUrl}`, NO_FALLBACKS).catch((error: unknown) => ({
      result: 599,
      extra: error instanceof Error ? error.message : String(error),
    })),
  ])

  const blockNumberRaw = numberRes?.response
  const blockNumber = typeof blockNumberRaw === "number"
    ? blockNumberRaw
    : typeof blockNumberRaw === "string"
      ? Number.parseInt(blockNumberRaw, 10)
      : null
  const blockHash = typeof hashRes?.response === "string" && hashRes.response.length > 0 ? hashRes.response : null
  const ok = numberRes?.result === 200 && hashRes?.result === 200 && Number.isFinite(blockNumber) && !!blockHash

  return {
    ok,
    blockNumber: Number.isFinite(blockNumber) ? blockNumber : null,
    blockHash,
    error: ok ? undefined : String(numberRes?.extra ?? hashRes?.extra ?? numberRes?.response ?? hashRes?.response ?? "unhealthy target"),
  }
}

function summarizeObservation(byNode: Record<string, NodeState>): Observation {
  const healthyEntries = Object.entries(byNode).filter(([, state]) => state.ok)
  const distinctBlockNumbers = Array.from(new Set(healthyEntries.map(([, state]) => state.blockNumber)))
  const distinctBlockHashes = Array.from(new Set(healthyEntries.map(([, state]) => state.blockHash).filter((value): value is string => typeof value === "string")))

  return {
    timestamp: new Date().toISOString(),
    healthyNodeCount: healthyEntries.length,
    byNode,
    distinctBlockNumbers,
    distinctBlockHashes,
    converged: healthyEntries.length >= 2 && distinctBlockNumbers.length === 1 && distinctBlockHashes.length === 1,
  }
}

export async function runConsensusPartitionRecovery() {
  maybeSilenceConsole()

  const rpcUrls = getConsensusTargets()
  if (rpcUrls.length === 0) throw new Error("consensus_partition_recovery requires at least one RPC target")

  const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 90)
  const pollMs = envInt("CONSENSUS_POLL_MS", 1000)
  const stableRoundsRequired = Math.max(2, envInt("CONSENSUS_PARTITION_STABLE_ROUNDS", 3))
  const requiredBlockAdvance = Math.max(1, envInt("CONSENSUS_REQUIRED_BLOCK_DELTA", 1))

  const initialByNode = Object.fromEntries(
    await Promise.all(rpcUrls.map(async rpcUrl => [rpcUrl, await getNodeState(rpcUrl)] as const)),
  )
  const initial = summarizeObservation(initialByNode)
  const healthyRpcUrls = Object.entries(initial.byNode).filter(([, state]) => state.ok).map(([rpcUrl]) => rpcUrl)

  const run = getRunConfig()
  if (healthyRpcUrls.length < 2) {
    const summary = {
      scenario: "consensus_partition_recovery",
      ok: true,
      skipped: true,
      skipReason: "need at least 2 healthy RPC targets to observe partition recovery",
      rpcUrls,
      healthyRpcUrls,
      timeoutSec,
      pollMs,
      stableRoundsRequired,
      requiredBlockAdvance,
      initial,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/consensus/consensus_partition_recovery.summary.json`, summary)
    console.log(JSON.stringify({ consensus_partition_recovery_summary: summary }, null, 2))
    return
  }

  const baselineMinBlock = Math.min(...healthyRpcUrls.map(rpcUrl => initial.byNode[rpcUrl]!.blockNumber ?? Number.MAX_SAFE_INTEGER))
  const observations: Observation[] = [initial]
  let partitionObserved = !initial.converged
  let convergedStableRounds = initial.converged ? 1 : 0
  let recovered = false

  const deadlineMs = Date.now() + timeoutSec * 1000
  while (Date.now() < deadlineMs) {
    await sleep(Math.max(100, pollMs))
    const byNode = Object.fromEntries(
      await Promise.all(healthyRpcUrls.map(async rpcUrl => [rpcUrl, await getNodeState(rpcUrl)] as const)),
    )
    const observation = summarizeObservation(byNode)
    observations.push(observation)

    if (!observation.converged) {
      partitionObserved = true
      convergedStableRounds = 0
      continue
    }

    convergedStableRounds++
    const currentBlock = observation.distinctBlockNumbers[0]
    const advancedEnough = typeof currentBlock === "number" && currentBlock >= baselineMinBlock + requiredBlockAdvance
    if (convergedStableRounds >= stableRoundsRequired && advancedEnough) {
      recovered = true
      break
    }
  }

  const finalObservation = observations[observations.length - 1]!
  const ok = recovered || (!partitionObserved && finalObservation.converged)
  const summary = {
    scenario: "consensus_partition_recovery",
    ok,
    skipped: false,
    rpcUrls,
    healthyRpcUrls,
    timeoutSec,
    pollMs,
    stableRoundsRequired,
    requiredBlockAdvance,
    partitionObserved,
    recoveryObserved: recovered,
    inconclusive: !partitionObserved,
    note: "This scenario observes divergence and reconvergence across healthy RPC nodes. It does not actively inject a network partition.",
    initial,
    finalObservation,
    observations,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/consensus/consensus_partition_recovery.summary.json`, summary)
  console.log(JSON.stringify({ consensus_partition_recovery_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("consensus_partition_recovery failed: healthy nodes did not reconverge within the timeout window")
  }
}

if (import.meta.main) {
  await runConsensusPartitionRecovery()
}

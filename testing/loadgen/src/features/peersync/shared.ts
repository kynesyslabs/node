import { envInt, logNonCriticalError, normalizeRpcUrl, sleep } from "../../framework/common"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import { getConsensusTargets, getLastBlockNumber, waitForConsensusTargets } from "../consensus/shared"

export type PeerShape = {
  identity?: string
  status?: { online?: boolean }
  sync?: { status?: boolean }
  connection?: { string?: string }
}

export type NodeSnapshot = {
  rpcUrl: string
  ok: boolean
  identity: string | null
  peerCount: number
  onlinePeerCount: number
  syncedPeerCount: number
  peerIdentities: string[]
  selfInPeerlist: boolean
  blockNumber: number | null
  blockHash: string | null
  error?: string
}

export type ClusterObservation = {
  timestamp: string
  healthyNodeCount: number
  healthyRpcUrls: string[]
  knownNodeIdentities: string[]
  byNode: Record<string, NodeSnapshot>
  distinctBlockNumbers: Array<number | null>
  distinctBlockHashes: string[]
  minBlockNumber: number | null
  maxBlockNumber: number | null
  converged: boolean
  peerDiscoveryComplete: boolean
}

export function getPeerSyncTargets(): string[] {
  return getConsensusTargets()
}

export async function waitForPeerSyncTargets(rpcUrls: string[], requireTx = false) {
  await waitForConsensusTargets(rpcUrls, requireTx)
}

export async function getLastBlockHash(rpcUrl: string, muid: string): Promise<string | null> {
  const res = await nodeCall(rpcUrl, "getLastBlockHash", {}, muid, NO_FALLBACKS)
  return typeof res?.response === "string" && res.response.length > 0 ? res.response : null
}

export async function getPeerlist(rpcUrl: string, muid: string): Promise<PeerShape[]> {
  const res = await nodeCall(rpcUrl, "getPeerlist", {}, muid, NO_FALLBACKS)
  return Array.isArray(res?.response) ? res.response : []
}

export async function getNodeIdentity(rpcUrl: string): Promise<string | null> {
  try {
    const res = await fetch(new URL("info", normalizeRpcUrl(rpcUrl)))
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    return typeof json?.identity === "string" && json.identity.length > 0 ? json.identity : null
  } catch (error) {
    logNonCriticalError("peersync.getNodeIdentity", error, { rpcUrl })
    return null
  }
}

export async function getNodeSnapshot(rpcUrl: string): Promise<NodeSnapshot> {
  const [identity, peerlist, blockNumber, blockHash] = await Promise.all([
    getNodeIdentity(rpcUrl).catch(() => null),
    getPeerlist(rpcUrl, `peersync:peerlist:${rpcUrl}`).catch(() => [] as PeerShape[]),
    getLastBlockNumber(rpcUrl, `peersync:block:number:${rpcUrl}`).catch(() => null),
    getLastBlockHash(rpcUrl, `peersync:block:hash:${rpcUrl}`).catch(() => null),
  ])

  const peerIdentities = peerlist
    .map(peer => typeof peer?.identity === "string" ? peer.identity : null)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
  const onlinePeerCount = peerlist.filter(peer => peer?.status?.online !== false).length
  const syncedPeerCount = peerlist.filter(peer => peer?.sync?.status !== false).length
  const ok = !!identity && typeof blockNumber === "number" && !!blockHash && peerIdentities.length > 0

  return {
    rpcUrl,
    ok,
    identity,
    peerCount: peerlist.length,
    onlinePeerCount,
    syncedPeerCount,
    peerIdentities,
    selfInPeerlist: !!identity && peerIdentities.includes(identity),
    blockNumber,
    blockHash,
    error: ok ? undefined : `identity=${identity ?? "null"} blockNumber=${blockNumber ?? "null"} blockHash=${blockHash ?? "null"} peerCount=${peerlist.length}`,
  }
}

export async function getClusterObservation(rpcUrls: string[]): Promise<ClusterObservation> {
  const entries = await Promise.all(rpcUrls.map(async rpcUrl => [rpcUrl, await getNodeSnapshot(rpcUrl)] as const))
  const byNode = Object.fromEntries(entries)
  return summarizeClusterObservation(byNode)
}

export function summarizeClusterObservation(byNode: Record<string, NodeSnapshot>): ClusterObservation {
  const healthyEntries = Object.entries(byNode).filter(([, snapshot]) => snapshot.ok)
  const healthyRpcUrls = healthyEntries.map(([rpcUrl]) => rpcUrl)
  const knownNodeIdentities = Array.from(
    new Set(healthyEntries.map(([, snapshot]) => snapshot.identity).filter((value): value is string => typeof value === "string" && value.length > 0)),
  ).sort()
  const distinctBlockNumbers = Array.from(new Set(healthyEntries.map(([, snapshot]) => snapshot.blockNumber)))
  const distinctBlockHashes = Array.from(
    new Set(healthyEntries.map(([, snapshot]) => snapshot.blockHash).filter((value): value is string => typeof value === "string" && value.length > 0)),
  )
  const numericBlockNumbers = healthyEntries
    .map(([, snapshot]) => snapshot.blockNumber)
    .filter((value): value is number => typeof value === "number")
  const minBlockNumber = numericBlockNumbers.length > 0 ? Math.min(...numericBlockNumbers) : null
  const maxBlockNumber = numericBlockNumbers.length > 0 ? Math.max(...numericBlockNumbers) : null
  const peerDiscoveryComplete = healthyEntries.length >= 2 && knownNodeIdentities.length >= 2 && healthyEntries.every(([, snapshot]) =>
    snapshot.selfInPeerlist && knownNodeIdentities.every(identity => snapshot.peerIdentities.includes(identity)))

  return {
    timestamp: new Date().toISOString(),
    healthyNodeCount: healthyEntries.length,
    healthyRpcUrls,
    knownNodeIdentities,
    byNode,
    distinctBlockNumbers,
    distinctBlockHashes,
    minBlockNumber,
    maxBlockNumber,
    converged: healthyEntries.length >= 2 && distinctBlockNumbers.length === 1 && distinctBlockHashes.length === 1,
    peerDiscoveryComplete,
  }
}

export async function waitForClusterConvergence(params: {
  rpcUrls: string[]
  timeoutSec?: number
  pollMs?: number
  stableRoundsRequired?: number
  minBlockAdvance?: number
  requirePeerDiscovery?: boolean
}) {
  const timeoutSec = Math.max(1, params.timeoutSec ?? envInt("CONSENSUS_TIMEOUT_SEC", 90))
  const pollMs = Math.max(100, params.pollMs ?? envInt("CONSENSUS_POLL_MS", 1000))
  const stableRoundsRequired = Math.max(1, params.stableRoundsRequired ?? envInt("SYNC_STABLE_ROUNDS", 3))
  const minBlockAdvance = Math.max(0, params.minBlockAdvance ?? envInt("SYNC_REQUIRED_BLOCK_DELTA", 0))
  const initial = await getClusterObservation(params.rpcUrls)
  const baselineMinBlock = initial.minBlockNumber
  const observations: ClusterObservation[] = [initial]
  let stableRounds = initial.converged && (!params.requirePeerDiscovery || initial.peerDiscoveryComplete) ? 1 : 0
  const deadlineMs = Date.now() + timeoutSec * 1000

  while (Date.now() < deadlineMs) {
    if (stableRounds >= stableRoundsRequired) {
      const current = observations[observations.length - 1]!
      const advancedEnough =
        minBlockAdvance <= 0 ||
        (typeof baselineMinBlock === "number" && typeof current.maxBlockNumber === "number" && current.maxBlockNumber >= baselineMinBlock + minBlockAdvance)
      if (advancedEnough) {
        return {
          ok: true,
          timeoutSec,
          pollMs,
          stableRoundsRequired,
          minBlockAdvance,
          baselineMinBlock,
          observations,
        }
      }
    }

    await sleep(pollMs)
    const observation = await getClusterObservation(params.rpcUrls)
    observations.push(observation)
    const ready = observation.converged && (!params.requirePeerDiscovery || observation.peerDiscoveryComplete)
    stableRounds = ready ? stableRounds + 1 : 0
  }

  return {
    ok: false,
    timeoutSec,
    pollMs,
    stableRoundsRequired,
    minBlockAdvance,
    baselineMinBlock,
    observations,
  }
}

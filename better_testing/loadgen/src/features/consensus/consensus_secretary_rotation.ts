import Alea from "alea"
import { createHash } from "node:crypto"
import { envInt, sleep } from "../../framework/common"
import { getRunConfig, writeJson } from "../../framework/io"
import { nodeCall, NO_FALLBACKS } from "../../framework/rpc"
import { maybeSilenceConsole } from "../../token_shared"
import { getConsensusTargets, getLastBlockNumber, waitForConsensusTargets } from "./shared"

type PeerShape = {
  identity: string
  status?: { online?: boolean }
  sync?: { status?: boolean }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

async function getBlockByNumber(rpcUrl: string, blockNumber: number, muid: string) {
  const res = await nodeCall(rpcUrl, "getBlockByNumber", { blockNumber }, muid, NO_FALLBACKS)
  return res?.result === 200 ? res.response : null
}

async function getBlocks(rpcUrl: string, start: number | "latest", limit: number, muid: string) {
  const res = await nodeCall(rpcUrl, "getBlocks", { start, limit }, muid, NO_FALLBACKS)
  return Array.isArray(res?.response) ? res.response : []
}

async function getGenesisHash(rpcUrl: string): Promise<string> {
  const genesis = (await getBlocks(rpcUrl, 0, 1, "consensus:secretary:genesis"))[0]
  const hash = genesis?.hash
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("consensus_secretary_rotation could not read genesis hash")
  }
  return hash
}

async function getCommonValidatorSeedFromRpc(rpcUrl: string, lastBlockNumber: number, genesisHash: string) {
  const blocks = await getBlocks(rpcUrl, lastBlockNumber, 3, `consensus:secretary:blocks:${lastBlockNumber}`)
  const parts: string[] = []
  for (const block of blocks) {
    if (!block?.hash) continue
    parts.push(`${block.hash}:${block.number}`)
  }
  if (parts.length === 0) throw new Error(`No block data available for lastBlockNumber=${lastBlockNumber}`)
  return sha256Hex(parts.join("|") + `|genesis:${genesisHash}`)
}

async function getPeerlist(rpcUrl: string): Promise<PeerShape[]> {
  const res = await nodeCall(rpcUrl, "getPeerlist", {}, "consensus:secretary:getPeerlist", NO_FALLBACKS)
  return Array.isArray(res?.response) ? res.response : []
}

function deriveSecretaryIdentity(seed: string, peers: PeerShape[], shardSize: number): { secretary: string | null; shard: string[] } {
  const candidates = peers
    .filter(peer => peer?.identity && peer?.status?.online !== false && peer?.sync?.status !== false)
    .map(peer => ({ identity: peer.identity }))
  candidates.sort((a, b) => a.identity.localeCompare(b.identity))

  const randomness = Alea(seed)
  const available = candidates.slice()
  const shard: string[] = []
  const max = Math.min(Math.max(1, shardSize), available.length)
  for (let i = 0; i < max; i++) {
    const index = Math.floor(randomness() * available.length)
    shard.push(available[index]!.identity)
    available.splice(index, 1)
  }
  return {
    secretary: shard[0] ?? null,
    shard,
  }
}

export async function runConsensusSecretaryRotation() {
  maybeSilenceConsole()

  const rpcUrls = getConsensusTargets()
  if (rpcUrls.length === 0) throw new Error("consensus_secretary_rotation requires at least one RPC target")
  await waitForConsensusTargets(rpcUrls, false)

  const bootstrap = rpcUrls[0]!
  const rounds = Math.max(2, envInt("CONSENSUS_SECRETARY_ROUNDS", 4))
  const timeoutSec = envInt("CONSENSUS_TIMEOUT_SEC", 90)
  const pollMs = envInt("CONSENSUS_POLL_MS", 500)
  const shardSize = Math.max(1, envInt("SHARD_SIZE", 10))
  const genesisHash = await getGenesisHash(bootstrap)
  const peerlist = await getPeerlist(bootstrap)

  if (peerlist.length < 2) {
    const run = getRunConfig()
    const summary = {
      scenario: "consensus_secretary_rotation",
      ok: true,
      skipped: true,
      skipReason: "need at least 2 online peers to make secretary rotation meaningful",
      bootstrap,
      peerCount: peerlist.length,
      timestamp: new Date().toISOString(),
    }
    writeJson(`${run.runDir}/features/consensus/consensus_secretary_rotation.summary.json`, summary)
    console.log(JSON.stringify({ consensus_secretary_rotation_summary: summary }, null, 2))
    return
  }

  const startNumber = await getLastBlockNumber(bootstrap, "consensus:secretary:start")
  if (typeof startNumber !== "number") throw new Error("consensus_secretary_rotation could not read starting block number")

  const observations: Array<{ blockNumber: number; seed: string; secretary: string | null; shard: string[] }> = []
  const deadlineMs = Date.now() + Math.max(1, timeoutSec) * 1000
  let lastObserved = startNumber
  while (Date.now() < deadlineMs && observations.length < rounds) {
    const current = await getLastBlockNumber(bootstrap, "consensus:secretary:poll")
    if (typeof current === "number" && current > lastObserved) {
      for (let n = lastObserved + 1; n <= current && observations.length < rounds; n++) {
        const seed = await getCommonValidatorSeedFromRpc(bootstrap, n, genesisHash)
        const derived = deriveSecretaryIdentity(seed, peerlist, shardSize)
        observations.push({
          blockNumber: n,
          seed,
          secretary: derived.secretary,
          shard: derived.shard,
        })
      }
      lastObserved = current
    }
    await sleep(Math.max(100, pollMs))
  }

  const uniqueSecretaries = Array.from(new Set(observations.map(item => item.secretary).filter(Boolean)))
  const ok = observations.length > 0 && observations.every(item => typeof item.secretary === "string" && item.shard.includes(item.secretary))
  const run = getRunConfig()
  const summary = {
    scenario: "consensus_secretary_rotation",
    ok,
    skipped: false,
    bootstrap,
    roundsRequested: rounds,
    roundsObserved: observations.length,
    peerCount: peerlist.length,
    uniqueSecretaries,
    rotationObserved: uniqueSecretaries.length > 1,
    inconclusive: uniqueSecretaries.length <= 1,
    observations,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/consensus/consensus_secretary_rotation.summary.json`, summary)
  console.log(JSON.stringify({ consensus_secretary_rotation_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("consensus_secretary_rotation failed: could not derive a valid secretary sequence")
  }
}

if (import.meta.main) {
  await runConsensusSecretaryRotation()
}

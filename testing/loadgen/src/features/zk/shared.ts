import { rpcPost } from "../../framework/rpc"
import { envInt, normalizeRpcUrl } from "../../framework/common"
import { getTokenTargets } from "../../token_shared"

export type ZkTargetProbe = {
  rpcUrl: string
  pingOk: boolean
  merkleOk: boolean
  error: string | null
  merkleRoot: {
    rootHash: string
    blockNumber: number
    leafCount: number
  } | null
}

export type MerkleRootResponse = {
  rootHash: string
  blockNumber: number
  leafCount: number
}

export type NullifierStatusResponse = {
  used: boolean
  nullifierHash: string
  blockNumber?: number
  transactionHash?: string
}

export type MerkleProofResponse = {
  commitment: string
  proof: {
    siblings: string[][]
    pathIndices: number[]
    root: string
    leafIndex: number
  }
}

export type Groth16Proof = {
  pi_a: string[]
  pi_b: string[][]
  pi_c: string[]
  protocol: string
}

export const INVALID_GROTH16_PROOF: Groth16Proof = {
  pi_a: ["1", "2", "1"],
  pi_b: [
    ["1", "2"],
    ["3", "4"],
    ["1", "0"],
  ],
  pi_c: ["1", "2", "1"],
  protocol: "groth16",
}

function httpBase(rpcUrl: string): string {
  return normalizeRpcUrl(rpcUrl).replace(/\/+$/, "")
}

export function getZkTargets(): string[] {
  return getTokenTargets().map(normalizeRpcUrl)
}

export function buildHex64(seed: string): string {
  const body = seed.replace(/[^0-9a-f]/gi, "").padStart(64, "0").slice(-64)
  return `0x${body.toLowerCase()}`
}

export function buildUniqueHex64(prefix = ""): string {
  const nowHex = Date.now().toString(16)
  const randomHex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
  return buildHex64(`${prefix}${nowHex}${randomHex}`)
}

async function fetchJson(url: string): Promise<{ status: number; ok: boolean; json: any }> {
  const timeoutMs = envInt("ZK_HTTP_TIMEOUT_MS", 5000)
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined)
    const json = await res.json().catch(() => null)
    return { status: res.status, ok: res.ok, json }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function getMerkleRoot(rpcUrl: string) {
  return await fetchJson(`${httpBase(rpcUrl)}/zk/merkle-root`)
}

export async function getMerkleProof(rpcUrl: string, commitment: string) {
  return await fetchJson(`${httpBase(rpcUrl)}/zk/merkle/proof/${commitment}`)
}

export async function getNullifierStatus(rpcUrl: string, hash: string) {
  return await fetchJson(`${httpBase(rpcUrl)}/zk/nullifier/${hash}`)
}

export async function verifyProofRpc(rpcUrl: string, proof: Groth16Proof, publicSignals: string[]) {
  return await rpcPost(rpcUrl, {
    method: "verifyProof",
    params: [{ proof, publicSignals }],
  })
}

export async function probeZkTarget(rpcUrl: string): Promise<ZkTargetProbe> {
  try {
    const ping = await rpcPost(rpcUrl, { method: "ping", params: [] })
    const merkle = await getMerkleRoot(rpcUrl)
    const merkleOk =
      merkle.ok &&
      merkle.status === 200 &&
      typeof merkle.json?.rootHash === "string" &&
      typeof merkle.json?.leafCount === "number"

    return {
      rpcUrl,
      pingOk: ping.ok && ping.json?.result === 200,
      merkleOk,
      error: ping.ok && merkleOk
        ? null
        : JSON.stringify({
          ping: ping.json,
          merkle: merkle.json,
          merkleStatus: merkle.status,
        }),
      merkleRoot: merkleOk
        ? {
          rootHash: merkle.json.rootHash,
          blockNumber: Number(merkle.json.blockNumber ?? 0),
          leafCount: Number(merkle.json.leafCount ?? 0),
        }
        : null,
    }
  } catch (error) {
    return {
      rpcUrl,
      pingOk: false,
      merkleOk: false,
      error: error instanceof Error ? error.message : String(error),
      merkleRoot: null,
    }
  }
}

export async function getHealthyZkTargets(rpcUrls: string[]) {
  const probes = await Promise.all(rpcUrls.map(probeZkTarget))
  return {
    probes,
    healthyRpcUrls: probes.filter(probe => probe.pingOk && probe.merkleOk).map(probe => probe.rpcUrl),
    unhealthyRpcUrls: probes.filter(probe => !(probe.pingOk && probe.merkleOk)).map(probe => probe.rpcUrl),
  }
}

function toBigInt(value: string): bigint {
  return value.startsWith("0x") ? BigInt(value) : BigInt(value)
}

export async function verifyMerkleInclusion(commitment: string, proof: MerkleProofResponse["proof"]): Promise<boolean> {
  const { MerkleTreeManager } = await import("../../../../../src/features/zk/merkle/MerkleTreeManager")
  return MerkleTreeManager.verifyProof(
    {
      siblings: proof.siblings.map(level => level.map(toBigInt)),
      pathIndices: proof.pathIndices,
    },
    toBigInt(commitment),
    toBigInt(proof.root),
  )
}

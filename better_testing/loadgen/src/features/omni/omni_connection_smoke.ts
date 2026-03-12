import { getRunConfig, writeJson } from "../../framework/io"
import { envInt } from "../../framework/common"
import { maybeSilenceConsole } from "../../token_shared"
import { PeerConnection } from "src/libs/omniprotocol/transport/PeerConnection"
import { OmniOpcode } from "src/libs/omniprotocol/protocol/opcodes"
import { decodePeerlistResponse } from "src/libs/omniprotocol/serialization/control"
import { getOmniTargets } from "./shared"

type OmniConnectionProbe = {
  target: string
  ok: boolean
  status: number | null
  peerCount: number
  samplePeers: Array<{ identity: string; url: string; blockNumber: string }>
  latencyMs: number
  error?: string
}

async function probeTarget(target: string, connectTimeoutMs: number, requestTimeoutMs: number): Promise<OmniConnectionProbe> {
  const connection = new PeerConnection(`loadgen:${target}`, target)
  const startedAt = performance.now()
  try {
    await connection.connect({ timeout: connectTimeoutMs })
    const response = await connection.send(OmniOpcode.GET_PEERLIST, Buffer.alloc(0), { timeout: requestTimeoutMs })
    const decoded = decodePeerlistResponse(response)
    return {
      target,
      ok: decoded.status === 200 && decoded.peers.length >= Math.max(1, envInt("OMNI_MIN_PEERS", 1)),
      status: decoded.status,
      peerCount: decoded.peers.length,
      samplePeers: decoded.peers.slice(0, 4).map(peer => ({
        identity: peer.identity,
        url: peer.url,
        blockNumber: peer.blockNumber.toString(),
      })),
      latencyMs: Number((performance.now() - startedAt).toFixed(1)),
    }
  } catch (error) {
    return {
      target,
      ok: false,
      status: null,
      peerCount: 0,
      samplePeers: [],
      latencyMs: Number((performance.now() - startedAt).toFixed(1)),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await connection.close().catch(() => {})
  }
}

export async function runOmniConnectionSmoke() {
  maybeSilenceConsole()

  const targets = getOmniTargets()
  if (targets.length === 0) throw new Error("omni_connection_smoke requires at least one Omni target")

  const connectTimeoutMs = envInt("OMNI_CONNECT_TIMEOUT_MS", 5000)
  const requestTimeoutMs = envInt("OMNI_REQUEST_TIMEOUT_MS", 5000)
  const probes: OmniConnectionProbe[] = []
  for (const target of targets) {
    probes.push(await probeTarget(target, connectTimeoutMs, requestTimeoutMs))
  }

  const ok = probes.every(probe => probe.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "omni_connection_smoke",
    ok,
    targets,
    connectTimeoutMs,
    requestTimeoutMs,
    probes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/omni/omni_connection_smoke.summary.json`, summary)
  console.log(JSON.stringify({ omni_connection_smoke_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("omni_connection_smoke failed: one or more Omni targets did not return a valid peerlist")
  }
}

if (import.meta.main) {
  await runOmniConnectionSmoke()
}


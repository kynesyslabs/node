import { getRunConfig, writeJson } from "../../framework/io"
import { envInt } from "../../framework/common"
import { maybeSilenceConsole } from "../../token_shared"
import { PeerConnection } from "src/libs/omniprotocol/transport/PeerConnection"
import { OmniOpcode } from "src/libs/omniprotocol/protocol/opcodes"
import { decodeNodeCallResponse, encodeNodeCallRequest } from "src/libs/omniprotocol/serialization/control"
import { getOmniTargets } from "./shared"

type OmniRoundtripProbe = {
  target: string
  ok: boolean
  status: number | null
  requireReply: boolean | null
  peerCount: number
  sampleIdentity: string | null
  latencyMs: number
  error?: string
}

async function probeTarget(target: string, connectTimeoutMs: number, requestTimeoutMs: number): Promise<OmniRoundtripProbe> {
  const connection = new PeerConnection(`loadgen:${target}`, target)
  const startedAt = performance.now()
  try {
    await connection.connect({ timeout: connectTimeoutMs })
    const payload = encodeNodeCallRequest({
      method: "nodeCall",
      params: [{
        message: "getPeerlist",
        data: {},
        muid: `omni-roundtrip-${Date.now()}`,
      }],
    })
    const response = await connection.send(OmniOpcode.NODE_CALL, payload, { timeout: requestTimeoutMs })
    const decoded = decodeNodeCallResponse(response)
    const peers = Array.isArray(decoded.value) ? decoded.value : []
    const minPeers = Math.max(1, envInt("OMNI_MIN_PEERS", 1))
    return {
      target,
      ok: decoded.status === 200 && peers.length >= minPeers,
      status: decoded.status,
      requireReply: decoded.requireReply,
      peerCount: peers.length,
      sampleIdentity: typeof peers[0]?.identity === "string" ? peers[0].identity : null,
      latencyMs: Number((performance.now() - startedAt).toFixed(1)),
    }
  } catch (error) {
    return {
      target,
      ok: false,
      status: null,
      requireReply: null,
      peerCount: 0,
      sampleIdentity: null,
      latencyMs: Number((performance.now() - startedAt).toFixed(1)),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await connection.close().catch(() => {})
  }
}

export async function runOmniMessageRoundtrip() {
  maybeSilenceConsole()

  const targets = getOmniTargets()
  if (targets.length === 0) throw new Error("omni_message_roundtrip requires at least one Omni target")

  const connectTimeoutMs = envInt("OMNI_CONNECT_TIMEOUT_MS", 5000)
  const requestTimeoutMs = envInt("OMNI_REQUEST_TIMEOUT_MS", 5000)
  const probes: OmniRoundtripProbe[] = []
  for (const target of targets) {
    probes.push(await probeTarget(target, connectTimeoutMs, requestTimeoutMs))
  }

  const ok = probes.every(probe => probe.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "omni_message_roundtrip",
    ok,
    targets,
    connectTimeoutMs,
    requestTimeoutMs,
    probes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/omni/omni_message_roundtrip.summary.json`, summary)
  console.log(JSON.stringify({ omni_message_roundtrip_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("omni_message_roundtrip failed: one or more Omni NODE_CALL probes did not return the expected peerlist response")
  }
}

if (import.meta.main) {
  await runOmniMessageRoundtrip()
}


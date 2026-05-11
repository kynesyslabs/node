import { getRunConfig, writeJson } from "../../framework/io"
import { envInt } from "../../framework/common"
import { maybeSilenceConsole } from "../../token_shared"
import { PeerConnection } from "src/libs/omniprotocol/transport/PeerConnection"
import { OmniOpcode } from "src/libs/omniprotocol/protocol/opcodes"
import { decodePeerlistResponse } from "src/libs/omniprotocol/serialization/control"
import { getOmniTargets } from "./shared"
import { ConnectionState } from "@/libs/omniprotocol/transport/types"

type ReconnectCycleReport = {
  cycle: number
  beforeClose: {
    state: string
    status: number
    peerCount: number
  }
  afterCloseState: string
  afterReconnect: {
    state: string
    status: number
    peerCount: number
  }
}

type ReconnectProbe = {
  target: string
  ok: boolean
  cycles: ReconnectCycleReport[]
  latencyMs: {
    connectAndFirstRequest: number[]
    reconnectAndSecondRequest: number[]
  }
  error?: string
}

async function sendPeerlist(connection: PeerConnection, requestTimeoutMs: number) {
  const response = await connection.send(OmniOpcode.GET_PEERLIST, Buffer.alloc(0), { timeout: requestTimeoutMs })
  return decodePeerlistResponse(response)
}

function getConnectionStateName(state: number): string {
  return Object.entries(ConnectionState).find(([_, v]) => v === state)?.[0] ?? `UNKNOWN(${state})`
}

async function probeTarget(target: string, connectTimeoutMs: number, requestTimeoutMs: number, cycles: number): Promise<ReconnectProbe> {
  const connection = new PeerConnection(`loadgen:${target}`, target)
  const reports: ReconnectCycleReport[] = []
  const firstLatencies: number[] = []
  const secondLatencies: number[] = []
  try {
    for (let cycle = 1; cycle <= cycles; cycle++) {
      const firstStartedAt = performance.now()
      await connection.connect({ timeout: connectTimeoutMs })
      const first = await sendPeerlist(connection, requestTimeoutMs)
      firstLatencies.push(Number((performance.now() - firstStartedAt).toFixed(1)))

      await connection.close()
      const afterCloseState = connection.getState()

      const secondStartedAt = performance.now()
      await connection.connect({ timeout: connectTimeoutMs })
      const second = await sendPeerlist(connection, requestTimeoutMs)
      secondLatencies.push(Number((performance.now() - secondStartedAt).toFixed(1)))

      reports.push({
        cycle,
        beforeClose: {
          state: "READY",
          status: first.status,
          peerCount: first.peers.length,
        },
        afterCloseState: getConnectionStateName(afterCloseState),
        afterReconnect: {
          state: getConnectionStateName(connection.getState()),
          status: second.status,
          peerCount: second.peers.length,
        },
      })

      await connection.close()
    }

    const minPeers = Math.max(1, envInt("OMNI_MIN_PEERS", 1))
    const ok = reports.every(report =>
      report.beforeClose.status === 200 &&
      report.afterReconnect.status === 200 &&
      report.beforeClose.peerCount >= minPeers &&
      report.afterReconnect.peerCount >= minPeers &&
      report.afterCloseState === "CLOSED" &&
      report.afterReconnect.state === "READY",
    )

    return {
      target,
      ok,
      cycles: reports,
      latencyMs: {
        connectAndFirstRequest: firstLatencies,
        reconnectAndSecondRequest: secondLatencies,
      },
    }
  } catch (error) {
    return {
      target,
      ok: false,
      cycles: reports,
      latencyMs: {
        connectAndFirstRequest: firstLatencies,
        reconnectAndSecondRequest: secondLatencies,
      },
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await connection.close().catch(() => {})
  }
}

export async function runOmniReconnection() {
  maybeSilenceConsole()

  const targets = getOmniTargets()
  if (targets.length === 0) throw new Error("omni_reconnection requires at least one Omni target")

  const connectTimeoutMs = envInt("OMNI_CONNECT_TIMEOUT_MS", 5000)
  const requestTimeoutMs = envInt("OMNI_REQUEST_TIMEOUT_MS", 5000)
  const reconnectCycles = Math.max(1, envInt("OMNI_RECONNECT_CYCLES", 2))

  const probes: ReconnectProbe[] = []
  for (const target of targets) {
    probes.push(await probeTarget(target, connectTimeoutMs, requestTimeoutMs, reconnectCycles))
  }

  const ok = probes.every(probe => probe.ok)
  const run = getRunConfig()
  const summary = {
    scenario: "omni_reconnection",
    ok,
    targets,
    connectTimeoutMs,
    requestTimeoutMs,
    reconnectCycles,
    probes,
    timestamp: new Date().toISOString(),
  }

  writeJson(`${run.runDir}/features/omni/omni_reconnection.summary.json`, summary)
  console.log(JSON.stringify({ omni_reconnection_summary: summary }, null, 2))

  if (!ok) {
    throw new Error("omni_reconnection failed: one or more Omni targets did not reconnect cleanly")
  }
}

if (import.meta.main) {
  await runOmniReconnection()
}

